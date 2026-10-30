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
// Whisper also makes things up on non-speech audio (beeps, barks, silence), so three cleanups
// run around the windowing. All three come from what it did on real videos, see fixWordTimes(),
// dropIsolatedPhrases() and dropUnheardWindows().
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
  zero_length_share: number; // how many of its words have no length, 0 to 1 (see dropUnheardWindows)
};

// Window length and how much consecutive windows share.
export const WINDOW_S = 30;
export const OVERLAP_S = 5;
// No spoken word lasts longer than this. Longer means Whisper stretched it over a pause.
export const MAX_WORD_S = 2;
// A phrase is a run of words with less than this much silence between them.
export const ISOLATED_GAP_S = 3;
// A phrase of at most this many words, alone between two silences, is treated as made up.
export const MAX_ISOLATED_WORDS = 3;
// A word shorter than this has no real length: Whisper couldn't place it in the audio.
export const ZERO_LENGTH_S = 0.01;
// A window where at least this share of the words have no length is treated as made up.
export const MAX_ZERO_LENGTH_SHARE = 0.5;

// Repair impossible word times. Whisper can stretch a word over a whole pause (tested: a made-up
// "I'm" at [21.4s, 49.38s]) and once returned an end before the start ([169.98s, 140s]).
// Left alone, that 28s word counts as "spoken" inside every window it crosses, so the window
// holding the real speech at 50s starts at 21.4s and search jumps 28s too early.
// Only end_s changes: the word still starts when Whisper says it does.
export function fixWordTimes(
  words: TranscriptWord[],
  maxWordS: number = MAX_WORD_S,
): TranscriptWord[] {
  return words.map((w) => ({
    ...w,
    end_s: Math.min(Math.max(w.end_s, w.start_s), w.start_s + maxWordS),
  }));
}

// Remove short phrases that stand alone in silence. On silence or short noises Whisper tends to
// invent a few words ("you", "you I'm", "The End."), and since they're the first "speech" they
// would pull a window's start_s back into the silence. Real speech has other words within a
// second or two, so ≤ 3 words with ≥ 3s of nothing on BOTH sides are almost always made up.
// (Cost: a real "Yes, sir." between two long pauses is dropped too. Rare, and a window of two
// words wouldn't be found by search anyway.)
export function dropIsolatedPhrases(
  words: TranscriptWord[],
  gapS: number = ISOLATED_GAP_S,
  maxWords: number = MAX_ISOLATED_WORDS,
): TranscriptWord[] {
  const sorted = [...words].sort((a, b) => a.start_s - b.start_s);
  const kept: TranscriptWord[] = [];
  let phrase: TranscriptWord[] = [];
  let phraseEnd = -Infinity; // the latest end_s in the phrase so far

  for (const w of sorted) {
    // A long enough silence ends the phrase: keep it only if it had enough words.
    if (w.start_s - phraseEnd >= gapS) {
      if (phrase.length > maxWords) kept.push(...phrase);
      phrase = [];
    }
    phrase.push(w);
    phraseEnd = Math.max(phraseEnd, w.end_s);
  }
  if (phrase.length > maxWords) kept.push(...phrase); // the last phrase has no silence after it
  return kept;
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
      zero_length_share:
        members.filter((w) => w.end_s - w.start_s < ZERO_LENGTH_S).length / members.length,
    });
    lastUsed = newest;
  }
  return windows;
}

// Remove windows Whisper didn't really hear. On music or noise it makes text up, and its word
// timing can't find those words in the audio, so they come back with no length: "ahead and get
// started." was four words at [87.0s, 87.0s]. Often it also falls into a loop ("I'm not going to do
// this. I'm not going to do this. ...") that fills whole windows.
// Tested on 6 videos: real speech had 0–10% zero-length words per window, made-up text 50–100%.
//
// It judges whole windows on purpose. Deleting the zero-length words one by one was worse: what's
// left of a loop ("this. this. I'm this.") still got stored, and real sentences lost words.
// (Cost: real words inside a mostly made-up window go with it. The overlap with the neighbouring
// window saves some of them.)
export function dropUnheardWindows(
  windows: TranscriptWindow[],
  maxShare: number = MAX_ZERO_LENGTH_SHARE,
): TranscriptWindow[] {
  return windows.filter((w) => w.zero_length_share < maxShare);
}
