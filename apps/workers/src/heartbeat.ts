// Keeps the Kafka consumer "alive" while one long step runs (ffmpeg decoding, Whisper).
//
// Kafka expects a heartbeat from each consumer at least once per session timeout (30s).
// If a video takes minutes and we just `await` it, Kafka thinks we died, takes the
// partition away and gives the video to another copy (a needless rebalance + duplicate work).

// How often to send a heartbeat while waiting. Well under the 30s session timeout.
const HEARTBEAT_MS = 3000;

// Wait for `work` to finish, sending a heartbeat every 3s until it does.
// Returns what `work` returns, or throws what it throws.
//
// This only works if `work` lets the event loop run now and then (it awaits something).
// ffmpeg runs in another process, and the models run inside onnxruntime with `await`
// between steps, so both are fine.
export async function withHeartbeat<T>(work: Promise<T>, heartbeat: () => Promise<void>): Promise<T> {
  let finished = false;
  const done = work.finally(() => {
    finished = true;
  });
  // If heartbeat() throws (e.g. Kafka is rebalancing), we stop waiting and rethrow. `work`
  // keeps running in the background; if it then fails, nobody awaits it, and Bun would crash
  // the process with an "unhandled rejection". This empty handler marks it as handled.
  // (Awaiting `done` below still throws the error normally.)
  done.catch(() => {});

  while (!finished) {
    await heartbeat();
    await Promise.race([done, Bun.sleep(HEARTBEAT_MS)]); // whichever comes first
  }
  return done;
}
