// TypeScript shapes of database rows, shared by the API and the workers.
// They must match migrations/001_init.sql. Postgres can't check this for us,
// so when a column changes in a migration, change it here too.

export type VideoStatus = "processing" | "ready" | "failed";

// One row of the `videos` table, as Bun's SQL client returns it.
export type Video = {
  id: string; // uuid
  title: string;
  file_path: string; // relative to config.storageDir, e.g. "videos/<id>.mp4"
  duration_s: number | null; // seconds, from ffprobe; null if ffprobe didn't report one
  metadata: Record<string, unknown> | null; // full ffprobe JSON (jsonb comes back already parsed)
  status: VideoStatus;
  visual_done: boolean;
  speech_done: boolean;
  sound_done: boolean;
  error: string | null;
  created_at: Date; // timestamptz comes back as a JS Date
};
