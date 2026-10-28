// Sound worker: turns what is HEARD in a video (music, applause, a dog, an engine) into
// searchable sound vectors. Speech content is Whisper's job; CLAP is weak at words.
//
//   video.mp4 ──ffmpeg──▶ 48 kHz mono float samples
//             ──soundWindows()──▶ back-to-back 10s windows: [0,10) [10,20) ... (soundWindows.ts)
//             ──CLAP processor, one window at a time──▶ one mel spectrogram per window
//             ──stack 16 + CLAP audio encoder, ONE call──▶ one 512-d vector per window
//             ──one transaction──▶ DELETE old sounds rows, INSERT new ones

import { sql } from "@app/shared";
import { cat, type Tensor } from "@huggingface/transformers";
import { hasAudioStream, readAudio } from "./audio";
import { loadClapAudio } from "./models";
import type { Job, WorkerDef } from "./runner";
import { soundWindows } from "./soundWindows";
import { toPgVector, toVectors } from "./vectors";

// CLAP was trained on 48 kHz audio (NOT 16 kHz like Whisper). At 16 kHz it would "hear"
// everything 3× too fast and give garbage vectors without any error.
const SAMPLE_RATE = 48_000;
// How many 10s windows go through CLAP in one call (= 160s of audio per call).
const BATCH_SIZE = 16;

// Load CLAP once, then return the worker (same pattern as createVisualWorker).
export async function createSoundWorker(): Promise<WorkerDef> {
  const clap = await loadClapAudio();
  console.log("[sound] CLAP loaded");

  async function process(job: Job): Promise<void> {
    const { videoId, filePath, heartbeat } = job;

    // 1. Audio. No audio track = nothing to hear: a correct "0 sounds", like the speech worker.
    //    Size: 4 bytes × 48000/s ≈ 192 KB per second → a 5-min video ≈ 58 MB in memory.
    let t = performance.now();
    const hasAudio = await hasAudioStream(videoId);
    const audio = hasAudio ? await readAudio(filePath, SAMPLE_RATE, heartbeat) : new Float32Array(0);
    const audioS = seconds(t);

    // 2. Cut into 10s windows and embed them, 16 per model call.
    t = performance.now();
    const windows = soundWindows(audio.length, SAMPLE_RATE);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < windows.length; i += BATCH_SIZE) {
      const batch = windows.slice(i, i + BATCH_SIZE);

      // The processor only takes one clip per call, so we turn each window into its mel
      // spectrogram first. That's plain math in JS (no model), and every window gives the same
      // shape [1, 1, 1001, 64] because short ones are padded to 10s.
      // subarray() is a view into `audio`, not a copy, so this costs no extra memory.
      const features: Tensor[] = [];
      for (const w of batch) {
        // The processor's type is generic (`any`), so we name what it returns.
        const { input_features }: { input_features: Tensor } = await clap.processor(
          audio.subarray(w.from, w.to),
        );
        features.push(input_features);
      }

      // cat() stacks them along the first axis → [n, 1, 1001, 64], so the model runs once
      // for the whole batch (real batching, not n separate calls). → audio_embeds [n, 512];
      // toVectors splits it into n vectors and L2-normalizes each.
      const { audio_embeds } = await clap.model({ input_features: cat(features, 0) });
      vectors.push(...toVectors(audio_embeds));
      await heartbeat(); // one batch is a few seconds; this keeps Kafka informed between batches
    }
    const embedS = seconds(t);

    // 3. Save. Same as frames and segments: DELETE + INSERT in one transaction, so a re-run
    //    replaces the rows and search never sees half a video.
    t = performance.now();
    const rows = windows.map((w, i) => ({
      video_id: videoId,
      start_s: w.start_s,
      end_s: w.end_s,
      embedding: toPgVector(vectors[i]!),
    }));
    await sql.begin(async (tx) => {
      await tx`DELETE FROM sounds WHERE video_id = ${videoId}`;
      // An INSERT needs at least one row, so skip it for a video without audio.
      if (rows.length > 0) await tx`INSERT INTO sounds ${tx(rows)}`;
    });
    const saveS = seconds(t);

    const audioLength = (audio.length / SAMPLE_RATE).toFixed(1);
    console.log(
      `[sound] ${videoId}: ${audioLength}s audio → ${rows.length} sound windows` +
        ` | audio ${audioS}s | embed ${embedS}s | save ${saveS}s`,
    );
  }

  return { name: "sound", process };
}

// Seconds since `start`, rounded to 0.1, for the timing log.
function seconds(start: number): string {
  return ((performance.now() - start) / 1000).toFixed(1);
}
