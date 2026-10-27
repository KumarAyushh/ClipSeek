-- 001_init.sql — first version of the database.
-- Run with: bun run db:migrate   (each migration file runs once, in filename order)

-- pgvector adds the `vector(n)` column type and the <=> (cosine distance) operator.
CREATE EXTENSION IF NOT EXISTS vector;

-- One row per uploaded video.
CREATE TABLE videos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  file_path   text NOT NULL,                 -- where the (faststart) mp4 is stored
  duration_s  real,                          -- length in seconds, taken from ffprobe
  metadata    jsonb,                         -- full ffprobe output (format + streams), kept as-is
  status      text NOT NULL DEFAULT 'processing'
              CHECK (status IN ('processing', 'ready', 'failed')),
  -- Each worker sets its own flag when it finishes. The video is 'ready' when all three are true.
  visual_done boolean NOT NULL DEFAULT false,
  speech_done boolean NOT NULL DEFAULT false,
  sound_done  boolean NOT NULL DEFAULT false,
  error       text,                          -- why it failed, if status = 'failed'
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Visual worker: one row per sampled frame (1 frame every 2 seconds).
CREATE TABLE frames (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- ON DELETE CASCADE: deleting a video also deletes its frames
  video_id    uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  ts_s        real NOT NULL,                 -- timestamp in SECONDS (frame index × 2), never the raw index
  thumb_path  text,                          -- small jpg shown in search results
  embedding   vector(512) NOT NULL           -- CLIP image embedding, L2-normalized
);

-- Speech worker: one row per ~30s transcript window.
CREATE TABLE segments (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id    uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_s     real NOT NULL,
  end_s       real NOT NULL,
  text        text NOT NULL,
  embedding   vector(384) NOT NULL,          -- bge-small text embedding, L2-normalized
  -- Keyword-search version of `text`, kept up to date by Postgres automatically.
  -- 'english' = lowercase, drop stop words ("the", "a"), stem words ("running" -> "run").
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

-- Sound worker: one row per 10s audio window.
CREATE TABLE sounds (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id    uuid NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_s     real NOT NULL,
  end_s       real NOT NULL,
  embedding   vector(512) NOT NULL           -- CLAP audio embedding, L2-normalized
);

-- Workers delete "all rows for this video" before re-inserting (idempotency),
-- and results are grouped by video, so every child table gets a video_id index.
CREATE INDEX frames_video_id_idx   ON frames (video_id);
CREATE INDEX segments_video_id_idx ON segments (video_id);
CREATE INDEX sounds_video_id_idx   ON sounds (video_id);

-- HNSW = approximate nearest-neighbour index for fast vector search.
-- vector_cosine_ops means it speeds up queries that ORDER BY embedding <=> query (cosine distance).
-- A query using a different operator (e.g. <-> for L2 distance) would NOT use this index.
CREATE INDEX frames_embedding_idx   ON frames   USING hnsw (embedding vector_cosine_ops);
CREATE INDEX segments_embedding_idx ON segments USING hnsw (embedding vector_cosine_ops);
CREATE INDEX sounds_embedding_idx   ON sounds   USING hnsw (embedding vector_cosine_ops);

-- GIN index makes keyword search (tsv @@ query) fast.
CREATE INDEX segments_tsv_idx ON segments USING gin (tsv);
