// Turns a search query (text) into the three vectors search needs, one per vector table:
//
//   "dog barking" ──CLIP text side──▶ 512-d  → compared with frames.embedding   (what is SHOWN)
//                 ──bge + prefix────▶ 384-d  → compared with segments.embedding (what is SAID)
//                 ──CLAP text side──▶ 512-d  → compared with sounds.embedding   (what is HEARD)
//
// Each one uses the SAME model id as the worker that stored those rows (from config), so query
// and rows live in the same space. A vector from a different model would still "work" (pgvector
// happily compares any two 512-d vectors) but the scores would be meaningless.
// Keyword search needs no vector: Postgres reads the raw text (see search.ts).

import { toVectors } from "@app/shared";
import { loadClapText, loadClipText, loadTextEmbedder } from "@app/shared/models";

// bge-small-en-v1.5 was trained to put this instruction in front of SHORT QUERIES when the
// things being searched are longer passages. The passages themselves (our transcript windows)
// were embedded WITHOUT it (speech worker), exactly as the model card says. See Decisions log.
const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

export type QueryVectors = {
  clip: Float32Array; // 512-d, L2-normalized
  bge: Float32Array; // 384-d, L2-normalized
  clap: Float32Array; // 512-d, L2-normalized
};

// Load the three text encoders once (at API startup) and return the function that embeds a
// query. Same "load first, then return the worker" pattern as the workers' create…Worker().
export async function loadQueryEncoder(): Promise<(query: string) => Promise<QueryVectors>> {
  const [clip, bge, clap] = await Promise.all([loadClipText(), loadTextEmbedder(), loadClapText()]);
  console.log("[search] CLIP text + bge + CLAP text loaded");

  return async function encodeQuery(query: string): Promise<QueryVectors> {
    // One query = one input per model, so there's nothing to batch. The three calls go to three
    // DIFFERENT models, so running them at the same time (Promise.all) is fine here; the
    // "Promise.all is not batching" rule is about many inputs to the SAME model.
    const [clipOut, bgeOut, clapOut] = await Promise.all([
      // tokenizer: text → token ids (+ attention mask). padding/truncation keep it within the
      // model's max length (77 tokens for CLIP). model → { text_embeds: Tensor [1, 512] }
      clip.model(clip.tokenizer([query], { padding: true, truncation: true })),
      // Same pooling as the speech worker ("cls" = the first token's vector) → Tensor [1, 384]
      bge(BGE_QUERY_PREFIX + query, { pooling: "cls" }),
      clap.model(clap.tokenizer([query], { padding: true, truncation: true })),
    ]);

    // toVectors splits a [1, dim] tensor into one vector and L2-normalizes it, same as the
    // stored rows, so cosine similarity = 1 - pgvector's cosine distance.
    return {
      clip: toVectors(clipOut.text_embeds)[0]!,
      bge: toVectors(bgeOut)[0]!,
      clap: toVectors(clapOut.text_embeds)[0]!,
    };
  };
}
