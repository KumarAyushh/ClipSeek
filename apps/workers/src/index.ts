// Entry point for the background workers. Each worker is a Kafka consumer in its own group:
//   visual-worker  -> frames   (CLIP)              Day 5 (visual.ts)
//   speech-worker  -> segments (Whisper + bge)     Day 6
//   sound-worker   -> sounds   (CLAP)              Day 7
//
// Usage (from apps/workers):
//   bun run dev            → all three workers in one process (what `bun run dev` at the root starts)
//   bun run start visual   → only the visual worker. Start it in 2 terminals to watch the
//                            two copies split the topic's 3 partitions between them.

import { sql, type Consumer } from "@app/shared";
import { startWorker, type Job, type WorkerDef, type WorkerName } from "./runner";
import { createVisualWorker } from "./visual";

// Day 4 placeholder for speech + sound: check the video file exists, then pretend to work
// for 5 seconds, sending a heartbeat every second. A missing file throws → the video is
// marked 'failed'. Days 6–7 replace it.
async function placeholderWork(job: Job): Promise<void> {
  if (!(await Bun.file(job.filePath).exists())) {
    throw new Error(`video file not found: ${job.filePath}`);
  }
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(1000);
    await job.heartbeat();
  }
}

// One "create" function per worker. Creating a worker loads its model(s), which takes
// seconds and memory, so we only create the workers that were asked for.
const WORKERS: Record<WorkerName, () => Promise<WorkerDef>> = {
  visual: createVisualWorker,
  speech: async () => ({ name: "speech", process: placeholderWork }),
  sound: async () => ({ name: "sound", process: placeholderWork }),
};

// process.argv = [bun, src/index.ts, <worker name?>]
const arg = process.argv[2];
let selected: (() => Promise<WorkerDef>)[];
if (arg === undefined) {
  selected = Object.values(WORKERS);
} else if (arg === "visual" || arg === "speech" || arg === "sound") {
  selected = [WORKERS[arg]];
} else {
  console.error(`Unknown worker "${arg}". Use visual, speech or sound (or nothing for all three).`);
  process.exit(1);
}

// Load the models first, then start consuming. A model that fails to load crashes here,
// before we take any messages from Kafka.
const workers = await Promise.all(selected.map((create) => create()));
const consumers: Consumer[] = await Promise.all(workers.map(startWorker));

// Ctrl+C / docker stop: leave the consumer groups cleanly. Kafka then hands our partitions
// to the other copies right away, instead of waiting for the session timeout (~30s)
// to notice we're gone.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    console.log(`workers: ${signal}, disconnecting`);
    await Promise.all(consumers.map((c) => c.disconnect()));
    await sql.close();
    process.exit(0);
  });
}
