// Makes the workers of ONE process take turns instead of all running their models at once.
//
// `bun run dev` puts all three workers in one process. Each is its own Kafka consumer, so one
// upload starts visual, speech and sound at the same moment, and three models doing inference
// together use far more memory than any one of them (on a 7.6 GB WSL box the kernel's OOM killer
// stopped the process, even for an 8s clip). Taking turns keeps that peak down.
//
// Kafka fan-out is unchanged: every worker still gets every message and has its own offsets.
// Workers started as separate processes (`bun run start visual`, ...) each have their own queue,
// so they still run in parallel when the machine has the memory for it.
//
// Pure code (no Kafka, no config), so tests can import it without loading anything.

export type Turn = {
  ready: Promise<void>; // resolves when it's this caller's turn
  release: () => void; // call when done; lets the next caller go
};

// Returns a function that joins the line. Line order = call order.
//
// `tail` is the promise of whoever is last in line. A new caller waits on it and becomes the new
// tail:
//   A: ready now          release → B can go
//   B: waits for A        release → C can go
//   C: waits for B
export function createTurnQueue(): () => Turn {
  let tail: Promise<void> = Promise.resolve();

  return function takeTurn(): Turn {
    const ready = tail;
    let free = () => {};
    tail = new Promise<void>((resolve) => {
      free = resolve;
    });
    // Wait for `ready` so a caller that gives up early (a Kafka error while it was in line)
    // can't let the people behind it overtake the one who is still running.
    return { ready, release: () => void ready.then(free) };
  };
}
