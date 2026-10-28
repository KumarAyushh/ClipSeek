// HTTP API (Express).
// Routes: GET /health, /videos (upload, list, details, stream) from ./videos,
// GET /thumbs/... (frame thumbnails) and GET /search from ./search.

import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config, sql } from "@app/shared";
import { producer } from "./kafka";
import { createSearchRouter } from "./search";
import { videosRouter } from "./videos";

const app = express();

// Parse JSON request bodies into req.body
app.use(express.json());

// GET /health — quick "is everything up?" check.
// Runs a trivial query so it also proves the database connection works.
app.get("/health", async (_req, res) => {
  try {
    await sql`SELECT 1`;
    res.json({ ok: true, db: "up" });
  } catch (err) {
    // 503 = Service Unavailable: the API runs, but something it needs doesn't
    res.status(503).json({ ok: false, db: "down", error: String(err) });
  }
});

app.use("/videos", videosRouter);
// GET /thumbs/<videoId>/00081.jpg — the frame jpgs the visual worker wrote, used as search
// result thumbnails. Only storage/thumbs is served (not videos/ or models/), and
// express.static refuses paths with ".." that would climb out of it.
app.use("/thumbs", express.static(path.join(config.storageDir, "thumbs")));
// Loads the three text encoders (CLIP, bge, CLAP) once, here at startup, so the first search
// isn't slow and a broken model crashes the API now instead of failing every search later.
app.use("/search", await createSearchRouter());

// Error handler: Express calls this when a route throws (Express 5 also catches
// rejected promises from async routes). It must take 4 arguments to count as one.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  // Response already half-sent (e.g. stream cut off) → let Express close the connection.
  if (res.headersSent) {
    next(err);
    return;
  }
  // Upload problems from multer: file too big → 413 Payload Too Large, others → 400.
  if (err instanceof multer.MulterError) {
    res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.message });
    return;
  }
  // Errors that carry their own HTTP status (e.g. sendFile's 404 when the file is gone).
  const status =
    typeof err === "object" && err !== null && "status" in err && typeof err.status === "number"
      ? err.status
      : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
});

// Connect to Kafka before accepting requests. If Kafka is down the API crashes here,
// loudly, instead of accepting uploads it can't hand to the workers.
// (Top-level await works because this is an ES module.)
await producer.connect();

app.listen(config.apiPort, () => {
  console.log(`api listening on http://localhost:${config.apiPort}`);
});
