// Getting a video's sound out as numbers an audio model can read.
// Used by the speech worker (Whisper, 16 kHz) and, on Day 7, the sound worker (CLAP, 48 kHz).

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
// - `-f f32le pipe:1`: raw 32-bit little-endian floats to stdout. No WAV header to parse:
//   every 4 bytes is one sample, which is exactly what a Float32Array reads.
//
// Size: 4 bytes × 16000/s ≈ 64 KB per second → a 1-hour video ≈ 230 MB in memory.
export async function readAudio(
  filePath: string,
  sampleRate: number,
  heartbeat: () => Promise<void>,
): Promise<Float32Array> {
  const proc = Bun.spawn(
    [
      "ffmpeg", "-nostdin", "-v", "error",
      "-i", filePath,
      "-vn",
      "-ac", "1",
      "-ar", String(sampleRate),
      "-f", "f32le", "pipe:1",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  // Start reading both pipes right away. If we didn't read stdout while ffmpeg runs,
  // the pipe would fill up and ffmpeg would wait forever for us to empty it.
  const bytes = new Response(proc.stdout).arrayBuffer();
  const stderr = new Response(proc.stderr).text();

  try {
    await withHeartbeat(proc.exited, heartbeat);
  } finally {
    proc.kill(); // only does something if heartbeat() threw while ffmpeg was still running
  }

  if ((await proc.exited) !== 0) {
    throw new Error(`ffmpeg audio extraction failed: ${(await stderr).trim()}`);
  }
  return new Float32Array(await bytes);
}
