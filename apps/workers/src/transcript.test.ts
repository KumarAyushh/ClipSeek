// Unit tests for transcript.ts (cleaning up made-up words, ~30s windows with 5s overlap).

import { describe, expect, test } from "bun:test";
import {
  dropIsolatedPhrases,
  dropUnheardWindows,
  fixWordTimes,
  groupIntoWindows,
  type TranscriptWord,
} from "./transcript";

// A 0.5s word starting at `start_s`.
const word = (start_s: number, text = `w${start_s}`): TranscriptWord => ({
  text,
  start_s,
  end_s: start_s + 0.5,
});

describe("fixWordTimes", () => {
  test("cuts a word stretched over a pause, keeps its start", () => {
    // The real case: a made-up "I'm" that Whisper stretched over 28s of silence.
    const [w] = fixWordTimes([{ text: "I'm", start_s: 21.4, end_s: 49.38 }]);
    expect(w).toEqual({ text: "I'm", start_s: 21.4, end_s: 23.4 });
  });

  test("an end before the start becomes a zero-length word", () => {
    const [w] = fixWordTimes([{ text: "little", start_s: 169.98, end_s: 140 }]);
    expect(w!.end_s).toBe(169.98);
  });

  test("leaves normal words alone", () => {
    const words = [word(1), word(2)];
    expect(fixWordTimes(words)).toEqual(words);
  });
});

describe("dropIsolatedPhrases", () => {
  // Four words, one per second, so a phrase that is long enough to keep.
  const speech = (start_s: number) => [0, 1, 2, 3].map((i) => word(start_s + i));

  test("drops up to 3 words with ≥ 3s of silence on both sides", () => {
    const words = [...speech(0), word(10, "you"), word(10.5, "I'm"), ...speech(20)];
    const texts = dropIsolatedPhrases(words).map((w) => w.text);
    expect(texts).not.toContain("you");
    expect(texts).not.toContain("I'm");
    expect(texts).toHaveLength(8);
  });

  test("keeps a phrase of 4 words", () => {
    expect(dropIsolatedPhrases(speech(10))).toHaveLength(4);
  });

  test("words closer than 3s stay in one phrase", () => {
    // w6 has 2.5s of silence before it, so it's part of the same 5-word phrase.
    const words = [...speech(0), word(6)];
    expect(dropIsolatedPhrases(words)).toHaveLength(5);
  });

  test("a single word has no neighbours at all → dropped", () => {
    expect(dropIsolatedPhrases([word(12, "you")])).toEqual([]);
  });

  test("no words → no words", () => {
    expect(dropIsolatedPhrases([])).toEqual([]);
  });

  test("works on unsorted input", () => {
    const words = [word(21), word(1), word(10, "you"), word(0), word(20), word(2), word(3)];
    expect(dropIsolatedPhrases(words).map((w) => w.start_s)).toEqual([0, 1, 2, 3]);
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
    expect(w).toEqual({ start_s: 3.2, end_s: 4.5, text: "w3.2 w4", zero_length_share: 0 });
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

  test("counts the share of words with no length", () => {
    const noLength: TranscriptWord = { text: "fake", start_s: 1, end_s: 1 };
    const [w] = groupIntoWindows([word(0), noLength, word(2), word(3)]);
    expect(w!.zero_length_share).toBe(0.25);
  });

  test("words come out in spoken order even if the input isn't sorted", () => {
    const [w] = groupIntoWindows([word(2, "c"), word(0, "a"), word(1, "b")]);
    expect(w!.text).toBe("a b c");
  });
});

describe("dropUnheardWindows", () => {
  const window = (text: string, zero_length_share: number) => ({
    start_s: 0,
    end_s: 30,
    text,
    zero_length_share,
  });

  test("drops a window when at least half of its words have no length", () => {
    const windows = [window("real speech", 0.02), window("half", 0.5), window("loop", 0.9)];
    expect(dropUnheardWindows(windows).map((w) => w.text)).toEqual(["real speech"]);
  });

  test("keeps a window that is only partly made up", () => {
    expect(dropUnheardWindows([window("mixed", 0.49)])).toHaveLength(1);
  });
});
