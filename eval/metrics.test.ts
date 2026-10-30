// Unit tests for metrics.ts (does a result count as a hit, Recall@k, MRR).

import { describe, expect, test } from "bun:test";
import { firstHitRank, isHit, meanReciprocalRank, recallAtK } from "./metrics";

const target = { title: "a", start_s: 100, end_s: 110 };

describe("isHit", () => {
  test("landing inside the expected range is a hit", () => {
    expect(isHit({ title: "a", start_s: 105 }, target)).toBe(true);
  });

  test("landing up to 15s early is a hit, earlier is a miss", () => {
    expect(isHit({ title: "a", start_s: 85 }, target)).toBe(true);
    expect(isHit({ title: "a", start_s: 84.9 }, target)).toBe(false);
  });

  test("landing after the end is a miss: the moment has passed", () => {
    expect(isHit({ title: "a", start_s: 110.1 }, target)).toBe(false);
  });

  test("the right time in the wrong video is a miss", () => {
    expect(isHit({ title: "b", start_s: 105 }, target)).toBe(false);
  });
});

describe("firstHitRank", () => {
  const results = [
    { title: "b", start_s: 0 },
    { title: "a", start_s: 500 },
    { title: "a", start_s: 105 },
  ];

  test("position of the first hit, starting at 1", () => {
    expect(firstHitRank(results, [target])).toBe(3);
  });

  test("any of several expected places counts", () => {
    expect(firstHitRank(results, [target, { title: "b", start_s: 0, end_s: 5 }])).toBe(1);
  });

  test("no hit → null", () => {
    expect(firstHitRank(results, [{ title: "c", start_s: 0, end_s: 5 }])).toBeNull();
  });
});

describe("recallAtK", () => {
  test("share of queries with a hit in the top k", () => {
    expect(recallAtK([1, 5, 6, null], 5)).toBe(0.5);
  });

  test("no queries → 0, not NaN", () => {
    expect(recallAtK([], 5)).toBe(0);
  });
});

describe("meanReciprocalRank", () => {
  test("average of 1 / rank, a miss counts as 0", () => {
    // (1 + 0.5 + 0.25 + 0) / 4
    expect(meanReciprocalRank([1, 2, 4, null])).toBe(0.4375);
  });

  test("no queries → 0, not NaN", () => {
    expect(meanReciprocalRank([])).toBe(0);
  });
});
