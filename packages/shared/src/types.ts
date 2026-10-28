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

// The value of one `video.uploaded` Kafka message (sent as JSON).
// The API builds it after the DB insert; every worker parses it. Keeping the type here
// means both sides break at compile time if one of them changes the shape.
// The message key is the videoId too, so one video always lands on the same partition.
export type VideoUploadedEvent = {
  videoId: string; // uuid of the videos row
  filePath: string; // relative to config.storageDir, same as videos.file_path
};
