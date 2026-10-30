// Turning the four retriever lists into ONE ranked list of moments.
//
//   visual  ─┐                      ┌─ 1. cutoff: drop hits below the list's minimum similarity
//   speech  ─┤                      │
//   keyword ─┼──▶ cutoff ──▶ RRF ───┼─ 2. RRF: every hit → key "video + 10s bucket";
//   sound   ─┘                      │     each list adds 1 / (60 + rank) to its buckets
//                                   └─ 3. merge: neighbouring buckets of one video → one result
//
// Why each step:
// 1. A vector list ALWAYS returns 20 hits, even for nonsense ("red car" still gets CLAP's best
//    sound). RRF rewards rank, not score, so without a cutoff that junk would get points too.
// 2. The lists can't be compared by score (cosine ~0.2–0.7 vs ts_rank ~0.1), only by RANK.
//    And they describe moments differently (a frame at 162s, a transcript window 155–185s,
//    a sound window 160–170s), so they need a common key to agree on "the same moment".
// 3. One scene usually lights up several buckets in a row (a 30s cat scene = 3 buckets).
//    Shown separately they'd fill the top 10 with the same scene.
//
// Pure functions only (no database, no models, no config), so unit tests can import this file
// without loading anything.

// The four retrievers, in a fixed order (also the order of `matched_by` in results).
export const SOURCES = ["visual", "speech", "keyword", "sound"] as const;
export type Source = (typeof SOURCES)[number];

// One hit from any retriever, in one shape. search.ts converts each list into this.
export type Hit = {
  video_id: string;
  title: string;
  start_s: number; // frames: the frame's time; segments/sounds: the window's start
  end_s: number; // frames: same as start_s (a frame is an instant)
  score: number; // higher = better; only compared WITHIN one list (the cutoff)
  text?: string; // transcript text (speech, keyword)
  thumb_path?: string; // frame jpg, relative to the storage dir (visual)
};

// Minimum similarity per list; hits below it are dropped before fusion. null = no cutoff.
// Set on Day 11 from real footage: 33 labeled queries + 8 with no right answer (eval/queries.json).
// The Day 9 values came from synthetic clips and were wrong on real video in both directions.
// Scores below are the weakest real match vs the strongest query with no right answer.
//   visual  (CLIP):  matches from 0.256, non-matches up to 0.268  → 0.27 (very thin margin: CLIP
//                    text↔image scores are low and close together)
//   speech  (bge):   matches from 0.582, non-matches up to 0.594  → 0.58 (0.60 lost two real
//                    matches to remove one false one)
//   keyword:         a keyword hit means the words are really there → no cutoff
//   sound   (CLAP):  matches from 0.325, non-matches up to 0.304  → 0.32 ("football match" still
//                    gets through at 0.493: CLAP hears the crowd in the JFK speech)
// These are rough values: tuning on half the queries gave different speech and sound numbers.
export const MIN_SCORE: Record<Source, number | null> = {
  visual: 0.27,
  speech: 0.58,
  keyword: null,
  sound: 0.32,
};

// RRF's k: score = Σ 1 / (k + rank). A big k (60, the value from the RRF paper) flattens the
// curve: rank 1 gives 1/61, rank 2 gives 1/62, so one list's #1 can't outweigh two lists agreeing.
export const RRF_K = 60;
// Size of the common time key. 10s = one CLAP window; frames (2s) and transcript windows (by
// their start) fall into exactly one bucket each.
export const BUCKET_S = 10;
// Two moments of the same video are merged when the gap between them is at most this
// (10s = one empty bucket between them is allowed).
export const MERGE_GAP_S = 10;
// How many results /search returns.
export const MAX_RESULTS = 10;

// One 10s bucket of one video, after RRF.
export type Moment = {
  video_id: string;
  title: string;
  bucket: number; // bucket index: bucket b covers [b × 10s, b × 10s + 10s)
  start_s: number; // earliest hit start in the bucket (where the player should jump)
  end_s: number; // latest hit end in the bucket (a transcript window can reach past the bucket)
  score: number; // RRF score: sum of 1 / (k + rank) over the lists that found it
  matched_by: Source[];
  snippet: string | null; // text of the best-ranked transcript hit, if any
  thumb_path: string | null; // jpg of the best-ranked frame hit, if any
};

// One result of /search: one or more neighbouring moments of one video.
// start_s is where the player jumps (the best moment), end_s where the last moment ends.
export type SearchResult = Omit<Moment, "bucket">;

// Step 1: keep only hits at or above the cutoff. Lists come sorted best-first, so this keeps
// a prefix of the list, and ranks stay meaningful.
export function applyCutoff(hits: Hit[], minScore: number | null): Hit[] {
  if (minScore === null) return hits;
  return hits.filter((h) => h.score >= minScore);
}

// Which bucket a time falls into: 0–9.99s → 0, 10–19.99s → 1, 162s → 16.
export function bucketOf(timeS: number, bucketS: number = BUCKET_S): number {
  return Math.floor(timeS / bucketS);
}

