// The video player. It gets a target { video, start time } and jumps there by setting
// <video>.currentTime. The browser then asks the stream route for just that part of the file
// (a Range request → 206 Partial Content), so it doesn't download everything before it.
import { useEffect, useRef } from "react";
import { streamUrl } from "./api";
import { formatTime } from "./time";

export type PlayTarget = {
  videoId: string;
  title: string;
  startS: number; // seconds
};

export function Player({ target }: { target: PlayTarget }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  // Runs after every NEW target, i.e. every click: App makes a new object each time, so even
  // clicking the same result twice jumps back to its start.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Bring the player into view (the clicked result may be far down the page).
    video.scrollIntoView({ behavior: "smooth", block: "start" });

    function seek() {
      if (!video) return;
      video.currentTime = target.startS;
      // play() returns a promise that rejects if the browser blocks autoplay. Nothing is lost
      // then: the player just stays paused at the right time and the user presses play.
      video.play().catch(() => {});
    }

    // Seeking needs the duration, which comes with the file's metadata.
    // - Same video as before: the metadata is already there → jump now.
    // - New video: React just changed `src`, which resets readyState to HAVE_NOTHING, so wait
    //   for "loadedmetadata". The cleanup removes the listener if another click comes first.
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      seek();
      return;
    }
    video.addEventListener("loadedmetadata", seek, { once: true });
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [target]);

  return (
    <div className="space-y-2">
      <p className="font-medium">
        {target.title} <span className="font-mono text-sm text-gray-500">from {formatTime(target.startS)}</span>
      </p>
      {/* preload="metadata": fetch only the header (duration, size) until the user plays */}
      <video
        ref={videoRef}
        src={streamUrl(target.videoId)}
        controls
        preload="metadata"
        className="w-full rounded bg-black"
      />
    </div>
  );
}
