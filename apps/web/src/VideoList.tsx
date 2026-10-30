// The list of uploaded videos with their processing status.
// While a video is "processing" it also shows which of the three workers are done, so you can
// watch them finish one by one. Clicking a title plays the video from the start (the mp4 is
// streamable as soon as the upload returns, even before the workers finish).
import type { VideoStatus, VideoSummary } from "./api";
import type { PlayTarget } from "./Player";
import { formatTime } from "./time";

const STATUS_STYLE: Record<VideoStatus, string> = {
  processing: "bg-yellow-100 text-yellow-800",
  ready: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
};

export function VideoList({
  videos,
  onPlay,
  onRemove,
}: {
  videos: VideoSummary[];
  onPlay: (target: PlayTarget) => void;
  onRemove: (video: VideoSummary) => void;
}) {
  if (videos.length === 0) {
    return <p className="text-sm text-gray-500">No videos yet. Upload one above.</p>;
  }

  return (
    <ul className="divide-y rounded border">
      {videos.map((v) => (
        <li key={v.id} className="p-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => onPlay({ videoId: v.id, title: v.title, startS: 0 })}
              className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
            >
              {v.title}
            </button>
            {v.duration_s !== null && (
              <span className="text-sm text-gray-500">{formatTime(v.duration_s)}</span>
            )}
            <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[v.status]}`}>{v.status}</span>
            <button
              type="button"
              onClick={() => onRemove(v)}
              className="text-xs text-gray-500 hover:text-red-600 hover:underline"
            >
              Remove
            </button>
          </div>
          {v.status === "processing" && (
            <p className="mt-1 text-xs text-gray-500">
              visual {v.visual_done ? "✓" : "…"} · speech {v.speech_done ? "✓" : "…"} · sound{" "}
              {v.sound_done ? "✓" : "…"}
            </p>
          )}
          {v.status === "failed" && v.error && <p className="mt-1 text-xs text-red-600">{v.error}</p>}
        </li>
      ))}
    </ul>
  );
}
