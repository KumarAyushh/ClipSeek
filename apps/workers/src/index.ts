// Entry point for the background workers. Each worker is a Kafka consumer in its own group:
//   visual-worker  -> frames   (CLIP)              Day 5
//   speech-worker  -> segments (Whisper + bge)     Day 6
//   sound-worker   -> sounds   (CLAP)              Day 7
//
// Usage (from apps/workers):
//   bun run dev            → all three workers in one process (what `bun run dev` at the root starts)
//   bun run start visual   → only the visual worker. Start it in 2 terminals to watch the
//                            two copies split the topic's 3 partitions between them.

import { sql, type Consumer } from "@app/shared";
import { startWorker, type Job, type WorkerDef, type WorkerName } from "./runner";

// Day 4 placeholder: check the video file exists, then pretend to work for 5 seconds,
// sending a heartbeat every second, so you can watch the flow (and two copies working
// at once). A missing file throws → the video is marked 'failed'. Days 5–7 replace it.
async function placeholderWork(job: Job): Promise<void> {
  if (!(await Bun.file(job.filePath).exists())) {
    throw new Error(`video file not found: ${job.filePath}`);
  }
  for (let i = 0; i < 5; i++) {
    await Bun.sleep(1000);
    await job.heartbeat();
  }
}

const WORKERS: Record<WorkerName, WorkerDef> = {
  visual: { name: "visual", process: placeholderWork },
  speech: { name: "speech", process: placeholderWork },
  sound: { name: "sound", process: placeholderWork },
};

// process.argv = [bun, src/index.ts, <worker name?>]
const arg = process.argv[2];
let selected: WorkerDef[];
if (arg === undefined) {
  selected = Object.values(WORKERS);
} else if (arg === "visual" || arg === "speech" || arg === "sound") {
  selected = [WORKERS[arg]];
} else {
  console.error(`Unknown worker "${arg}". Use visual, speech or sound (or nothing for all three).`);
  process.exit(1);
}

const consumers: Consumer[] = await Promise.all(selected.map(startWorker));

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
