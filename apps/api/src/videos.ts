// Routes under /videos: upload, list, details and streaming.
//
// Upload flow (POST /videos):
//   browser/curl ──multipart──▶ multer writes storage/uploads/<random>   (streamed to disk, not RAM)
//                               ffmpeg faststart ──▶ storage/videos/<id>.mp4
//                               ffprobe JSON ──▶ videos.metadata (jsonb) + duration_s
//                               temp upload deleted, row inserted with status 'processing'
//                               publish `video.uploaded` to Kafka → workers take it from there
// The API answers right after publishing; it never waits for the workers.

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import { config, sql, type Video } from "@app/shared";
import { publishVideoUploaded } from "./kafka";
import { faststart, probe, type ProbeResult } from "./media";

// storage/uploads = raw files while they're being prepared (deleted right after)
// storage/videos  = the final faststart mp4s that get streamed and processed
const UPLOADS_DIR = path.join(config.storageDir, "uploads");
const VIDEOS_DIR = path.join(config.storageDir, "videos");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// multer parses multipart/form-data. With `dest` it uses disk storage: the file is
// streamed straight to a random name in UPLOADS_DIR, so a 1 GB video never sits in memory.
// Limits: one file, at most 2 GB (bigger → MulterError LIMIT_FILE_SIZE → 413 in index.ts).
const upload = multer({
  dest: UPLOADS_DIR,
  limits: { files: 1, fileSize: 2 * 1024 ** 3 },
});

// Postgres throws on an id that isn't a valid uuid. Checking first turns
// GET /videos/abc into a clean 404 instead of a 500.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findVideo(id: string): Promise<Video | undefined> {
  if (!UUID_RE.test(id)) return undefined;
  const rows: Video[] = await sql`SELECT * FROM videos WHERE id = ${id}`;
  return rows[0];
}

export const videosRouter = Router();

// POST /videos — form field "video" = the file, optional field "title".
//   curl -F title="My clip" -F video=@clip.mp4 localhost:3000/videos
// Note: multer only sees text fields sent BEFORE the file, so put -F title first.
videosRouter.post("/", upload.single("video"), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'Send the video as multipart/form-data in a field named "video"' });
    return;
  }

  // We pick the id here (instead of letting Postgres default it) because the
  // file name on disk needs it before the row exists.
  const id = crypto.randomUUID();
  // Stored relative to STORAGE_DIR so the DB doesn't depend on where the repo lives.
  const filePath = `videos/${id}.mp4`;
  const absPath = path.join(config.storageDir, filePath);

  // Use the given title, or fall back to the original file name without its extension.
  const rawTitle: unknown = req.body?.title;
  const title =
    typeof rawTitle === "string" && rawTitle.trim() ? rawTitle.trim() : path.parse(file.originalname).name;

  let metadata: ProbeResult;
  try {
    await faststart(file.path, absPath);
    // Probe the file we keep (not the raw upload), so metadata describes what we stream.
    metadata = await probe(absPath);
    if (!metadata.streams.some((s) => s.codec_type === "video")) {
      throw new Error("file has no video stream");
    }
  } catch (err) {
    // ffmpeg/ffprobe rejected the file → it's the client's file that's bad: 400, not 500.
    await fs.promises.rm(absPath, { force: true });
    res.status(400).json({ error: `Not a usable video: ${err instanceof Error ? err.message : String(err)}` });
    return;
  } finally {
    // The raw upload is never needed again, whether preparing it worked or not.
    await fs.promises.rm(file.path, { force: true });
  }

  // ffprobe reports duration as a string like "12.345000". Some formats have none → null.
  const duration = Number.parseFloat(metadata.format.duration ?? "");
  const durationS = Number.isFinite(duration) ? duration : null;

  let video: Video | undefined;
  try {
    // Pass the object itself: Bun's client turns it into JSON once. Passing
    // JSON.stringify(metadata) would encode it twice and store one big jsonb *string*,
    // so queries like metadata->'format'->>'bit_rate' would find nothing.
    const rows: Video[] = await sql`
      INSERT INTO videos (id, title, file_path, duration_s, metadata)
      VALUES (${id}, ${title}, ${filePath}, ${durationS}, ${metadata}::jsonb)
      RETURNING *`;
    video = rows[0];
  } catch (err) {
    // No row points at the file, so nothing would ever clean it up. Remove it, then let
    // Express's error handler answer 500.
    await fs.promises.rm(absPath, { force: true });
    throw err;
  }

  // Publish AFTER the insert: when a worker gets the message, the row is already there.
  try {
    await publishVideoUploaded({ videoId: id, filePath });
  } catch (err) {
    // Kafka didn't take the message, so no worker will ever process this video and it
    // would sit in 'processing' forever. Undo the upload (row + file) and answer 500;
    // the client can simply upload again.
    await sql`DELETE FROM videos WHERE id = ${id}`;
    await fs.promises.rm(absPath, { force: true });
    throw err;
  }

  // 201 Created = a new resource exists now. Status is 'processing' until all three workers finish.
  res.status(201).json(video);
});

// GET /videos — newest first. Leaves out `metadata` (can be large) and `file_path`
// (internal); ask GET /videos/:id for the full row.
videosRouter.get("/", async (_req, res) => {
  const videos = await sql`
    SELECT id, title, duration_s, status, visual_done, speech_done, sound_done, error, created_at
    FROM videos
    ORDER BY created_at DESC`;
  res.json(videos);
});

// GET /videos/:id — one video with its status flags and full ffprobe metadata.
videosRouter.get("/:id", async (req, res) => {
  const video = await findVideo(req.params.id);
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.json(video);
});

// DELETE /videos/:id — remove a video and everything made from it.
// Allowed in ANY status: a video stuck in 'processing' is exactly what you'd want to clear out.
//
// - The row goes first. ON DELETE CASCADE removes its frames, segments and sounds with it, so the
//   video leaves search in one step. If removing a file then fails, the worst case is an unused
//   file on disk, never a search result pointing at a missing video.
// - `force: true` = no error if the file is already gone.
// - A message still waiting in Kafka is harmless: the worker finds no file or row, fails that job,
//   and marking it failed updates 0 rows. A worker in the middle of this video can leave its
//   thumbnails folder behind (it writes after we delete); that's only wasted disk space.
videosRouter.delete("/:id", async (req, res) => {
  const video = await findVideo(req.params.id);
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  await sql`DELETE FROM videos WHERE id = ${video.id}`;
  await fs.promises.rm(path.join(config.storageDir, video.file_path), { force: true });
  await fs.promises.rm(path.join(config.storageDir, "thumbs", video.id), { recursive: true, force: true });
  // 204 No Content = it worked, and there's nothing to send back.
  res.status(204).end();
});

// GET /videos/:id/stream — the mp4 itself, for a <video src="..."> tag.
// res.sendFile handles HTTP range requests for us: when the player seeks, the browser
// sends `Range: bytes=N-` and gets `206 Partial Content` with only that slice.
// `root` resolves the relative file_path and refuses paths that try to escape it ("..").
videosRouter.get("/:id/stream", async (req, res) => {
  const video = await findVideo(req.params.id);
  if (!video) {
    res.status(404).json({ error: "Video not found" });
    return;
  }
  res.sendFile(video.file_path, { root: config.storageDir });
});
