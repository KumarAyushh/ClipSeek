// Frame timestamp math for the visual worker.
//
// In its own file with no imports (visual.ts loads the config and CLIP), so unit tests can
// check the timestamps without loading anything.

// 1 frame every 2 seconds (ffmpeg's fps=0.5). Enough for search, and a 5-min video = 150 frames.
export const FRAME_INTERVAL_S = 2;

// Frame i (0-based) is at i × 2 seconds. Timestamps are always SECONDS, never the raw index.
export function frameTimeS(index: number): number {
  return index * FRAME_INTERVAL_S;
}

// ffmpeg names the jpgs by frame index (00000.jpg, 00001.jpg, ...; `-start_number 0`).
// The index comes from the file name, not a loop counter, so the timestamp is tied to the
// exact jpg it describes: "00050.jpg" → 50 → 100s.
export function frameFileTimeS(fileName: string): number {
  return frameTimeS(Number.parseInt(fileName, 10));
}
