// Search box + result list. One result = one moment: thumbnail, video title, start time,
// which retrievers found it (badges) and the transcript snippet if speech/keyword matched.
// Clicking a result hands { video, start time } to App, which opens the Player there.
import { type FormEvent, useState } from "react";
import { type SearchResult, type Source, searchVideos } from "./api";
import type { PlayTarget } from "./Player";
import { formatTime } from "./time";

// One badge per retriever. The tooltip says in plain words what each kind of match means.
const BADGES: Record<Source, { className: string; tooltip: string }> = {
  visual: { className: "bg-purple-100 text-purple-800", tooltip: "shown on screen (CLIP)" },
  speech: { className: "bg-blue-100 text-blue-800", tooltip: "said, by meaning (bge)" },
  keyword: { className: "bg-sky-100 text-sky-800", tooltip: "said, exact words (full-text)" },
  sound: { className: "bg-orange-100 text-orange-800", tooltip: "heard (CLAP)" },
};

export function Search({ onPlay }: { onPlay: (target: PlayTarget) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  // The query the shown results belong to (null = nothing searched yet), so "no matches for X"
  // names what was searched, not what is being typed now.
  const [searched, setSearched] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); // stop the browser's own form submit (a full page reload)
    const query = q.trim();
    if (!query) return;
    setLoading(true);
    setError(null);
    try {
      const res = await searchVideos(query);
      setResults(res.results);
      setSearched(res.query);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults([]);
      setSearched(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="search"
          placeholder='Try "dog barking", "cats" or a phrase someone says'
          value={q}
          onChange={(e) => setQ(e.target.value)}
          maxLength={200} // same limit as the API (MAX_QUERY_LENGTH in search.ts)
          className="flex-1 rounded border px-3 py-2"
        />
        <button
          type="submit"
          // Disabled while a search runs, so an older, slower answer can't overwrite a newer one
          disabled={loading || !q.trim()}
          className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-40"
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && <p className="text-sm text-red-600">Search failed: {error}</p>}
      {searched !== null && results.length === 0 && (
        <p className="text-sm text-gray-500">No matches for “{searched}”.</p>
      )}

      <ul className="divide-y rounded border empty:hidden">
        {results.map((r) => (
          // video + start time is unique: merged results of one video never share a start
          <li key={`${r.video_id}-${r.start_s}`}>
            <button
              type="button"
              onClick={() => onPlay({ videoId: r.video_id, title: r.title, startS: r.start_s })}
              className="flex w-full gap-3 p-2 text-left hover:bg-gray-50"
            >
              {r.thumb_url ? (
                <img src={r.thumb_url} alt="" className="h-20 w-32 flex-none rounded bg-gray-200 object-cover" />
              ) : (
                // no frames for this video (e.g. visual worker not done yet): keep the layout
                <div className="h-20 w-32 flex-none rounded bg-gray-200" />
              )}
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {r.title} <span className="font-mono text-blue-700">{formatTime(r.start_s)}</span>
                </p>
                <div className="mt-1 flex gap-1">
                  {r.matched_by.map((s) => (
                    <span key={s} title={BADGES[s].tooltip} className={`rounded px-2 py-0.5 text-xs ${BADGES[s].className}`}>
                      {s}
                    </span>
                  ))}
                </div>
                {/* a transcript window is ~30s of speech, so show 2 lines at most */}
                {r.snippet && <p className="mt-1 line-clamp-2 text-sm text-gray-600">{r.snippet}</p>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
