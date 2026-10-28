// Runs one kind of worker (visual, speech or sound) as a Kafka consumer.
// The Kafka + database bookkeeping is the same for all three, so it lives here once.
// Each worker only supplies a `process(job)` function that does the real work.
//
// For every `video.uploaded` message:
//   parse { videoId, filePath } → process(job) → set <name>_done → maybe set status 'ready'
//                                            └─ error → status 'failed' + error message
//   then commit the offset ("this message is handled, don't give it to me again")

import path from "node:path";
import { config, createKafka, KafkaJSError, sql, type Consumer, type VideoUploadedEvent } from "@app/shared";

export type WorkerName = "visual" | "speech" | "sound";

// What a worker gets for one video.
export type Job = {
  videoId: string;
  filePath: string; // absolute path to the faststart mp4
  // Tell Kafka "I'm still alive". Call it between steps of long work (e.g. between batches).
  // Without it, Kafka decides the consumer died and gives the video to another copy.
  heartbeat: () => Promise<void>;
};

export type WorkerDef = {
  name: WorkerName;
  process: (job: Job) => Promise<void>;
};

// Starts the consumer and returns it, so index.ts can disconnect it on shutdown.
export async function startWorker(worker: WorkerDef): Promise<Consumer> {
  // Own consumer group per worker type → each group gets EVERY message (fan-out).
  // Copies of the same worker share a group → they split the partitions between them.
  const groupId = `${worker.name}-worker`;
  // pid in the log tells copies apart when you run the same worker in two terminals.
  const tag = `[${groupId} pid ${process.pid}]`;

  const consumer = createKafka(groupId).consumer({ groupId });
  await consumer.connect();
  // fromBeginning only matters the first time a group ever starts (it has no committed
  // offset yet): read the messages already in the topic instead of only new ones.
  // After that, the group always continues from its last committed offset.
  await consumer.subscribe({ topic: config.kafka.topicVideoUploaded, fromBeginning: true });

  await consumer.run({
    // We commit by hand, only once the outcome is saved in the DB (see commit() below).
    autoCommit: false,
    // eachMessage handles one message at a time per partition, so one copy of a worker
    // processes one video at a time.
    eachMessage: async ({ topic, partition, message, heartbeat }) => {
      // The committed offset is the NEXT message to read, so it's this offset + 1.
      // Offsets are strings in kafkajs (they can exceed JS's safe integer range), hence BigInt.
      const commit = () =>
        consumer.commitOffsets([{ topic, partition, offset: (BigInt(message.offset) + 1n).toString() }]);
      const where = `partition ${partition}, offset ${message.offset}`;

      const event = parseEvent(message.value);
      if (!event) {
        // Retrying a broken message would fail forever and block the partition. Skip it.
        console.error(`${tag} skipping unreadable message (${where})`);
        await commit();
        return;
      }

      console.log(`${tag} start ${event.videoId} (${where})`);
      const started = performance.now();
      try {
        await worker.process({
          videoId: event.videoId,
          filePath: path.join(config.storageDir, event.filePath),
          heartbeat,
        });
        await markDone(worker.name, event.videoId);
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        console.log(`${tag} done  ${event.videoId} in ${seconds}s`);
      } catch (err) {
        // A Kafka error (e.g. heartbeat() during a rebalance) is not the video's fault.
        // Rethrow without committing: kafkajs rejoins the group and the message is
        // delivered again (maybe to another copy). Work is idempotent, so a repeat is safe.
        if (err instanceof KafkaJSError) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`${tag} failed ${event.videoId}: ${reason}`);
        // If THIS query throws (e.g. DB down), the error escapes, nothing is committed,
        // and the message comes back later. So a failure is never silently lost.
        await markFailed(worker.name, event.videoId, reason);
      }

      // The outcome (done or failed) is saved in the DB, so the message is handled.
      await commit();
    },
  });

  console.log(`${tag} listening on "${config.kafka.topicVideoUploaded}"`);
  return consumer;
}

// Turn the raw message bytes back into a VideoUploadedEvent. Returns null if it isn't one.
function parseEvent(value: Buffer | null): VideoUploadedEvent | null {
  if (!value) return null;
  let data: unknown;
  try {
    data = JSON.parse(value.toString());
  } catch {
    return null; // not JSON
  }
  if (
    typeof data === "object" &&
    data !== null &&
    "videoId" in data &&
    typeof data.videoId === "string" &&
    "filePath" in data &&
    typeof data.filePath === "string"
  ) {
    return { videoId: data.videoId, filePath: data.filePath };
  }
  return null;
}

async function markDone(name: WorkerName, videoId: string): Promise<void> {
  // sql(column) inserts a column NAME (quoted), not a value. Safe here because `column`
  // can only be visual_done / speech_done / sound_done (WorkerName is a fixed union).
  const column = `${name}_done`;
  await sql`UPDATE videos SET ${sql(column)} = true WHERE id = ${videoId}`;

  // "Ready" check. Each worker runs it after saving its own flag, so whichever finishes
  // LAST sees all three flags true and flips the status. Two workers finishing at the same
  // moment can both flip it; that's harmless. `status = 'processing'` keeps a failed video failed.
  await sql`
    UPDATE videos SET status = 'ready'
    WHERE id = ${videoId} AND status = 'processing' AND visual_done AND speech_done AND sound_done`;
}

async function markFailed(name: WorkerName, videoId: string, reason: string): Promise<void> {
  // Prefix with the worker name so `error` says which step broke, e.g. "speech: ffmpeg exited with 1".
  await sql`UPDATE videos SET status = 'failed', error = ${`${name}: ${reason}`} WHERE id = ${videoId}`;
}
