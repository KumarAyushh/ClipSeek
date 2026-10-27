// Day 2 model spike: prove all four models run under Bun before building on them.
// Run from the repo root:  bun run spike
//
// For each model it loads it once, runs one small input, and prints the vector size
// and a similarity check. Nothing is written to the database.
//
// Test files (downloaded into storage/spike/, which is gitignored):
//   cats.jpg         photo of two cats on a couch        -> CLIP image encoder
//   ted_60.wav       60s TED talk (we use the first 30s) -> Whisper
//   dog_barking.wav  ~5s of a dog barking                -> CLAP audio encoder
//
// The first run downloads ~1.5 GB of models into storage/models/. Later runs load from disk.

import path from "node:path";
import { config } from "@app/shared";
import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  ClapAudioModelWithProjection,
  ClapTextModelWithProjection,
  RawImage,
  Tensor,
  env,
  pipeline,
} from "@huggingface/transformers";

// Keep downloaded models in storage/models instead of deep inside node_modules,
// so `bun install` never wipes them and they stay out of git (storage/ is ignored).
env.cacheDir = path.join(config.storageDir, "models");

const SPIKE_DIR = path.join(config.storageDir, "spike");

// ---------- small helpers ----------

// Decode any audio file into mono float samples at the given sample rate.
// ffmpeg does the resampling (-ar), downmix to mono (-ac 1) and outputs raw
// 32-bit floats (-f f32le), so there is no WAV header to parse.
// Arguments are an array, never a shell string (no quoting bugs, no injection).
async function readAudio(file: string, sampleRate: number, maxSeconds: number): Promise<Float32Array> {
  const proc = Bun.spawn(
    ["ffmpeg", "-v", "error", "-i", file, "-t", String(maxSeconds), "-ac", "1", "-ar", String(sampleRate), "-f", "f32le", "pipe:1"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const bytes = await new Response(proc.stdout).arrayBuffer();
  if ((await proc.exited) !== 0) {
    throw new Error(`ffmpeg failed on ${file}: ${await new Response(proc.stderr).text()}`);
  }
  // Every 4 bytes = one float sample between -1 and 1.
  return new Float32Array(bytes);
}

// Scale a vector to length 1 (L2 normalization). After this, cosine similarity = dot product.
function l2normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const len = Math.sqrt(sumSq) || 1; // avoid dividing by 0 for an all-zero vector
  return v.map((x) => x / len);
}

// Dot product. Only equals cosine similarity when both vectors are normalized.
function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// A model returns one Tensor of shape [batchSize, dim]. Split it into one
// normalized Float32Array per input, so row i belongs to input i.
function rows(t: Tensor): Float32Array[] {
  const [n, dim] = t.dims as [number, number];
  const data = t.data as Float32Array;
  return Array.from({ length: n }, (_, i) => l2normalize(data.slice(i * dim, (i + 1) * dim)));
}

// Time a step and print how long it took (loading is slow the first time because of downloads).
async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  console.log(`  ${label}: ${((performance.now() - start) / 1000).toFixed(1)}s`);
  return result;
}

// Print each text with its similarity to the target, best match first.
function printScores(texts: string[], scores: number[]) {
  texts
    .map((text, i) => ({ text, score: scores[i]! }))
    .sort((a, b) => b.score - a.score)
    .forEach(({ text, score }) => console.log(`    ${score.toFixed(3)}  "${text}"`));
}

// `dtype: "fp32"` = full-precision weights (the CPU default, written out so it's visible).
// Smaller "q8" versions exist; quality vs speed is a later decision.
const DTYPE = "fp32";

// ---------- 1. CLIP: image and text in one 512-d space ----------
async function spikeClip() {
  console.log(`\n[1/4] CLIP (${config.models.clip})`);
  // Two halves of CLIP: the vision side for frames, the text side for search queries.
  // Both "WithProjection" classes return vectors from the projection head, which is
  // the layer that puts images and text into the same 512-d space.
  const [processor, vision, tokenizer, text] = await timed("load", () =>
    Promise.all([
      AutoProcessor.from_pretrained(config.models.clip),
      CLIPVisionModelWithProjection.from_pretrained(config.models.clip, { dtype: DTYPE }),
      AutoTokenizer.from_pretrained(config.models.clip),
      CLIPTextModelWithProjection.from_pretrained(config.models.clip, { dtype: DTYPE }),
    ]),
  );

  // Image -> resized/cropped to 224x224 + normalized pixels by the processor -> vision model.
  const image = await RawImage.read(path.join(SPIKE_DIR, "cats.jpg"));
  const { image_embeds } = await timed("embed image", async () => vision(await processor(image)));
  const [imageVec] = rows(image_embeds);

  // All captions go through the text model in ONE call (a real batch, not Promise.all).
  const captions = ["a photo of two cats", "a photo of a dog", "a red car on a road", "a man fixing a bike"];
  const { text_embeds } = await timed("embed 4 texts (1 batch)", async () =>
    text(tokenizer(captions, { padding: true, truncation: true })),
  );
  const textVecs = rows(text_embeds);

  console.log(`  image vector: ${imageVec!.length}-d, text vector: ${textVecs[0]!.length}-d`);
  console.log("  similarity of cats.jpg to each caption:");
  printScores(captions, textVecs.map((t) => dot(imageVec!, t)));
}

