// Small helpers for the vectors (embeddings) the models return.
// Used by every worker (visual/CLIP, speech/bge, sound/CLAP) to store vectors, and by the
// API (Day 8) to embed search queries the same way.

import type { Tensor } from "@huggingface/transformers";

// Scale a vector to length 1 (L2 normalization). After this, cosine similarity = dot product,
// and every stored vector is on the same scale no matter how "loud" the model's output was.
export function l2normalize(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (const x of v) sumSq += x * x;
  const len = Math.sqrt(sumSq) || 1; // avoid dividing by 0 for an all-zero vector
  return v.map((x) => x / len);
}

// A model called on a batch returns ONE Tensor of shape [batchSize, dim], with all numbers
// in one flat array. Split it into one normalized Float32Array per input: row i = input i.
export function toVectors(t: Tensor): Float32Array[] {
  const [n, dim] = t.dims as [number, number];
  const data = t.data as Float32Array;
  return Array.from({ length: n }, (_, i) => l2normalize(data.slice(i * dim, (i + 1) * dim)));
}

// pgvector's text format is "[0.1,0.2,...]". We send that string and Postgres turns it
// into a `vector` because the column it's inserted into has that type.
export function toPgVector(v: Float32Array): string {
  return `[${Array.from(v).join(",")}]`;
}
