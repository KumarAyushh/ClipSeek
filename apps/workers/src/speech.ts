// Speech worker: turns what is SAID in a video into searchable transcript windows.
//
//   video.mp4 ──ffmpeg──▶ 16 kHz mono float samples
//             ──Whisper, word timestamps──▶ words: { text, start_s, end_s }
//             ──dropIsolatedWords()──▶ minus words Whisper invented in silence (transcript.ts)
//             ──groupIntoWindows()──▶ ~30s windows with 5s overlap (transcript.ts)
//             ──bge-small, 16 windows per call──▶ one 384-d vector per window
//             ──one transaction──▶ DELETE old segments rows, INSERT new ones
//
// Postgres fills segments.tsv (the keyword-search column) from `text` by itself.

import { sql } from "@app/shared";
import { hasAudioStream, readAudio } from "./audio";
import { withHeartbeat } from "./heartbeat";
import { loadTextEmbedder, loadWhisper } from "./models";
import type { Job, WorkerDef } from "./runner";
import { dropIsolatedWords, groupIntoWindows, type TranscriptWord } from "./transcript";
import { toPgVector, toVectors } from "./vectors";

// Whisper was trained on 16 kHz audio.
const SAMPLE_RATE = 16_000;
// How many windows go through bge in one call.
const BATCH_SIZE = 16;

// Whisper only reads 30s at a time. Without `chunk_length_s`, the pipeline would pad/cut the
// audio to 30s and silently ignore the rest of the video. With it, the pipeline cuts the audio
// into 30s pieces that overlap by 5s on each side, transcribes them one after another, and
// merges the overlaps so words at a cut aren't lost or doubled. Its timestamps are then
// counted from the start of the whole audio, not from the start of each piece.
// (These 30s "pieces" are Whisper's own work units; our 30s "windows" are a separate step.)
//
// return_timestamps: "word" → result.chunks = one entry per word: { text, timestamp: [start, end] }.
// With `true` we'd get one entry per phrase instead, but phrase times have no gaps: each
// phrase starts where the previous one ended, so silence before speech is counted as part of
// the speech. Tested: speech starting at 8s came back as [0, 15.04]; word mode said 8.72.
const WHISPER_OPTIONS = {
  return_timestamps: "word",
  chunk_length_s: 30,
  stride_length_s: 5,
} as const;

type Whisper = Awaited<ReturnType<typeof loadWhisper>>;

// Load Whisper + bge once, then return the worker (same pattern as createVisualWorker).
export async function createSpeechWorker(): Promise<WorkerDef> {
  const [whisper, bge] = await Promise.all([loadWhisper(), loadTextEmbedder()]);
  console.log("[speech] Whisper + bge loaded");

  async function process(job: Job): Promise<void> {
    const { videoId, filePath, heartbeat } = job;

    // 1. Audio. A video with no audio track can't contain speech: that's a real, correct
    //    "0 segments", not a hidden error, so we skip to saving (which still deletes old rows).
    let t = performance.now();
    const hasAudio = await hasAudioStream(videoId);
    const audio = hasAudio ? await readAudio(filePath, SAMPLE_RATE, heartbeat) : new Float32Array(0);
    const audioS = seconds(t);

    // 2. Transcribe. One call for the whole audio; this is the slow step (~2× faster than
    //    real time on CPU, so minutes for a long video). withHeartbeat keeps Kafka informed.
    t = performance.now();
    const allWords = hasAudio ? await transcribe(whisper, audio, heartbeat) : [];
    const words = dropIsolatedWords(allWords);
    const transcribeS = seconds(t);

    // 3. Group into ~30s windows, then embed them in batches: one bge call per batch of 16.
    t = performance.now();
    const windows = groupIntoWindows(words);
    const vectors: Float32Array[] = [];
    for (let i = 0; i < windows.length; i += BATCH_SIZE) {
      const texts = windows.slice(i, i + BATCH_SIZE).map((w) => w.text);
      // bge was trained to use the first token's ([CLS]) vector as the whole text's vector,
      // hence pooling "cls" (not "mean"). → Tensor [n, 384]; toVectors L2-normalizes each row.
      // No "Represent this sentence…" prefix here: bge only wants that on the QUERY (Day 8).
      const output = await bge(texts, { pooling: "cls" });
      vectors.push(...toVectors(output));
      await heartbeat();
    }
    const embedS = seconds(t);

    // 4. Save. Same as frames: DELETE + INSERT in one transaction, so a re-run (the same
    //    message delivered again) replaces the rows and search never sees half a video.
    t = performance.now();
    const rows = windows.map((w, i) => ({
      video_id: videoId,
      start_s: w.start_s,
      end_s: w.end_s,
      text: w.text,
      embedding: toPgVector(vectors[i]!),
    }));
    await sql.begin(async (tx) => {
      await tx`DELETE FROM segments WHERE video_id = ${videoId}`;
      // An INSERT needs at least one row, so skip it for a silent video.
      if (rows.length > 0) await tx`INSERT INTO segments ${tx(rows)}`;
    });
    const saveS = seconds(t);

    const audioLength = (audio.length / SAMPLE_RATE).toFixed(0);
    console.log(
      `[speech] ${videoId}: ${audioLength}s audio → ${words.length} words` +
        ` (${allWords.length - words.length} isolated dropped) → ${rows.length} segments` +
        ` | audio ${audioS}s | transcribe ${transcribeS}s | embed ${embedS}s | save ${saveS}s`,
    );
  }

  return { name: "speech", process };
}

// Run Whisper on the whole audio and return its words with clean times and text.
async function transcribe(
  whisper: Whisper,
  audio: Float32Array,
  heartbeat: () => Promise<void>,
): Promise<TranscriptWord[]> {
  // One input (not a list) → one result object. TypeScript knows this from the input type.
  const result = await withHeartbeat(whisper(audio, WHISPER_OPTIONS), heartbeat);
  const durationS = audio.length / SAMPLE_RATE;
  // Whisper's times can land slightly past the real end (tested: 120.96s on a 120s video).
  // Clamp them so a search hit never points past the end of the video.
  const clamp = (s: number) => Math.min(s, durationS);

  return (result.chunks ?? [])
    .map(({ text, timestamp: [start, end] }) => ({
      text: text.trim(), // Whisper puts a space in front of each word
      start_s: clamp(start),
      // The types say `end` is always a number, but if the audio stops mid-word Whisper can
      // return null for the last word's end. Then the word runs to the end of the audio.
      end_s: clamp(end ?? durationS),
    }))
    .filter((w) => w.text.length > 0);
}

// Seconds since `start`, rounded to 0.1, for the timing log.
function seconds(start: number): string {
  return ((performance.now() - start) / 1000).toFixed(1);
}
