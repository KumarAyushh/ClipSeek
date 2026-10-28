// Turning Whisper's timestamped words into ~30s windows for search.
//
// We ask Whisper for one timestamp per WORD (not per phrase): phrase timestamps have no gaps,
// so a pause before speech gets glued onto the next phrase and a search hit would jump to the
// start of the silence instead of the speech (see the Decisions log, 2026-10-28).
//
// One word is far too little text for a good embedding, and one vector for the whole
// transcript would blur every topic together and lose WHERE things were said. So we group
// words into ~30s windows, and each window becomes one `segments` row with its own
// start_s / end_s.
//
// Pure functions only (no database, no models, no config), so Day 9's unit tests can import
// this file without loading anything.

// One word from Whisper, with times in seconds from the start of the video.
export type TranscriptWord = {
  text: string;
  start_s: number;
  end_s: number;
};

// One window = what gets embedded and stored as a `segments` row.
export type TranscriptWindow = {
  start_s: number; // start of its first word
  end_s: number; // end of its last word
  text: string; // its words joined with spaces
};

// Window length and how much consecutive windows share.
export const WINDOW_S = 30;
export const OVERLAP_S = 5;
// A word with at least this much silence before AND after it is treated as made up.
export const ISOLATED_GAP_S = 3;

// Remove words that stand alone in silence. On silence or music Whisper tends to invent a
// short word (most often "you"), and since it's the first "speech" it would pull a window's
// start_s back into the silence. Real speech has other words within a second or two, so a
// word with ≥ 3s of nothing on BOTH sides is almost always one of these.
// (Cost: a genuine one-word answer between two long pauses is dropped too. Rare, acceptable.)
// The first word has no word before it, so its "gap before" counts as infinite (same for the last).
export function dropIsolatedWords(
  words: TranscriptWord[],
  gapS: number = ISOLATED_GAP_S,
): TranscriptWord[] {
  const sorted = [...words].sort((a, b) => a.start_s - b.start_s);
  return sorted.filter((w, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    const gapBefore = prev ? w.start_s - prev.end_s : Infinity;
    const gapAfter = next ? next.start_s - w.end_s : Infinity;
    return gapBefore < gapS || gapAfter < gapS; // keep it if it has a close neighbour
  });
}

// Group words into windows. Window k covers the time range [k × 25s, k × 25s + 30s) and
// collects every word that is being spoken at some moment inside it. Windows start 25s
// apart but are 30s long, so any word spoken during a 5s band (25–30s, 50–55s, ...) is in
// both neighbouring windows: that's the overlap. A sentence said around a window border is
// therefore whole in at least one window.
//
//   words:    a b c d e f g h i j k l m n o p q r s t u
//   window 0: [0s ................. 30s)                 → a … j
//   window 1:                [25s ................. 55s) → h … u   (h, i, j are in both)
//
// - A window's times come from its words (first start, last end), not from k × 25,
//   so a search hit points at when the speech really starts, not at a grid line.
// - Windows with no words (silence) are skipped.
// - A window with no NEW word (all of its words were already in the previous window)
//   is skipped too, so we never store the same text twice.
export function groupIntoWindows(
  words: TranscriptWord[],
  windowS: number = WINDOW_S,
  overlapS: number = OVERLAP_S,
): TranscriptWindow[] {
  // Sort by start time so text comes out in spoken order and "a later index" = "said later".
  const sorted = [...words].sort((a, b) => a.start_s - b.start_s);
  const last = sorted.at(-1);
  if (!last) return [];

  const step = windowS - overlapS; // 25s between window starts
  const windows: TranscriptWindow[] = [];
  let lastUsed = -1; // index of the latest word already put in some window

  for (let from = 0; from <= last.start_s; from += step) {
    const to = from + windowS;
    // Indices of the words spoken inside [from, to): they start before the window ends,
    // and either start inside it or are still going when it begins. (Written this way, not
    // just `end_s > from`, so a zero-length word sitting exactly on `from` isn't lost.)
    const inWindow = sorted.flatMap((w, i) =>
      w.start_s < to && (w.start_s >= from || w.end_s > from) ? [i] : [],
    );
    const newest = inWindow.at(-1);
    if (newest === undefined) continue; // silence: nothing spoken in this window
    if (newest <= lastUsed) continue; // nothing new: every word was in the previous window

    const members = inWindow.map((i) => sorted[i]!);
    windows.push({
      start_s: members[0]!.start_s,
      end_s: Math.max(...members.map((w) => w.end_s)),
      text: members.map((w) => w.text).join(" "),
    });
    lastUsed = newest;
  }
  return windows;
}
