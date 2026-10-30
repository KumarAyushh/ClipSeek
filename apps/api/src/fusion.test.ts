// Unit tests for fusion.ts (cutoff, buckets, RRF, merging). Pure functions: no DB, no models.
// Run with `bun test` from the repo root.

import { describe, expect, test } from "bun:test";
import { applyCutoff, bucketOf, fuseRrf, type Hit, mergeNearby, type Moment } from "./fusion";

// A hit with sensible defaults; tests only spell out what they care about.
function hit(video_id: string, start_s: number, extra: Partial<Hit> = {}): Hit {
  return { video_id, title: `title ${video_id}`, start_s, end_s: start_s, score: 0.5, ...extra };
}

// RRF contribution of rank r with k = 60.
const rrf = (rank: number) => 1 / (60 + rank);

describe("applyCutoff", () => {
  const hits = [hit("a", 0, { score: 0.6 }), hit("a", 10, { score: 0.4 }), hit("a", 20, { score: 0.2 })];

  test("keeps hits at or above the minimum, drops the rest", () => {
    expect(applyCutoff(hits, 0.4).map((h) => h.score)).toEqual([0.6, 0.4]);
  });

  test("null means no cutoff (keyword list)", () => {
    expect(applyCutoff(hits, null)).toEqual(hits);
  });

  test("everything below → empty list (nonsense query adds nothing)", () => {
    expect(applyCutoff(hits, 0.9)).toEqual([]);
  });
});

describe("bucketOf", () => {
  test("10s buckets: [0, 10) → 0, [10, 20) → 1, ...", () => {
    expect(bucketOf(0)).toBe(0);
    expect(bucketOf(9.99)).toBe(0);
    expect(bucketOf(10)).toBe(1);
    expect(bucketOf(162)).toBe(16);
  });
});

describe("fuseRrf", () => {
  test("one list: score = 1 / (60 + rank), best first", () => {
    const moments = fuseRrf({ sound: [hit("a", 40), hit("a", 200)] });
    expect(moments.map((m) => [m.bucket, m.score])).toEqual([
      [4, rrf(1)],
      [20, rrf(2)],
    ]);
  });

  test("a moment found by two lists beats each list's #1 found by one", () => {
    const moments = fuseRrf({
      visual: [hit("a", 0), hit("a", 162)], // 162s is visual's #2
      sound: [hit("a", 300), hit("a", 160)], // 160s is sound's #2, same bucket as 162s
    });
    expect(moments[0]!.bucket).toBe(16);
    expect(moments[0]!.score).toBeCloseTo(rrf(2) + rrf(2));
    expect(moments[0]!.matched_by).toEqual(["visual", "sound"]);
  });

  test("several hits of one list in one bucket vote only once", () => {
    // Frames at 162, 164, 166 are all bucket 16; 172 is bucket 17 and becomes rank 2, not 4.
    const moments = fuseRrf({
      visual: [hit("a", 162), hit("a", 164), hit("a", 166), hit("a", 172)],
    });
    expect(moments.map((m) => [m.bucket, m.score])).toEqual([
      [16, rrf(1)],
      [17, rrf(2)],
    ]);
  });

  test("same bucket in different videos are different moments", () => {
    const moments = fuseRrf({ sound: [hit("a", 40), hit("b", 40)] });
    expect(moments.map((m) => m.video_id)).toEqual(["a", "b"]);
  });

  test("time range = earliest start to latest end of the bucket's hits", () => {
    const moments = fuseRrf({
      visual: [hit("a", 166), hit("a", 162)],
      speech: [hit("a", 161.5, { end_s: 190 })],
    });
    expect(moments[0]!.start_s).toBe(161.5);
    expect(moments[0]!.end_s).toBe(190);
  });

  test("thumbnail from the best frame, snippet from the better-ranked transcript hit", () => {
    const moments = fuseRrf({
      visual: [hit("a", 162, { thumb_path: "best.jpg" }), hit("a", 164, { thumb_path: "other.jpg" })],
      speech: [hit("a", 0, { text: "speech #1" }), hit("a", 160, { text: "speech #2" })],
      keyword: [hit("a", 160, { text: "keyword #1" })],
    });
    const m = moments.find((x) => x.bucket === 16)!;
    expect(m.thumb_path).toBe("best.jpg");
    expect(m.snippet).toBe("keyword #1"); // rank 1 in keyword beats rank 2 in speech
  });

  test("empty or missing lists → no moments", () => {
    expect(fuseRrf({})).toEqual([]);
    expect(fuseRrf({ visual: [], sound: [] })).toEqual([]);
  });
});

