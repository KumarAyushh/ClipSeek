// The whole app on one page (no router needed for 3 sections):
//   Player   — shown once something is picked; jumps to the chosen time
//   Search   — search box + results; clicking a result opens the Player there
//   Videos   — upload form + the video list with its processing status
// App owns the state the sections share: the video list and what the Player is playing.
import { useCallback, useEffect, useState } from "react";
import { deleteVideo, listVideos, type VideoSummary } from "./api";
import { type PlayTarget, Player } from "./Player";
import { Search } from "./Search";
import { UploadForm } from "./UploadForm";
import { VideoList } from "./VideoList";

// How often to re-check the list while a video is processing. Workers take tens of seconds
// to minutes per video, so every 3s is quick enough to feel live and cheap for the API.
const POLL_MS = 3000;

export default function App() {
  const [videos, setVideos] = useState<VideoSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [playing, setPlaying] = useState<PlayTarget | null>(null);

  // useCallback keeps the same function between renders, so the effects below that depend
  // on it don't restart on every render.
  const refresh = useCallback(async () => {
    try {
      setVideos(await listVideos());
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Remove a video. It can't be undone, so ask first (the browser's built-in dialog is enough).
  async function handleRemove(video: VideoSummary) {
    if (!window.confirm(`Remove "${video.title}"? This deletes the video and its search data.`)) return;
    try {
      await deleteVideo(video.id);
      // Close the player if it was showing this video: its file is gone now.
      setPlaying((current) => (current?.videoId === video.id ? null : current));
      await refresh();
    } catch (err) {
      setListError(err instanceof Error ? err.message : String(err));
    }
  }

  // Load the list once when the page opens.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Status polling: while ANY video is still processing, re-fetch the list every POLL_MS.
  // When the last one turns ready/failed, anyProcessing becomes false, the effect re-runs,
  // its cleanup clears the interval, and polling stops. An upload starts it again.
  const anyProcessing = videos.some((v) => v.status === "processing");
  useEffect(() => {
    if (!anyProcessing) return;
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [anyProcessing, refresh]);

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-6">
      <header>
        <h1 className="text-3xl font-bold">ClipSeek</h1>
        <p className="mt-1 text-gray-600">Search inside your videos by what is shown, said or heard.</p>
      </header>

      {playing && <Player target={playing} />}

      <section>
        <Search onPlay={setPlaying} />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Videos</h2>
        <UploadForm onUploaded={() => void refresh()} />
        {listError && <p className="text-sm text-red-600">{listError}</p>}
        <VideoList videos={videos} onPlay={setPlaying} onRemove={(v) => void handleRemove(v)} />
      </section>
    </main>
  );
}
