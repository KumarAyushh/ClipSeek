import { describe, expect, test } from "bun:test";
import { createTurnQueue } from "./turns";

describe("createTurnQueue", () => {
  test("the first caller goes right away", async () => {
    const takeTurn = createTurnQueue();
    await takeTurn().ready; // would hang (test timeout) if it had to wait
  });

  test("runs one at a time, in call order", async () => {
    const takeTurn = createTurnQueue();
    const log: string[] = [];

    async function job(name: string) {
      const turn = takeTurn();
      await turn.ready;
      log.push(`${name} start`);
      await Bun.sleep(5); // gives a second job the chance to overlap, if the queue were broken
      log.push(`${name} end`);
      turn.release();
    }

    await Promise.all([job("a"), job("b"), job("c")]);
    expect(log).toEqual(["a start", "a end", "b start", "b end", "c start", "c end"]);
  });

  test("giving up while in line doesn't let the next caller overtake the running one", async () => {
    const takeTurn = createTurnQueue();
    const running = takeTurn();
    const quitter = takeTurn();
    const last = takeTurn();

    let lastStarted = false;
    void last.ready.then(() => {
      lastStarted = true;
    });

    quitter.release(); // left the line before its turn came
    await Bun.sleep(5);
    expect(lastStarted).toBe(false); // `running` still holds its turn

    running.release();
    await last.ready;
    expect(lastStarted).toBe(true);
  });
});
