// Unit tests for soundWindows.ts (10s CLAP windows, counted in samples).

import { describe, expect, test } from "bun:test";
import { soundWindows } from "./soundWindows";

const RATE = 48_000; // CLAP's sample rate

describe("soundWindows", () => {
  test("300s → 30 back-to-back 10s windows", () => {
    const windows = soundWindows(300 * RATE, RATE);
    expect(windows).toHaveLength(30);
    expect(windows[0]).toEqual({ start_s: 0, end_s: 10, from: 0, to: 480_000 });
    expect(windows.at(-1)).toMatchObject({ start_s: 290, end_s: 300 });
  });

  test("windows are contiguous: no gap, no overlap", () => {
    const windows = soundWindows(95 * RATE, RATE);
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.from).toBe(windows[i - 1]!.to);
      expect(windows[i]!.start_s).toBe(windows[i - 1]!.end_s);
    }
  });

  test("a last piece ≥ 1s is kept (shorter window)", () => {
    const windows = soundWindows(34.5 * RATE, RATE);
    expect(windows).toHaveLength(4);
    expect(windows.at(-1)).toMatchObject({ start_s: 30, end_s: 34.5 });
  });

  test("a last piece < 1s is dropped", () => {
    const windows = soundWindows(20.5 * RATE, RATE);
    expect(windows.map((w) => [w.start_s, w.end_s])).toEqual([
      [0, 10],
      [10, 20],
    ]);
  });

  test("audio shorter than 1s → no windows; no audio → no windows", () => {
    expect(soundWindows(0.5 * RATE, RATE)).toEqual([]);
    expect(soundWindows(0, RATE)).toEqual([]);
  });
});
