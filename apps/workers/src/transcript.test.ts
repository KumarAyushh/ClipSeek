// Unit tests for transcript.ts (dropping made-up words, ~30s windows with 5s overlap).

import { describe, expect, test } from "bun:test";
import { dropIsolatedWords, groupIntoWindows, type TranscriptWord } from "./transcript";

// A 0.5s word starting at `start_s`.
const word = (start_s: number, text = `w${start_s}`): TranscriptWord => ({
  text,
  start_s,
  end_s: start_s + 0.5,
});

describe("dropIsolatedWords", () => {
  test("drops a word with ≥ 3s of silence on both sides (Whisper's lone 'you')", () => {
    const words = [word(0), word(1), word(10, "you"), word(20), word(21)];
    expect(dropIsolatedWords(words).map((w) => w.text)).toEqual(["w0", "w1", "w20", "w21"]);
  });

  test("keeps a word with a close neighbour on ONE side", () => {
    // w5 has 3.5s of silence before it but only 0.5s after it → real speech.
    // (w0 needs w1: alone, w0 would itself be isolated and correctly dropped.)
    const words = [word(0), word(1), word(5), word(6)];
    expect(dropIsolatedWords(words)).toHaveLength(4);
  });

  test("a single word has no neighbours at all → dropped", () => {
    expect(dropIsolatedWords([word(12, "you")])).toEqual([]);
  });

  test("works on unsorted input", () => {
    const words = [word(21), word(10, "you"), word(0), word(20), word(1)];
    expect(dropIsolatedWords(words).map((w) => w.start_s)).toEqual([0, 1, 20, 21]);
  });
});

describe("groupIntoWindows", () => {
  test("no words → no windows", () => {
    expect(groupIntoWindows([])).toEqual([]);
  });

  test("60s of speech → windows on a 25s grid, 30s long, sharing 5s", () => {
    // One word every second, 0s … 59s.
    const words = Array.from({ length: 60 }, (_, i) => word(i));
    const windows = groupIntoWindows(words);
    // [0, 30) → words 0–29, [25, 55) → words 25–54, [50, 80) → words 50–59
    expect(windows.map((w) => [w.start_s, w.end_s])).toEqual([
      [0, 29.5],
      [25, 54.5],
      [50, 59.5],
    ]);
    // Overlap: words 25–29 are in both of the first two windows.
    expect(windows[0]!.text.endsWith("w25 w26 w27 w28 w29")).toBe(true);
    expect(windows[1]!.text.startsWith("w25 w26 w27 w28 w29")).toBe(true);
  });

  test("window times come from its words, not the grid", () => {
    const [w] = groupIntoWindows([word(3.2), word(4)]);
    expect(w).toEqual({ start_s: 3.2, end_s: 4.5, text: "w3.2 w4" });
  });

  test("a word still being spoken when a window starts belongs to it too", () => {
    // Starts at 24s, ends at 26s → spoken inside both [0, 30) and [25, 55).
    const long: TranscriptWord = { text: "long", start_s: 24, end_s: 26 };
    const windows = groupIntoWindows([word(0), long, word(40)]);
    expect(windows.map((w) => w.text)).toEqual(["w0 long", "long w40"]);
  });

  test("silent windows and windows with nothing new are skipped", () => {
    // Speech at 0–2s and 100–102s, silence between.
    // [25,55) and [50,80) are silent; [75,105) has 100–102; [100,130) has the SAME words → skipped.
    const words = [word(0), word(1), word(2), word(100), word(101), word(102)];
    expect(groupIntoWindows(words).map((w) => w.start_s)).toEqual([0, 100]);
  });

  test("words come out in spoken order even if the input isn't sorted", () => {
    const [w] = groupIntoWindows([word(2, "c"), word(0, "a"), word(1, "b")]);
    expect(w!.text).toBe("a b c");
  });
});
