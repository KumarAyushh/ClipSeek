// Spotting queries that ask WHETHER someone is speaking, not WHAT they say.
//
// "person talking" fails on all four retrievers:
// - bge and keyword compare the query with the WORDS in the transcript, and nobody says "person
//   talking" out loud.
// - CLAP should hear it, but can't: on a video with a talk at 50–110s it scored the talk 0.225 and
//   a beep 0.250. Averaging several wordings ("the sound of ...") didn't help either.
// The transcript already holds the answer: a `segments` row means Whisper heard speech there. So
// search.ts answers these queries from the segments table.
//
// Only a query that is ENTIRELY about talking counts. "man talking about football" names a topic,
// so it stays a normal search and can still correctly return nothing.
//
// Pure function (no database, no models, no config), so tests can import it without loading anything.

// Words that ask about speech.
const SPEECH_WORDS = new Set([
  "talk", "talks", "talking",
  "speak", "speaks", "speaking", "speaker",
  "speech", "voice", "voices", "conversation", "narrator", "narration", "dialogue",
]);

// Words that don't narrow the question down ("a person is talking").
const FILLER_WORDS = new Set([
  "a", "an", "the", "some", "someone", "somebody", "person", "people",
  "man", "woman", "men", "women", "guy", "human", "there", "is", "are", "who", "having", "giving",
]);

// True when every word of the query is speech or filler, and at least one is speech.
export function asksOnlyForSpeech(query: string): boolean {
  const words = query.toLowerCase().match(/[a-z]+/g) ?? [];
  return (
    words.some((w) => SPEECH_WORDS.has(w)) &&
    words.every((w) => SPEECH_WORDS.has(w) || FILLER_WORDS.has(w))
  );
}
