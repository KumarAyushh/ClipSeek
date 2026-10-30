// Scoring search results against labeled queries. Pure functions, so tests need no API or models.
//
// A result only counts if the PLAYER lands in the right place, not just if it names the right
// video: that's what the user feels, and correct timestamps are the point of this project.

// What the eval needs from one search result.
export type Moment = { title: string; start_s: number };

// One place a query should find. A query can have several ("dog" in two parts of a video).
export type Expected = { title: string; start_s: number; end_s: number };

// How early the player may land. A transcript window is 30s long, so a phrase said in the middle
// of one is ~15s after the window's start: you hear it after a short wait. Later than the end of
// the expected range is always a miss, because the moment has already passed.
export const TOLERANCE_S = 15;

export function isHit(moment: Moment, expected: Expected, toleranceS: number = TOLERANCE_S): boolean {
  return (
    moment.title === expected.title &&
    moment.start_s >= expected.start_s - toleranceS &&
    moment.start_s <= expected.end_s
  );
}

// Position (1 = best) of the first result that hits any expected place. null = none of them did.
export function firstHitRank(results: Moment[], expected: Expected[]): number | null {
  const i = results.findIndex((r) => expected.some((e) => isHit(r, e)));
  return i === -1 ? null : i + 1;
}

// Recall@k: the share of queries with a hit in the top k.
export function recallAtK(ranks: (number | null)[], k: number): number {
  if (ranks.length === 0) return 0;
  return ranks.filter((r) => r !== null && r <= k).length / ranks.length;
}

// MRR (Mean Reciprocal Rank): the average of 1 / rank, with a miss counting as 0.
// A hit at #1 scores 1, at #2 scores 0.5. So unlike recall it cares HOW HIGH the hit is.
export function meanReciprocalRank(ranks: (number | null)[]): number {
  if (ranks.length === 0) return 0;
  return ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) / ranks.length;
}