// ---------- 2. Whisper: speech -> text with timestamps ----------
async function spikeWhisper() {
  console.log(`\n[2/4] Whisper (${config.models.whisper})`);
  // The pipeline bundles feature extractor + model + decoding into one function.
  const transcriber = await timed("load", () =>
    pipeline("automatic-speech-recognition", config.models.whisper, { dtype: DTYPE }),
  );

  // Whisper expects 16 kHz mono. 30s = exactly one Whisper window, so no chunking needed yet.
  const audio = await readAudio(path.join(SPIKE_DIR, "ted_60.wav"), 16_000, 30);
  console.log(`  audio: ${audio.length} samples = ${(audio.length / 16_000).toFixed(1)}s at 16 kHz`);

  // return_timestamps: true -> output.chunks = [{ text, timestamp: [start_s, end_s] }, ...]
  const out = await timed("transcribe 30s", () => transcriber(audio, { return_timestamps: true }));
  // The pipeline can return one result or a list (for a list of inputs). We passed one input.
  const result = Array.isArray(out) ? out[0]! : out;
  console.log(`  ${result.chunks?.length ?? 0} timestamped chunks:`);
  for (const chunk of result.chunks ?? []) {
    const [start, end] = chunk.timestamp;
    console.log(`    [${start.toFixed(1)}s -> ${end?.toFixed(1) ?? "?"}s] ${chunk.text.trim()}`);
  }
}

// ---------- 3. bge-small: text -> 384-d vector ----------
async function spikeBge() {
  console.log(`\n[3/4] bge-small (${config.models.textEmbed})`);
  const embed = await timed("load", () => pipeline("feature-extraction", config.models.textEmbed, { dtype: DTYPE }));

  // bge was trained to use the [CLS] token's vector as the sentence vector -> pooling "cls".
  // normalize: true makes each vector length 1, so dot product = cosine similarity.
  const query = "how do I repair a flat bicycle tyre";
  const passages = [
    "First take the wheel off and find the puncture in the inner tube.",
    "Cats sleep for most of the day.",
    "The stock market fell sharply this morning.",
  ];
  const tensor = await timed("embed 4 sentences (1 batch)", () =>
    embed([query, ...passages], { pooling: "cls", normalize: true }),
  );
  const [queryVec, ...passageVecs] = rows(tensor);

  console.log(`  vector: ${queryVec!.length}-d`);
  console.log(`  similarity of "${query}" to each passage:`);
  printScores(passages, passageVecs.map((p) => dot(queryVec!, p)));
}

// ---------- 4. CLAP: audio and text in one 512-d space ----------
async function spikeClap() {
  console.log(`\n[4/4] CLAP (${config.models.clap})`);
  const [processor, audioModel, tokenizer, textModel] = await timed("load", () =>
    Promise.all([
      AutoProcessor.from_pretrained(config.models.clap),
      ClapAudioModelWithProjection.from_pretrained(config.models.clap, { dtype: DTYPE }),
      AutoTokenizer.from_pretrained(config.models.clap),
      ClapTextModelWithProjection.from_pretrained(config.models.clap, { dtype: DTYPE }),
    ]),
  );

  // CLAP expects 48 kHz (not 16 kHz like Whisper). Max 10s = one CLAP window.
  // The clip is ~5s; the processor pads short audio up to 10s by repeating it.
  const audio = await readAudio(path.join(SPIKE_DIR, "dog_barking.wav"), 48_000, 10);
  console.log(`  audio: ${audio.length} samples = ${(audio.length / 48_000).toFixed(1)}s at 48 kHz`);

  // Processor turns raw samples into a mel spectrogram (a picture of sound) for the audio model.
  const { audio_embeds } = await timed("embed audio", async () => audioModel(await processor(audio)));
  const [audioVec] = rows(audio_embeds);

  const labels = ["dog barking", "people talking", "music playing", "car engine"];
  const { text_embeds } = await timed("embed 4 texts (1 batch)", async () =>
    textModel(tokenizer(labels, { padding: true, truncation: true })),
  );
  const textVecs = rows(text_embeds);

  console.log(`  audio vector: ${audioVec!.length}-d, text vector: ${textVecs[0]!.length}-d`);
  console.log("  similarity of dog_barking.wav to each label:");
  printScores(labels, textVecs.map((t) => dot(audioVec!, t)));
}

// Run one model at a time so the logs stay readable and memory stays low.
// No try/catch: if a model fails, the script crashes with the real error (no silent failures).
await spikeClip();
await spikeWhisper();
await spikeBge();
await spikeClap();
console.log("\nAll four models ran under Bun.");
