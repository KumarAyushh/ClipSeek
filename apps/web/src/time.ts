// Seconds → "m:ss", or "h:mm:ss" past an hour, for showing timestamps.
//   150.4 → "2:30"    7 → "0:07"    3725 → "1:02:05"
// Rounds DOWN, so the label never shows a later time than where the player jumps.
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const ss = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
