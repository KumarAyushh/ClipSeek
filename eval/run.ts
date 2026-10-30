// Search eval: runs the labeled queries in queries.json against the running API and prints
// Recall@5 and MRR. Needs the API up and the videos in queries.json indexed.
//
//   bun run eval
//
// It prints three things:
// 1. Each query: the rank of the first hit (or MISS), and where the player landed.
// 2. The totals, also split by kind (visual / speech / sound).
// 3. Which retriever helps most: the same queries, re-fused from the raw lists with only one
//    retriever, then with one removed. Removing a retriever and losing a lot = it was needed.
// `negatives` are queries with no right answer: any result for them is a false match. They keep
// tuning honest, because a lower cutoff always raises recall if you don't count what it lets in.

import path from "node:path";
import { config } from "@app/shared";
import {
  applyCutoff,
  fuseRrf,
  type Hit,
  MIN_SCORE,
  mergeNearby,
  type Source,
  SOURCES,
} from "../apps/api/src/fusion";
import {
  type Expected,
  firstHitRank,
  meanReciprocalRank,
  type Moment,
  recallAtK,
} from "./metrics";

type Query = { q: string; kind: string; expect: Expected[]; note: string };
type EvalFile = { queries: Query[]; negatives: string[] };

// The parts of GET /search?debug=1 used here. Frames have ts_s; the other lists are already Hits.
type FrameRow = Omit<Hit, "start_s" | "end_s"> & { ts_s: number };
type SearchResponse = {
  results: Moment[];
  timings_ms: { embed: number; search: number; fuse: number };
  lists: { visual: FrameRow[]; speech: Hit[]; keyword: Hit[]; sound: Hit[] };
};

const API = `http://localhost:${config.apiPort}`;
const K = 5;

async function search(q: string): Promise<SearchResponse> {
  const res = await fetch(`${API}/search?debug=1&q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(`search for "${q}" failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as SearchResponse;
}

// The same steps as search.ts (cutoff → RRF → merge), but only over the chosen retrievers.
function fuseOnly(response: SearchResponse, sources: readonly Source[]): Moment[] {
  const { visual, ...others } = response.lists;
  // Same conversion as search.ts: a frame is an instant.
  const lists: Record<Source, Hit[]> = {
    ...others,
    visual: visual.map((f) => ({ ...f, start_s: f.ts_s, end_s: f.ts_s })),
  };
  const kept: Partial<Record<Source, Hit[]>> = {};
  for (const source of sources) kept[source] = applyCutoff(lists[source], MIN_SCORE[source]);
  return mergeNearby(fuseRrf(kept));
}

function row(label: string, ranks: (number | null)[]): string {
  const recall = recallAtK(ranks, K).toFixed(2);
  return `${label.padEnd(18)} Recall@${K} ${recall}   MRR ${meanReciprocalRank(ranks).toFixed(2)}   (${ranks.length} queries)`;
}

const file = path.join(import.meta.dir, "queries.json");
const { queries, negatives } = (await Bun.file(file).json()) as EvalFile;

// Run every query once; everything below reuses these responses.
const responses = new Map<string, SearchResponse>();
for (const { q } of queries) responses.set(q, await search(q));

console.log("--- queries ---");
const ranks = new Map<string, number | null>();
for (const { q, kind, expect } of queries) {
  const { results } = responses.get(q)!;
  const rank = firstHitRank(results, expect);
  ranks.set(q, rank);
  const landed = rank === null ? results[0] : results[rank - 1];
  const at = landed ? `${landed.title} @ ${landed.start_s.toFixed(1)}s` : "no results";
  console.log(`${(rank === null ? "MISS" : `#${rank}`).padEnd(5)} ${kind.padEnd(7)} ${q.padEnd(38)} ${at}`);
}

console.log("\n--- totals ---");
console.log(row("all", [...ranks.values()]));
for (const kind of new Set(queries.map((q) => q.kind))) {
  console.log(row(kind, queries.filter((q) => q.kind === kind).map((q) => ranks.get(q.q)!)));
}

console.log("\n--- which retriever helps most ---");
const rankWith = (sources: readonly Source[]) =>
  queries.map((q) => firstHitRank(fuseOnly(responses.get(q.q)!, sources), q.expect));
console.log(row("all four", rankWith(SOURCES)));
for (const source of SOURCES) console.log(row(`only ${source}`, rankWith([source])));
for (const source of SOURCES) {
  console.log(row(`without ${source}`, rankWith(SOURCES.filter((s) => s !== source))));
}

console.log("\n--- negatives (should find nothing) ---");
const falseMatches: string[] = [];
for (const q of negatives) {
  const { results } = await search(q);
  if (results.length > 0) falseMatches.push(`${q} (${results.length})`);
}
console.log(`${negatives.length - falseMatches.length}/${negatives.length} clean`);
if (falseMatches.length > 0) console.log(`false matches: ${falseMatches.join(", ")}`);

const avg = (pick: (r: SearchResponse) => number) =>
  [...responses.values()].reduce((sum, r) => sum + pick(r), 0) / responses.size;
console.log(
  `\nlatency: embed ${avg((r) => r.timings_ms.embed).toFixed(0)} ms,` +
    ` search ${avg((r) => r.timings_ms.search).toFixed(0)} ms,` +
    ` fuse ${avg((r) => r.timings_ms.fuse).toFixed(0)} ms`,
);
process.exit(0);
