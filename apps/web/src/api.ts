// Talking to the API. Every URL is relative ("/videos", "/search"): Vite's proxy
// (vite.config.ts) forwards them to Express, so the browser only ever talks to one origin.
//
// The types mirror the JSON the API sends (apps/api/src/videos.ts and search.ts). They are
// copied, not imported from @app/shared, because that package also exports the database
// client, which can't run in a browser. If an API response changes, change it here too.

export type VideoStatus = "processing" | "ready" | "failed";

// One item of GET /videos (the list leaves out metadata and file_path, see videos.ts).
export type VideoSummary = {
  id: string;
  title: string;
  duration_s: number | null;
  status: VideoStatus;
  visual_done: boolean;
  speech_done: boolean;
  sound_done: boolean;
  error: string | null;
  created_at: string; // a Date on the server; JSON turns it into an ISO string
};

// Which retriever found a result (same names as SOURCES in apps/api/src/fusion.ts).
export type Source = "visual" | "speech" | "keyword" | "sound";

// One item of GET /search: one moment of one video.
export type SearchResult = {
  video_id: string;
  title: string;
  start_s: number; // seconds; where the player should jump
  end_s: number;
  score: number; // RRF score (only useful for ordering)
  matched_by: Source[];
  snippet: string | null; // transcript text, if speech/keyword found it
  thumb_url: string | null; // e.g. "/thumbs/<videoId>/00081.jpg"
};

type SearchResponse = { query: string; results: SearchResult[] };

// fetch() only rejects on network errors; a 400 or 500 is a normal response to it.
// This turns any non-2xx into an Error carrying the API's own message (every error the API
// sends looks like { error: "..." }), so the UI can show WHY something failed.
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  // The body may not be JSON (e.g. the proxy's plain-text 502 when the API isn't running).
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  // A cast, not a check: we trust our own API to send the shape the types above describe.
  return body as T;
}

// GET /videos — all videos, newest first.
export function listVideos(): Promise<VideoSummary[]> {
  return request<VideoSummary[]>("/videos");
}

// POST /videos — multipart upload. Answers 201 with the new row (status "processing").
export function uploadVideo(file: File, title: string): Promise<VideoSummary> {
  const form = new FormData();
  // Title BEFORE the file: multer only sees text fields that arrive before the file part.
  if (title.trim()) form.append("title", title.trim());
  form.append("video", file); // field name must be "video" (upload.single("video") in videos.ts)
  // No Content-Type header on purpose: the browser sets multipart/form-data AND the boundary
  // string that separates the parts. Setting it by hand would leave the boundary out.
  return request<VideoSummary>("/videos", { method: "POST", body: form });
}

// GET /search?q=... — the fused top 10. encodeURIComponent so "&", "#", spaces etc. stay
// part of the query instead of breaking the URL.
export function searchVideos(q: string): Promise<SearchResponse> {
  return request<SearchResponse>(`/search?q=${encodeURIComponent(q)}`);
}

// The mp4 for a <video src>. The browser itself sends Range requests from here when seeking.
export function streamUrl(videoId: string): string {
  return `/videos/${videoId}/stream`;
}