// Step 2: Reciprocal Rank Fusion on "video + bucket".
// `lists` must be sorted best-first (as the retrievers return them).
//
// Rank = position of the BUCKET in that list, not of the hit. The visual list often has several
// frames in one bucket (162s, 164s, 166s are all bucket 16); only the first (best) one counts,
// so a list votes at most once per moment. Otherwise a still scene with 5 near-identical frames
// would get 5 votes from one list and beat moments that two different lists agree on.
//
//   visual: [v1:16, v1:16, v1:17]  → bucket 16 rank 1, bucket 17 rank 2
//   sound:  [v1:16]                → bucket 16 rank 1
//   v1:16 = 1/61 + 1/61 = 0.0328,  v1:17 = 1/62 = 0.0161
export function fuseRrf(
  lists: Partial<Record<Source, Hit[]>>,
  k: number = RRF_K,
  bucketS: number = BUCKET_S,
): Moment[] {
  const moments = new Map<string, Moment>();
  // Rank of the transcript hit each moment's snippet came from (lower = better).
  const snippetRank = new Map<string, number>();

  for (const source of SOURCES) {
    const hits = lists[source] ?? [];
    const voted = new Set<string>(); // buckets this list has already given points to
    for (const hit of hits) {
      const bucket = bucketOf(hit.start_s, bucketS);
      const key = `${hit.video_id}:${bucket}`;
      let m = moments.get(key);
      if (!m) {
        m = {
          video_id: hit.video_id,
          title: hit.title,
          bucket,
          start_s: hit.start_s,
          end_s: hit.end_s,
          score: 0,
          matched_by: [],
          snippet: null,
          thumb_path: null,
        };
        moments.set(key, m);
      }
      // Every hit widens the moment's time range, even one that doesn't get to vote.
      m.start_s = Math.min(m.start_s, hit.start_s);
      m.end_s = Math.max(m.end_s, hit.end_s);
      if (voted.has(key)) continue;

      voted.add(key);
      const rank = voted.size; // 1 for this list's best bucket, 2 for the next, ...
      m.score += 1 / (k + rank);
      m.matched_by.push(source);
      // First frame seen for this bucket = the best one (visual is the only list with thumbs).
      if (hit.thumb_path && m.thumb_path === null) m.thumb_path = hit.thumb_path;
      // Speech and keyword both carry transcript text; show the one that ranked higher.
      if (hit.text !== undefined && rank < (snippetRank.get(key) ?? Infinity)) {
        m.snippet = hit.text;
        snippetRank.set(key, rank);
      }
    }
  }

  // Ties (same score) keep insertion order, because Array.sort is stable.
  return [...moments.values()].sort((a, b) => b.score - a.score);
}

// Step 3: merge moments of the same video that are close in time, then keep the best `limit`.
//
//   video v1, buckets after RRF:  16 (0.033)  17 (0.016)  19 (0.016)  25 (0.016)
//   gaps:                             0s          10s          50s
//   merged (gap ≤ 10s):          [16, 17, 19] → one result from 160s, score 0.033    [25] alone
//
// A merged result:
// - jumps to its BEST moment, not the earliest. Hits chain together, so a run can be long (one
//   query gave 48s–146s, with the real match at 103s) and its start can be a minute too early.
// - scores as its BEST moment (max, not sum: a long scene shouldn't beat a precise hit just
//   by being long)
// - takes its snippet and thumbnail from its best moment that has one
export function mergeNearby(
  moments: Moment[],
  gapS: number = MERGE_GAP_S,
  bucketS: number = BUCKET_S,
  limit: number = MAX_RESULTS,
): SearchResult[] {
  // Group by video, each group in time order.
  const byVideo = new Map<string, Moment[]>();
  for (const m of moments) {
    const group = byVideo.get(m.video_id) ?? [];
    group.push(m);
    byVideo.set(m.video_id, group);
  }

  const results: SearchResult[] = [];
  for (const group of byVideo.values()) {
    group.sort((a, b) => a.bucket - b.bucket);
    let run: Moment[] = [];
    for (const m of group) {
      const prev = run.at(-1);
      // Gap between the END of the previous bucket and the START of this one.
      // Neighbouring buckets (16, 17) → 0s; one empty bucket between (17, 19) → 10s.
      if (prev && (m.bucket - prev.bucket - 1) * bucketS > gapS) {
        results.push(mergeRun(run));
        run = [];
      }
      run.push(m);
    }
    if (run.length > 0) results.push(mergeRun(run));
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Combine one run of neighbouring moments (same video, time order) into one result.
function mergeRun(run: Moment[]): SearchResult {
  // Best first, so `find` returns the best moment that has a snippet / thumbnail.
  const best = [...run].sort((a, b) => b.score - a.score);
  return {
    video_id: run[0]!.video_id,
    title: run[0]!.title,
    start_s: best[0]!.start_s,
    end_s: Math.max(...run.map((m) => m.end_s)),
    score: best[0]!.score,
    // Every list that matched any part of the run, in the fixed SOURCES order.
    matched_by: SOURCES.filter((s) => run.some((m) => m.matched_by.includes(s))),
    snippet: best.find((m) => m.snippet !== null)?.snippet ?? null,
    thumb_path: best.find((m) => m.thumb_path !== null)?.thumb_path ?? null,
  };
}
