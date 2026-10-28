// Loads the ML models. Each loader is called ONCE per process, at startup, and the loaded
// model is reused for every video / every search (loading takes seconds; running is fast).
//
// Lives in packages/shared because two apps need the SAME models:
//   workers (Days 5–7): CLIP image side, Whisper, bge, CLAP audio side → store vectors
//   api     (Day 8):    CLIP text side, bge, CLAP text side             → embed the search query
// Query and stored vectors must come from the same model id, or they live in different
// spaces and the similarity scores mean nothing. One file with one config makes that hard to break.
//
// Imported as "@app/shared/models" (its own entry, not the main "@app/shared"), so scripts
// like migrate.ts that only need the DB don't load the heavy transformers.js library.

import path from "node:path";
import {
  AutoProcessor,
  AutoTokenizer,
  CLIPTextModelWithProjection,
  CLIPVisionModelWithProjection,
  ClapAudioModelWithProjection,
  ClapTextModelWithProjection,
  env,
  pipeline,
} from "@huggingface/transformers";
import { config } from "./config";

// Keep downloaded models in storage/models instead of deep inside node_modules,
// so `bun install` never wipes them and they stay out of git (storage/ is ignored).
env.cacheDir = path.join(config.storageDir, "models");

// Full-precision weights (the CPU default, written out so it's visible). See Decisions log.
const DTYPE = "fp32";

// ---------- CLIP: images (frames) and text (queries) in one 512-d space ----------

// CLIP's IMAGE side, for frames (visual worker).
// - processor: resizes the shorter side to 224, center-crops 224x224, normalizes pixels
// - model: "WithProjection" = returns `image_embeds` from the projection head (512-d),
//   the layer that is shared with the text side
export async function loadClipVision() {
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(config.models.clip),
    CLIPVisionModelWithProjection.from_pretrained(config.models.clip, { dtype: DTYPE }),
  ]);
  return { processor, model };
}

// CLIP's TEXT side, for search queries (API). Same model id as loadClipVision(), so a query
// vector can be compared with frame vectors.
// - tokenizer: text → token ids (CLIP reads at most 77 tokens; longer text is cut)
// - model: "WithProjection" = returns `text_embeds` from the projection head (512-d)
export async function loadClipText() {
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(config.models.clip),
    CLIPTextModelWithProjection.from_pretrained(config.models.clip, { dtype: DTYPE }),
  ]);
  return { tokenizer, model };
}

// ---------- Whisper: speech → text with timestamps ----------

// A "pipeline" bundles the three parts: feature extractor (16 kHz samples → log-mel
// spectrogram), the model, and decoding (tokens → text + timestamps), so we call it like
// one function. Speech worker only.
export function loadWhisper() {
  return pipeline("automatic-speech-recognition", config.models.whisper, { dtype: DTYPE });
}

// ---------- bge-small: text → 384-d vector ----------

// Used on transcript windows (speech worker) AND on the search query (API): same model,
// so both land in the same space.
// The pipeline = tokenizer (text → token ids, cut at 512 tokens) + model (→ one vector per token).
export function loadTextEmbedder() {
  return pipeline("feature-extraction", config.models.textEmbed, { dtype: DTYPE });
}

// ---------- CLAP: audio (10s windows) and text (queries) in one 512-d space ----------

// CLAP's AUDIO side, for 10s sound windows (sound worker).
// - processor: 48 kHz samples → log-mel spectrogram (64 frequency bands × ~1000 time steps
//   for 10s). It takes ONE clip per call. Shorter than 10s → repeated to fill 10s; LONGER →
//   a random 10s crop (config `truncation: "rand_trunc"`), which is why we cut windows ourselves.
// - model: "WithProjection" = returns `audio_embeds` from the projection head (512-d),
//   the layer that is shared with the text side
export async function loadClapAudio() {
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(config.models.clap),
    ClapAudioModelWithProjection.from_pretrained(config.models.clap, { dtype: DTYPE }),
  ]);
  return { processor, model };
}

// CLAP's TEXT side, for search queries (API). Same model id as loadClapAudio(), so a query
// like "dog barking" can be compared with sound-window vectors.
// - tokenizer: text → token ids (CLAP's text side is a RoBERTa model)
// - model: "WithProjection" = returns `text_embeds` from the projection head (512-d)
export async function loadClapText() {
  const [tokenizer, model] = await Promise.all([
    AutoTokenizer.from_pretrained(config.models.clap),
    ClapTextModelWithProjection.from_pretrained(config.models.clap, { dtype: DTYPE }),
  ]);
  return { tokenizer, model };
}
