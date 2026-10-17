#!/usr/bin/env node
// ElevenLabs voiceover for /brag-voice. Node 22+, native fetch, no npm deps.
//
//   node elevenlabs-tts.mjs <text | path/to/script.txt> --output <file.wav> [--creative]
//
// Env:
//   ELEVENLABS_API_KEY   required (without it: one-line warning, Kokoro fallback)
//   ELEVENLABS_VOICE_ID  required when the API key is set
//   ELEVENLABS_MODEL_ID  optional, default eleven_v3 (v3+ interprets [audio tags])
//
// The script text may contain ElevenLabs audio tags like [excited] or [short pause].
// They are sent as-is to ElevenLabs and stripped before the Kokoro fallback,
// which would otherwise read them aloud.
//
// Requires ffmpeg on PATH (chunk concat + WAV conversion).

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const API = "https://api.elevenlabs.io/v1/text-to-speech";

// Per-request character limits from the ElevenLabs models page
// (eleven_v3: 5,000; eleven_v4: 10,000). Unknown models use the safe default.
const CHAR_LIMITS = { eleven_v3: 5000, eleven_v4: 10000 };
const DEFAULT_CHAR_LIMIT = 5000;
const CHUNK_MARGIN = 200;

// Voice settings, checked against the ElevenLabs API reference and model docs:
// - stability: 0..1. eleven_v3 only accepts the three preset values 0.0 (Creative),
//   0.5 (Natural), 1.0 (Robust). Lower = wider emotional range and more
//   responsive audio tags; Robust largely ignores tags. Natural is our default,
//   Creative (--creative) for high-energy tones; Creative can hallucinate more.
// - similarity_boost: 0..1 (API default 0.75). High keeps the cloned timbre.
// - style: 0..1 (API default 0). Style exaggeration; adds a bit of latency.
// - speed: 0.7..1.2 (API default 1.0).
// - use_speaker_boost: boolean (API default true).
// eleven_v4 / eleven_v4_turbo only use stability + similarity ("Style and Speed
// sliders are not available in Eleven v4"), so style/speed are omitted there.
function voiceSettings(modelId, creative) {
  const settings = {
    stability: creative ? 0.0 : 0.5,
    similarity_boost: 0.9,
    use_speaker_boost: true,
  };
  if (!modelId.startsWith("eleven_v4")) {
    settings.style = 0.7;
    settings.speed = 1.05;
  }
  return settings;
}

function die(message) {
  console.error(`elevenlabs-tts: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = { input: null, output: null, creative: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") args.output = argv[++i];
    else if (arg === "--creative") args.creative = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node elevenlabs-tts.mjs <text | script.txt> --output <file.wav> [--creative]");
      process.exit(0);
    } else if (args.input === null) args.input = arg;
    else die(`unexpected argument: ${arg}`);
  }
  if (!args.input) die("missing narration text or script path.");
  if (!args.output) die("missing --output <file.wav>.");
  return args;
}

function stripTags(text) {
  return text
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.…])/g, "$1")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

// Split on paragraphs first; fall back to sentences for an oversized paragraph.
function chunkText(text, limit) {
  const max = limit - CHUNK_MARGIN;
  if (text.length <= max) return [text];

  const pieces = [];
  for (const paragraph of text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
    if (paragraph.length <= max) {
      pieces.push(paragraph);
      continue;
    }
    for (const sentence of paragraph.match(/[^.!?…]+[.!?…]*\s*/g) ?? [paragraph]) {
      if (sentence.length > max) die(`a single sentence exceeds ${max} characters; shorten the script.`);
      pieces.push(sentence.trim());
    }
  }

  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    const joined = current ? `${current}\n\n${piece}` : piece;
    if (joined.length > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  if (result.error) die(`could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) die(`${cmd} failed:\n${result.stderr.trim().split("\n").slice(-5).join("\n")}`);
}

async function synthesize({ text, apiKey, voiceId, modelId, creative, previousText, nextText }) {
  const body = { text, model_id: modelId, voice_settings: voiceSettings(modelId, creative) };
  if (previousText) body.previous_text = previousText;
  if (nextText) body.next_text = nextText;

  let response;
  try {
    response = await fetch(`${API}/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    die(`network error calling ElevenLabs: ${error.message}`);
  }

  if (!response.ok) {
    let detail = await response.text();
    try {
      const parsed = JSON.parse(detail);
      detail = parsed.detail?.message ?? parsed.detail?.status ?? JSON.stringify(parsed.detail ?? parsed);
    } catch {}
    const hints = {
      401: "check ELEVENLABS_API_KEY.",
      404: "check ELEVENLABS_VOICE_ID (the voice must exist in this account).",
      422: "request rejected; check ELEVENLABS_MODEL_ID and the voice settings for that model.",
      429: "rate limit or quota reached.",
    };
    die(`ElevenLabs API error ${response.status}: ${detail}${hints[response.status] ? ` (${hints[response.status]})` : ""}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function kokoroFallback(text, output) {
  console.warn("elevenlabs-tts: ELEVENLABS_API_KEY not set, falling back to Kokoro (tags stripped).");
  const plain = stripTags(text);
  const work = mkdtempSync(path.join(tmpdir(), "brag-tts-"));
  try {
    const scriptPath = path.join(work, "voiceover.txt");
    writeFileSync(scriptPath, plain);
    run("npx", ["hyperframes", "tts", scriptPath, "--voice", "af_heart", "--output", output]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = (existsSync(args.input) ? readFileSync(args.input, "utf8") : args.input).trim();
  if (!text) die("narration text is empty.");

  const output = path.resolve(args.output);
  mkdirSync(path.dirname(output), { recursive: true });

  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) return kokoroFallback(text, output);

  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim();
  if (!voiceId) die("ELEVENLABS_VOICE_ID is not set (copy it from your cloned voice in the ElevenLabs Voices page).");
  const modelId = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_v3";

  const chunks = chunkText(text, CHAR_LIMITS[modelId] ?? DEFAULT_CHAR_LIMIT);
  const work = mkdtempSync(path.join(tmpdir(), "brag-tts-"));
  try {
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      console.log(`elevenlabs-tts: ${modelId}, chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
      const audio = await synthesize({
        text: chunks[i],
        apiKey,
        voiceId,
        modelId,
        creative: args.creative,
        previousText: chunks[i - 1],
        nextText: chunks[i + 1],
      });
      const part = path.join(work, `part-${i}.mp3`);
      writeFileSync(part, audio);
      parts.push(part);
    }

    const inputs = parts.flatMap((p) => ["-i", p]);
    const filter = `${parts.map((_, i) => `[${i}:a]`).join("")}concat=n=${parts.length}:v=0:a=1[a]`;
    run("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[a]",
      "-ar", "44100", "-c:a", "pcm_s16le", output]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`elevenlabs-tts: wrote ${output}`);
}

await main();