describe("mergeNearby", () => {
  // A fused moment with defaults; bucket b starts at b × 10s.
  function moment(video_id: string, bucket: number, extra: Partial<Moment> = {}): Moment {
    return {
      video_id,
      title: `title ${video_id}`,
      bucket,
      start_s: bucket * 10,
      end_s: bucket * 10 + 9,
      score: 0.01,
      matched_by: ["visual"],
      snippet: null,
      thumb_path: null,
      ...extra,
    };
  }

  test("neighbouring buckets of one video become one result", () => {
    const results = mergeNearby([
      moment("a", 17, { score: 0.016, matched_by: ["sound"] }),
      moment("a", 16, { score: 0.033, matched_by: ["visual", "speech"] }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      start_s: 160, // the best moment, which here is also the earliest
      end_s: 179,
      score: 0.033, // the best moment's score (max, not sum)
      matched_by: ["visual", "speech", "sound"], // union, in the fixed order
    });
  });

  test("a long run jumps to its best moment, not its earliest", () => {
    // The real case: weak hits chained into a long run, with the match near its end.
    const results = mergeNearby([
      moment("a", 5, { score: 0.012 }),
      moment("a", 6, { score: 0.013 }),
      moment("a", 7, { score: 0.033 }),
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ start_s: 70, end_s: 79 });
  });

  test("one empty bucket between still merges, two don't", () => {
    // 16 → 18: gap 10s (merge). 18 → 21: gap 20s (split).
    const results = mergeNearby([moment("a", 16), moment("a", 18), moment("a", 21)]);
    expect(results.map((r) => r.start_s).sort((x, y) => x - y)).toEqual([160, 210]);
  });

  test("never merges across videos", () => {
    expect(mergeNearby([moment("a", 4), moment("b", 4)])).toHaveLength(2);
  });

  test("snippet and thumbnail come from the best moment that has one", () => {
    const [result] = mergeNearby([
      moment("a", 3, { score: 0.01, snippet: "weak", thumb_path: "weak.jpg" }),
      moment("a", 4, { score: 0.03 }), // best, but has neither
      moment("a", 5, { score: 0.02, snippet: "strong", thumb_path: "strong.jpg" }),
    ]);
    expect(result!.snippet).toBe("strong");
    expect(result!.thumb_path).toBe("strong.jpg");
  });

  test("results sorted by score and cut to the limit", () => {
    // Far apart (100s), so nothing merges.
    const moments = [1, 2, 3, 4].map((i) => moment("a", i * 10, { score: i / 100 }));
    const results = mergeNearby(moments, 10, 10, 2);
    expect(results.map((r) => r.score)).toEqual([0.04, 0.03]);
  });
});

describe("cutoff → RRF → merge (the whole pipeline)", () => {
  test("a nonsense query whose hits are all below the cutoffs returns nothing", () => {
    const lists = { visual: [hit("a", 0, { score: 0.21 })], sound: [hit("a", 40, { score: 0.26 })] };
    const kept = { visual: applyCutoff(lists.visual, 0.25), sound: applyCutoff(lists.sound, 0.44) };
    expect(mergeNearby(fuseRrf(kept))).toEqual([]);
  });
});
