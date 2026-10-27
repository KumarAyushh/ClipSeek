# ClipSeek

Search inside your videos by what is **shown**, **said** or **heard**, and jump straight to that moment.

Type *"man fixing a bike tyre"* or *"dog barking"* and get back the video and the exact timestamp. Everything runs locally with free, open models. No API keys.

> Work in progress.

## How it works

1. **Upload:** the API saves the video, makes it stream-friendly (faststart), stores its ffprobe metadata and publishes a `video.uploaded` event to Kafka.
2. **Process in parallel:** three Kafka consumer groups each receive the event:
   - **Visual:** 1 frame every 2s → CLIP image embeddings
   - **Speech:** Whisper transcript with timestamps → ~30s chunks → bge-small embeddings
   - **Sound:** 10s audio windows at 48 kHz → CLAP audio embeddings
3. **Search:** the query runs against frames (CLIP), transcript chunks (vector + keyword) and sounds (CLAP). The four result lists are merged with Reciprocal Rank Fusion into a ranked list of moments.

## Tech stack

Bun · TypeScript · Turborepo · Express · Apache Kafka (KRaft) · PostgreSQL + pgvector · ffmpeg · transformers.js (CLIP, Whisper, bge-small, CLAP) · React + Vite + Tailwind · Docker Compose · GitHub Actions

## Run locally

Requirements: [Bun](https://bun.sh) ≥ 1.3, Docker, ffmpeg. The first run downloads the four models (~1.6 GB) into `storage/models/`; `bun run spike` checks they all load.

```bash
cp .env.example .env        # then fill in the values
bun install
docker compose up -d        # Postgres + Kafka
bun run db:migrate          # create tables and indexes
bun run kafka:setup         # create the video.uploaded topic (3 partitions)
bun run dev                 # API, workers and web app
```

## Project layout

```
apps/api         Express API: upload, list, stream, search
apps/workers     Kafka consumers: visual, speech, sound
apps/web         React frontend
packages/shared  config, database client, Kafka client
scripts/         migration and Kafka setup scripts
```
