// Visual worker: turns a video into searchable frame vectors.
//
//   video.mp4 ──ffmpeg fps=0.5──▶ storage/thumbs/<videoId>/00000.jpg, 00001.jpg, ...   (1 frame / 2s)
//             ──CLIP image encoder, 16 at a time──▶ one 512-d vector per frame
//             ──one transaction──▶ DELETE old frames rows, INSERT new ones
//
// The jpgs do two jobs: CLIP reads them, and search results show them as thumbnails.

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { config, sql } from "@app/shared";
import { RawImage } from "@huggingface/transformers";
import { loadClipVision } from "./models";
import type { Job, WorkerDef } from "./runner";
import { toPgVector, toVectors } from "./vectors";

// 1 frame every 2 seconds (ffmpeg's fps=0.5). Enough for search, and a 5-min video = 150 frames.
export const FRAME_INTERVAL_S = 2;
// How many frames go through CLIP in one call. Bigger = faster per frame but more memory.
const BATCH_SIZE = 16;
// How often to tell Kafka we're alive while ffmpeg runs (session timeout is 30s).
const HEARTBEAT_MS = 3000;

// Frame i (0-based) is at i × 2 seconds. Timestamps are always SECONDS, never the raw index.
export function frameTimeS(index: number): number {
  return index * FRAME_INTERVAL_S;
}

// Load CLIP once, then return the worker. index.ts only calls this when the visual worker
// is selected, so `bun run start speech` never loads CLIP. A failed load crashes at startup
// (not on the first video, which would wrongly mark that video as failed).
export async function createVisualWorker(): Promise<WorkerDef> {
  const clip = await loadClipVision();
  console.log("[visual] CLIP loaded");

  async function process(job: Job): Promise<void> {
    const { videoId, filePath, heartbeat } = job;
    // Relative dir is what goes in the DB (like videos.file_path); absolute is for the disk.
    const thumbsRel = path.join("thumbs", videoId);
    const thumbsAbs = path.join(config.storageDir, thumbsRel);

    // 1. Extract frames. Delete the folder first so a re-run (same message delivered
    //    again) starts clean instead of mixing old and new jpgs.
    let t = performance.now();
    await rm(thumbsAbs, { recursive: true, force: true });
    await mkdir(thumbsAbs, { recursive: true });
    await extractFrames(filePath, thumbsAbs, heartbeat);
    // ffmpeg numbers the files 00000.jpg, 00001.jpg, ... Sort so frame i is at position i.
    const files = (await readdir(thumbsAbs)).filter((f) => f.endsWith(".jpg")).sort();
    if (files.length === 0) throw new Error("ffmpeg extracted no frames");
    const extractS = seconds(t);

    // 2. Embed in batches of 16: one model call per batch (a real batch, not Promise.all
    //    over single images). Heartbeat after each batch so Kafka knows we're alive.
    t = performance.now();
    const vectors: Float32Array[] = [];
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      // Reading the files in parallel is fine: that's disk I/O, not model work.
      const images = await Promise.all(batch.map((f) => RawImage.read(path.join(thumbsAbs, f))));
      const inputs = await clip.processor(images); // → pixel_values [n, 3, 224, 224]
      const { image_embeds } = await clip.model(inputs); // → Tensor [n, 512]
      vectors.push(...toVectors(image_embeds)); // split into n vectors, L2-normalized
      await heartbeat();
    }
    const embedS = seconds(t);

    // 3. Save. Delete + insert in ONE transaction: a search running at the same time sees
    //    either all the old rows or all the new ones, never a half-written video.
    t = performance.now();
    const rows = files.map((file, i) => ({
      video_id: videoId,
      // Index comes from the file name ("00050.jpg" → 50 → 100s), not the loop counter,
      // so the timestamp is tied to the exact jpg it describes.
      ts_s: frameTimeS(Number.parseInt(file, 10)),
      thumb_path: path.join(thumbsRel, file),
      embedding: toPgVector(vectors[i]!),
    }));
    await sql.begin(async (tx) => {
      await tx`DELETE FROM frames WHERE video_id = ${videoId}`;
      // tx(rows) expands an array of objects into (col1, col2, ...) VALUES (...), (...), ...
      await tx`INSERT INTO frames ${tx(rows)}`;
    });
    const saveS = seconds(t);

    // Times go into the Metrics table in progress.md. (runner.ts logs the total + sets visual_done.)
    console.log(
      `[visual] ${videoId}: ${rows.length} frames | extract ${extractS}s | embed ${embedS}s | save ${saveS}s`,
    );
  }

  return { name: "visual", process };
}

// Write one jpg every 2 seconds into `outDir`.
// - `-an`: ignore the audio stream (not needed here, saves decoding work)
// - `fps=0.5`: keep 1 frame per 2s. Output frame i is the input frame nearest to i × 2s.
// - `scale=...increase`: shrink so the SHORTER side is 256px, keeping the aspect ratio
//   (1920x1080 → 455x256). Small thumbnails, but still ≥ 224 for CLIP's 224x224 crop.
// - `-q:v 4`: jpg quality (2 = best, 31 = worst); ~15 KB per frame
// - `-start_number 0`: first file is 00000.jpg, so file number = frame index
async function extractFrames(input: string, outDir: string, heartbeat: () => Promise<void>): Promise<void> {
  const proc = Bun.spawn(
    [
      "ffmpeg", "-nostdin", "-v", "error", "-y",
      "-i", input,
      "-an",
      "-vf", `fps=1/${FRAME_INTERVAL_S},scale=w=256:h=256:force_original_aspect_ratio=increase`,
      "-q:v", "4",
      "-start_number", "0",
      path.join(outDir, "%05d.jpg"),
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  // Read stderr while ffmpeg runs, so a full pipe can't make it hang.
  const stderr = new Response(proc.stderr).text();

  // Decoding a long video can take minutes, longer than Kafka's session timeout.
  // So instead of just `await proc.exited`, wake up every 3s to send a heartbeat.
  let finished = false;
  const exited = proc.exited.finally(() => {
    finished = true;
  });
  try {
    while (!finished) {
      await heartbeat();
      await Promise.race([exited, Bun.sleep(HEARTBEAT_MS)]); // whichever comes first
    }
  } finally {
    // If heartbeat() threw (e.g. a Kafka rebalance), don't leave ffmpeg running.
    // After a normal exit this does nothing.
    proc.kill();
  }

  if ((await exited) !== 0) {
    throw new Error(`ffmpeg frame extraction failed: ${(await stderr).trim()}`);
  }
}

// Seconds since `start`, rounded to 0.1, for the timing log.
function seconds(start: number): string {
  return ((performance.now() - start) / 1000).toFixed(1);
}
