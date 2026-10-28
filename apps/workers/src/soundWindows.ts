// Cutting a video's audio into 10s windows for CLAP.
//
// CLAP hears 10 seconds at a time. One vector for a whole track would describe only a random
// 10s slice of it (CLAP's processor crops anything longer at a RANDOM spot), and it would lose
// WHEN a sound happens. So we cut the audio into back-to-back 10s windows, and each window
// becomes one `sounds` row with its own start_s / end_s:
//
//   audio:    |------------- 34.5s -------------|
//   windows:  [0,10) [10,20) [20,30) [30,34.5)     ← the last one is shorter; CLAP's processor
//                                                     fills it up to 10s by repeating it
//
// No overlap (unlike transcript windows): sounds are short, and search fuses hits into 10s
// buckets anyway (Day 9), so overlapping windows would mostly produce duplicate hits.
//
// Pure function only (no database, no models, no config), so Day 9's unit tests can import
// this file without loading anything.

// CLAP's window length (its processor's max_length_s is 10).
export const SOUND_WINDOW_S = 10;
// A last piece shorter than this is dropped. Repeated 10+ times to fill 10s, it would be
// mostly an echo of itself, and a sound that short at the very end is rarely worth finding.
export const MIN_SOUND_WINDOW_S = 1;

// One window = one CLAP input = one `sounds` row.
export type SoundWindow = {
  start_s: number;
  end_s: number;
  // Sample positions [from, to) in the audio array: audio.subarray(from, to) is this window.
  from: number;
  to: number;
};

// Split `sampleCount` samples (at `sampleRate` per second) into windows of `windowS` seconds.
// We count in whole samples (integers), not seconds, so floating-point rounding can never make
// a window one sample too long or leave a gap between windows. Seconds are computed at the end:
// sample i is at i / sampleRate seconds (e.g. sample 480000 at 48 kHz = 10s).
export function soundWindows(
  sampleCount: number,
  sampleRate: number,
  windowS: number = SOUND_WINDOW_S,
  minS: number = MIN_SOUND_WINDOW_S,
): SoundWindow[] {
  const size = Math.round(windowS * sampleRate); // 10s at 48 kHz = 480000 samples
  const minSize = Math.round(minS * sampleRate);
  const windows: SoundWindow[] = [];

  for (let from = 0; from < sampleCount; from += size) {
    const to = Math.min(from + size, sampleCount); // the last window stops at the end of the audio
    if (to - from < minSize) break; // only the last piece can be this short
    windows.push({ start_s: from / sampleRate, end_s: to / sampleRate, from, to });
  }
  return windows;
}
