// GET /search?q=...&debug=1 — find the moments in the videos that match a text query.
//
// Day 8 (this file): four retrievers, each on its own, each returning its top 20:
//
//   q ──CLIP text──▶ vector ──▶ frames   (nearest frame vectors)    "visual":  what is SHOWN
//     ──bge─────────▶ vector ──▶ segments (nearest transcript text)  "speech":  what is SAID (meaning)
//     ──(raw text)──────────────▶ segments (Postgres full-text)       "keyword": what is SAID (exact words)
//     ──CLAP text──▶ vector ──▶ sounds   (nearest 10s sound windows) "sound":   what is HEARD
//
// Day 9 adds a similarity cutoff per list, fuses the four lists with RRF into ONE ranked list
// and makes that the normal response. Until then only `?debug=1` (the four lists side by side,
// with scores) exists; without it the route answers 501 instead of pretending.

import { Router } from "express";
import { sql, toPgVector } from "@app/shared";
import { loadQueryEncoder } from "./encoders";

// How many results each retriever returns. Fusion (Day 9) only needs the top of each list.
const TOP_K = 20;
// Longer queries are almost certainly not a search (and CLIP reads only ~77 tokens anyway).
const MAX_QUERY_LENGTH = 200;

// One row per retriever. `score` is higher = better in every list, but the SCALES differ:
// the three vector lists give cosine similarity (−1..1), keyword gives ts_rank (0..~1, based
// on word counts). That's why Day 9 fuses by RANK (RRF) and never compares scores across lists.
type FrameHit = {
  video_id: string;
  title: string;
  ts_s: number; // when this frame is shown, in seconds
  thumb_path: string | null;
  score: number; // cosine similarity of the frame to the query
};
type SegmentHit = {
  video_id: string;
  title: string;
  start_s: number;
  end_s: number;
  text: string;
  score: number; // cosine similarity (speech) or ts_rank (keyword)
};
type SoundHit = {
  video_id: string;
  title: string;
  start_s: number;
  end_s: number;
  score: number; // cosine similarity of the 10s window to the query
};

// Load the query encoders once (seconds), then return the router.
export async function createSearchRouter(): Promise<Router> {
  const encodeQuery = await loadQueryEncoder();
  const router = Router();

  router.get("/", async (req, res) => {
    // req.query values can be a string, an array (?q=a&q=b) or missing, so check the type.
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length === 0 || q.length > MAX_QUERY_LENGTH) {
      res.status(400).json({ error: `q must be 1–${MAX_QUERY_LENGTH} characters` });
      return;
    }
    // 501 Not Implemented: fused results (the normal response) arrive on Day 9.
    if (req.query.debug !== "1") {
      res.status(501).json({ error: "fused results are not built yet (Day 9); add &debug=1" });
      return;
    }

    // 1. Embed the query with all three models (the slow part: tens of ms on CPU).
    let t = performance.now();
    const vectors = await encodeQuery(q);
    const embedMs = Math.round(performance.now() - t);

    // 2. Run the four retrievers at the same time. They don't depend on each other, and the
    //    SQL client sends them over separate pooled connections.
    t = performance.now();
    const [visual, speech, keyword, sound] = await Promise.all([
      searchFrames(toPgVector(vectors.clip)),
      searchSegments(toPgVector(vectors.bge)),
      searchKeyword(q),
      searchSounds(toPgVector(vectors.clap)),
    ]);
    const searchMs = Math.round(performance.now() - t);

    res.json({
      query: q,
      timings_ms: { embed: embedMs, search: searchMs },
      lists: { visual, speech, keyword, sound },
    });
  });

  return router;
}

// ---------- The four retrievers ----------
// The three vector searches have the same shape:
//
//   inner query:  ORDER BY embedding <=> query LIMIT 20   ← only this part touches the HNSW index
//   outer query:  JOIN videos for the title
//
// `<=>` is pgvector's COSINE DISTANCE (0 = same direction, 2 = opposite). It's the operator the
// HNSW indexes were built for (vector_cosine_ops); any other operator would skip the index and
// compare against every row. Similarity = 1 − distance, so higher = better.
// `${vector}::vector`: the query vector is sent as text "[0.1,...]"; the cast makes it a vector.
// The ORDER BY in the outer query keeps the order (a JOIN doesn't promise to keep it).

// "visual": frames whose CLIP image vector is closest to the CLIP text vector of the query.
function searchFrames(vector: string): Promise<FrameHit[]> {
  return sql`
    SELECT f.video_id, v.title, f.ts_s, f.thumb_path, 1 - f.distance AS score
    FROM (
      SELECT video_id, ts_s, thumb_path, embedding <=> ${vector}::vector AS distance
      FROM frames
      ORDER BY distance
      LIMIT ${TOP_K}
    ) f
    JOIN videos v ON v.id = f.video_id
    ORDER BY f.distance
  `;
}

// "speech": transcript windows whose bge vector is closest in MEANING to the query
// ("fixing a flat tyre" can find "repairing a puncture").
function searchSegments(vector: string): Promise<SegmentHit[]> {
  return sql`
    SELECT s.video_id, v.title, s.start_s, s.end_s, s.text, 1 - s.distance AS score
    FROM (
      SELECT video_id, start_s, end_s, text, embedding <=> ${vector}::vector AS distance
      FROM segments
      ORDER BY distance
      LIMIT ${TOP_K}
    ) s
    JOIN videos v ON v.id = s.video_id
    ORDER BY s.distance
  `;
}

// "keyword": transcript windows that contain the query's WORDS (after stemming), ranked by
// ts_rank. Finds exact names and rare words that embeddings blur ("RTX 4090").
// - websearch_to_tsquery: turns what a user types into a tsquery, Google-style:
//   `red car` = red AND car, `"red car"` = the phrase, `car -red` = car but NOT red, `or` works.
//   It never throws on odd input (to_tsquery would on "a & | b"), so it's safe for raw user text.
// - 'english': same stemming + stop words as the generated segments.tsv column, or they wouldn't match.
// - `tsv @@ query` = "does this text match?"; this is the part the GIN index speeds up.
// A query of only stop words ("the a") becomes an empty tsquery and simply matches nothing.
function searchKeyword(q: string): Promise<SegmentHit[]> {
  return sql`
    SELECT s.video_id, v.title, s.start_s, s.end_s, s.text, ts_rank(s.tsv, query) AS score
    FROM segments s
    CROSS JOIN websearch_to_tsquery('english', ${q}) AS query
    JOIN videos v ON v.id = s.video_id
    WHERE s.tsv @@ query
    ORDER BY score DESC, s.id
    LIMIT ${TOP_K}
  `;
}

// "sound": 10s sound windows whose CLAP audio vector is closest to the CLAP text vector.
function searchSounds(vector: string): Promise<SoundHit[]> {
  return sql`
    SELECT s.video_id, v.title, s.start_s, s.end_s, 1 - s.distance AS score
    FROM (
      SELECT video_id, start_s, end_s, embedding <=> ${vector}::vector AS distance
      FROM sounds
      ORDER BY distance
      LIMIT ${TOP_K}
    ) s
    JOIN videos v ON v.id = s.video_id
    ORDER BY s.distance
  `;
}
