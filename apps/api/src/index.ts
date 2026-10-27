// HTTP API (Express). For now it only has a health check.
// Later days add: POST /videos (upload), GET /videos, GET /videos/:id,
// GET /videos/:id/stream and GET /search.

import express from "express";
import { config, sql } from "@app/shared";

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

app.listen(config.apiPort, () => {
  console.log(`api listening on http://localhost:${config.apiPort}`);
});
