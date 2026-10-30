// GET /search?q=...[&debug=1] — find the moments in the videos that match a text query.
//
// Four retrievers, each on its own, each returning its top 20:
//
//   q ──CLIP text──▶ vector ──▶ frames   (nearest frame vectors)    "visual":  what is SHOWN
//     ──bge─────────▶ vector ──▶ segments (nearest transcript text)  "speech":  what is SAID (meaning)
//     ──(raw text)──────────────▶ segments (Postgres full-text)       "keyword": what is SAID (exact words)
//     ──CLAP text──▶ vector ──▶ sounds   (nearest 10s sound windows) "sound":   what is HEARD
//
// Then fusion.ts turns the four lists into ONE ranked list: cutoff per list → RRF on
// "video + 10s bucket" → merge neighbouring buckets → top 10 results.
// `?debug=1` also returns the four raw lists (before the cutoff) with their scores, the
// cutoffs and timings, to see WHY a result ranked where it did.
//
// One exception: a query like "person talking" asks whether someone speaks, not what they say,
// so the speech list is replaced by the moments that have a transcript (speechQuery.ts).

import { Router } from "express";
import { sql, toPgVector } from "@app/shared";
import { loadQueryEncoder } from "./encoders";
import {
  applyCutoff,
  fuseRrf,
  type Hit,
  MIN_SCORE,
  mergeNearby,
  type SearchResult,
  type Source,
  SOURCES,
} from "./fusion";
import { asksOnlyForSpeech } from "./speechQuery";

// How many results each retriever returns. Fusion (Day 9) only needs the top of each list.
const TOP_K = 20;
// Longer queries are almost certainly not a search (and CLIP reads only ~77 tokens anyway).
const MAX_QUERY_LENGTH = 200;

// One row per retriever. `score` is higher = better in every list, but the SCALES differ:
// the three vector lists give cosine similarity (−1..1), keyword gives ts_rank (0..~1, based
// on word counts). That's why fusion goes by RANK (RRF) and never compares scores across lists.
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

// One result in the response. thumb_url is served by the /thumbs static route (index.ts).
type ResultBody = Omit<SearchResult, "thumb_path"> & { thumb_url: string | null };

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
    const debug = req.query.debug === "1";

    // 1. Embed the query with all three models (the slow part: tens of ms on CPU).
    let t = performance.now();
    const vectors = await encodeQuery(q);
    const embedMs = Math.round(performance.now() - t);

    // 2. Run the four retrievers at the same time. They don't depend on each other, and the
    //    SQL client sends them over separate pooled connections.
    t = performance.now();
    const [visual, speech, keyword, sound] = await Promise.all([
      searchFrames(toPgVector(vectors.clip)),
      // "person talking": comparing its MEANING with what people said is pointless, so the
      // speech list becomes the moments where someone speaks (see speechQuery.ts).
      asksOnlyForSpeech(q) ? searchSpeechMoments() : searchSegments(toPgVector(vectors.bge)),
      searchKeyword(q),
      searchSounds(toPgVector(vectors.clap)),
    ]);
    const searchMs = Math.round(performance.now() - t);

    // 3. Fuse (pure code in fusion.ts, ~0 ms). First put every list into the one Hit shape:
    //    a frame is an instant, so its start and end are both ts_s. Segment and sound rows
    //    already have start_s / end_s (and text) under the same names.
    t = performance.now();
    const lists: Record<Source, Hit[]> = {
      visual: visual.map((f) => ({
        video_id: f.video_id,
        title: f.title,
        start_s: f.ts_s,
        end_s: f.ts_s,
        score: f.score,
        thumb_path: f.thumb_path ?? undefined,
      })),
      speech,
      keyword,
      sound,
    };
    // Cutoff each list with its own minimum (scores are only comparable within one list).
    const kept: Partial<Record<Source, Hit[]>> = {};
    for (const source of SOURCES) kept[source] = applyCutoff(lists[source], MIN_SCORE[source]);
    const fused = mergeNearby(fuseRrf(kept));

    // 4. Results found without a matching frame (only said or heard) get the frame nearest
    //    to their start as a thumbnail. ≤ 10 tiny queries, run together.
    const results: ResultBody[] = await Promise.all(
      fused.map(async ({ thumb_path, ...r }) => {
        const thumb = thumb_path ?? (await nearestThumb(r.video_id, r.start_s));
        // thumb_path is relative to the storage dir ("thumbs/<id>/00081.jpg"), and /thumbs
        // serves storage/thumbs, so the URL is the same path with a leading slash.
        return { ...r, thumb_url: thumb ? `/${thumb}` : null };
      }),
    );
    const fuseMs = Math.round(performance.now() - t);

    if (!debug) {
      res.json({ query: q, results });
      return;
    }
    res.json({
      query: q,
      results,
      timings_ms: { embed: embedMs, search: searchMs, fuse: fuseMs },
      cutoffs: MIN_SCORE,
      lists: { visual, speech, keyword, sound }, // raw lists, BEFORE the cutoff
    });
  });

  return router;
}

// The frame closest to `timeS` in one video (frames are 2s apart, so ≤ 1s away).
// null if the video has no frames. Uses the frames.video_id index; ≤ 150 rows per 5-min video.
async function nearestThumb(videoId: string, timeS: number): Promise<string | null> {
  const rows: { thumb_path: string | null }[] = await sql`
    SELECT thumb_path
    FROM frames
    WHERE video_id = ${videoId}
    ORDER BY abs(ts_s - ${timeS}::real)
    LIMIT 1
  `;
  return rows[0]?.thumb_path ?? null;
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

// Where does someone talk at all? Not a fifth retriever: it replaces the speech list for queries
// like "person talking". There's no query to compare with, so to share the 20 places fairly it
// takes the 1st window of every video, then the 2nd of every video, and so on (row_number numbers
// each video's windows in time order). score = 1 passes the cutoff: a transcript window means
// someone really spoke there.
function searchSpeechMoments(): Promise<SegmentHit[]> {
  return sql`
    SELECT s.video_id, v.title, s.start_s, s.end_s, s.text, 1 AS score
    FROM (
      SELECT video_id, start_s, end_s, text,
             row_number() OVER (PARTITION BY video_id ORDER BY start_s) AS nth
      FROM segments
    ) s
    JOIN videos v ON v.id = s.video_id
    ORDER BY s.nth, v.created_at DESC
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
