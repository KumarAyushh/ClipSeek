// Central place for every setting the apps need.
// All values come from environment variables (loaded from the root .env file),
// so nothing secret or machine-specific is hard-coded in the source.
// Every app imports `config` from here instead of reading process.env itself.

import path from "node:path";

// import.meta.dir = folder of this file (packages/shared/src).
// Going up 3 levels gives the repo root, used to resolve relative paths like ./storage.
const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

// Read an env var or crash immediately with a helpful message.
// Failing at startup is better than running with a missing value and breaking later.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return value;
}

// Same as required(), but also checks the value is a whole number (e.g. a port).
function requiredInt(name: string): number {
  const raw = required(name);
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    throw new Error(`Env var ${name} must be an integer, got "${raw}"`);
  }
  return value;
}

export const config = {
  // Postgres connection string: postgres://user:password@host:port/database
  databaseUrl: required("DATABASE_URL"),

  kafka: {
    // Comma-separated list of brokers, e.g. "localhost:9092". We only run one.
    brokers: required("KAFKA_BROKERS").split(","),
    // The single topic the API publishes to after an upload
    topicVideoUploaded: required("KAFKA_TOPIC_VIDEO_UPLOADED"),
  },

  // Absolute path where videos and thumbnails are saved
  storageDir: path.resolve(REPO_ROOT, required("STORAGE_DIR")),

  apiPort: requiredInt("API_PORT"),

  // Hugging Face model ids. transformers.js downloads them once, then runs them locally.
  models: {
    clip: required("CLIP_MODEL"), // frames + visual search (512-d)
    whisper: required("WHISPER_MODEL"), // speech -> text with timestamps
    textEmbed: required("TEXT_EMBED_MODEL"), // transcript chunks + text search (384-d)
    clap: required("CLAP_MODEL"), // sounds + sound search (512-d)
  },
} as const; // `as const` makes every field read-only so nothing changes config at runtime
