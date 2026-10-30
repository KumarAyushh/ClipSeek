// Getting a video's sound out as numbers an audio model can read.
// Used by the speech worker (Whisper, 16 kHz) and the sound worker (CLAP, 48 kHz).

import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "@app/shared";
import { withHeartbeat } from "./heartbeat";

// Does the video have an audio track? A screen recording or GIF-like clip may not, and
// then ffmpeg has nothing to extract. We don't run ffprobe again: the API already stored
// its full output in videos.metadata (jsonb), so we ask Postgres to look in there.
//   jsonb_array_elements(metadata->'streams') → one row per stream (video, audio, ...)
//   s->>'codec_type'                          → that stream's type as text
export async function hasAudioStream(videoId: string): Promise<boolean> {
  const rows: { has_audio: boolean }[] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM jsonb_array_elements(metadata->'streams') AS s
      WHERE s->>'codec_type' = 'audio'
    ) AS has_audio
    FROM videos WHERE id = ${videoId}`;
  const row = rows[0];
  if (!row) throw new Error(`video ${videoId} not found in the database`);
  return row.has_audio;
}

// Decode the video's audio into mono float samples (between -1 and 1) at `sampleRate`.
// The result has sampleRate × seconds numbers: sample i is at i / sampleRate seconds.
// - `-vn`: skip the video stream (we only want sound, so don't waste time decoding pictures)
// - `-ac 1`: downmix to 1 channel (mono); the models expect one channel
// - `-ar <rate>`: resample. Whisper needs 16000, CLAP 48000. A wrong rate doesn't crash,
//   it just gives garbage (the model "hears" the audio sped up or slowed down)
// - `-f f32le <file>`: raw 32-bit little-endian floats. No WAV header to parse: every 4 bytes
//   is one sample, which is exactly what a Float32Array reads.
//
// Why a temp file and not stdout (`pipe:1`): Bun's subprocess pipe uses far more memory than the
// data it carries. Measured with no model loaded, 55 MB of audio: pipe peak 2410 MB, file 91 MB,
// same speed. That extra memory ran the workers out of RAM on 5-minute videos.
// The file lives in the system temp folder, so one left behind by a crash can't pile up in storage/.
//
// Size: 4 bytes × 16000/s ≈ 64 KB per second → a 1-hour video ≈ 230 MB in memory (and on disk
// for a moment, while the temp file exists).
export async function readAudio(
  filePath: string,
  sampleRate: number,
  heartbeat: () => Promise<void>,
): Promise<Float32Array> {
  // A random name, because workers read the same video at the same time at different rates.
  const tmpPath = path.join(tmpdir(), `${crypto.randomUUID()}.f32`);
  const proc = Bun.spawn(
    [
      "ffmpeg", "-nostdin", "-v", "error", "-y",
      "-i", filePath,
      "-vn",
      "-ac", "1",
      "-ar", String(sampleRate),
      "-f", "f32le", tmpPath,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  // Read stderr while ffmpeg runs, so a full pipe can't make it hang.
  const stderr = new Response(proc.stderr).text();

  try {
    await withHeartbeat(proc.exited, heartbeat);
    if ((await proc.exited) !== 0) {
      throw new Error(`ffmpeg audio extraction failed: ${(await stderr).trim()}`);
    }
    return new Float32Array(await Bun.file(tmpPath).arrayBuffer());
  } finally {
    proc.kill(); // only does something if heartbeat() threw while ffmpeg was still running
    await rm(tmpPath, { force: true }); // success or failure, the temp file goes
  }
}
