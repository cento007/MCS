/**
 * `EmbeddingPort` — text in, vectors out, behind one seam.
 *
 * ## Why the shape is batch
 *
 * `embed(texts) -> number[][]`, never `embed(text) -> number[]`, even though the adapter is
 * free to fan out internally. Measured against a real Ollama 0.32.9 with `nomic-embed-text`
 * (768d) on this machine, over ~700-character chunks:
 *
 *   | call shape                      | wall clock | per chunk |
 *   |---------------------------------|-----------:|----------:|
 *   | 32 chunks, one request each     |    1009 ms |   31.5 ms |
 *   | 32 chunks, one batched request  |     210 ms |    6.6 ms |
 *   | 128 chunks, one batched request |     756 ms |    5.9 ms |
 *
 * A first index of a long transcript is thousands of chunks. At 31.5 ms each that is minutes of
 * wall clock spent almost entirely on HTTP round trips; at 5.9 ms it is seconds. A per-text
 * signature would make the slow shape the default and the fast one an optimization someone has
 * to remember, so the port simply does not offer the slow one.
 *
 * ## Why the result is a union rather than a bare `number[][]`
 *
 * Ollama not running, and the configured model not being pulled, are **states of an operator's
 * machine**, not exceptional conditions — the Services panel exists to report exactly those.
 * The success arm carries the `number[][]` the shape promises; the rest are the answers a
 * bounded probe of an optional local service can honestly give. A thrown error from this port
 * means a bug in this process, and callers may treat it that way.
 *
 * The one thing that is *not* in the union is a stamp mismatch: `memory/stamp.ts` explains why
 * that one throws.
 */

import type { EmbeddingStamp } from './stamp.js';

/** A single embedding. Read-only because callers must not mutate a vector they were handed. */
export type EmbeddingVector = readonly number[];

export interface EmbeddingSuccess {
  readonly kind: 'ok';
  /** One vector per input text, in input order. */
  readonly vectors: readonly EmbeddingVector[];
  /** What produced them. Callers stamp rows and points with exactly this. */
  readonly stamp: EmbeddingStamp;
}

/**
 * Every way asking for embeddings can fail to produce them, as data.
 *
 * `model_missing` and `not_an_embedding_model` are separate arms because the operator's next
 * action is different: `ollama pull <model>` versus "that name is a chat model, pick an
 * embedder". Collapsing them into one `failed` would throw away the only part of the answer
 * that is actionable.
 */
export type EmbeddingFailure =
  | { readonly kind: 'not_configured'; readonly reason: string }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number }
  | { readonly kind: 'model_missing'; readonly model: string; readonly reason: string }
  | {
      readonly kind: 'not_an_embedding_model';
      readonly model: string;
      readonly capabilities: readonly string[];
      readonly reason: string;
    }
  | { readonly kind: 'failed'; readonly status: number | null; readonly reason: string };

export type EmbeddingOutcome = EmbeddingSuccess | EmbeddingFailure;

/** What a model probe found. `dimension` is measured, never assumed — see `ollama.ts`. */
export interface EmbeddingModelInfo {
  readonly kind: 'ok';
  readonly stamp: EmbeddingStamp;
  /** e.g. `['embedding']`. Empty when the runtime does not report capabilities. */
  readonly capabilities: readonly string[];
  /** The runtime's own version string, for the health row's `meta`. */
  readonly runtimeVersion: string | null;
  /**
   * The dimension the runtime *declares* for the model, when it declares one, versus the
   * `stamp.dimension` that was actually measured. They agree for `nomic-embed-text`; a
   * disagreement is worth showing rather than silently preferring one.
   */
  readonly declaredDimension: number | null;
}

export type EmbeddingModelOutcome = EmbeddingModelInfo | EmbeddingFailure;

export interface EmbedOptions {
  /**
   * Overrides the adapter's default deadline. Present so a test can prove the timeout path in
   * milliseconds instead of waiting out a real one, and so an interactive query can be given a
   * tighter bound than a background index run.
   */
  readonly timeoutMs?: number | undefined;
}

export interface EmbeddingPort {
  /** The configured model name. Stable for the port's lifetime — settings changes rebuild it. */
  readonly model: string;

  /**
   * Embed a batch, in order.
   *
   * An empty input array returns `{ kind: 'ok', vectors: [] }` without any network call: "there
   * was nothing to index" is not a reason to wake a model.
   */
  embed(texts: readonly string[], options?: EmbedOptions): Promise<EmbeddingOutcome>;

  /**
   * Identify the model without embedding anything the caller cares about.
   *
   * This is what provisioning uses to learn the dimension to stamp a collection with, and what
   * the health probe uses to answer "is the configured model actually an embedder". It must be
   * bounded like everything else — see `ollama.ts` for why that matters more here than it
   * looks.
   */
  describeModel(options?: EmbedOptions): Promise<EmbeddingModelOutcome>;
}

/** Human-readable one-liner for a failure arm — the text a health row's `detail` shows. */
export function describeEmbeddingFailure(failure: EmbeddingFailure): string {
  switch (failure.kind) {
    case 'not_configured':
      return failure.reason;
    case 'unreachable':
      return failure.reason;
    case 'timeout':
      return `Timed out after ${String(failure.timeoutMs)} ms`;
    case 'model_missing':
      return failure.reason;
    case 'not_an_embedding_model':
      return failure.reason;
    default:
      return failure.status === null
        ? failure.reason
        : `${failure.reason} (HTTP ${String(failure.status)})`;
  }
}

/** Narrowing helper — `outcome.kind === 'ok'` reads worse at every call site than this does. */
export function isEmbeddingSuccess(outcome: EmbeddingOutcome): outcome is EmbeddingSuccess {
  return outcome.kind === 'ok';
}

// ------------------------------------------------------------------------------ vector maths

/**
 * Cosine similarity in `[-1, 1]`, higher is nearer.
 *
 * Lives beside the port rather than inside the in-memory store because both the store and the
 * tests that check the store need it, and a second copy of this five-line function is a second
 * chance to get the zero-vector case wrong.
 *
 * A zero-length vector has no direction, so its similarity to anything is defined here as `0`
 * rather than `NaN`. `NaN` would silently sort to the end (or the front, depending on the
 * comparator) and produce a ranking nobody could explain.
 */
export function cosineSimilarity(a: EmbeddingVector, b: EmbeddingVector): number {
  if (a.length !== b.length) {
    throw new Error(
      `Cosine similarity needs equal lengths: got ${String(a.length)} and ${String(b.length)}. ` +
        'Two different embedding models produced these vectors.',
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Scale a vector to unit length, leaving a zero vector alone.
 *
 * The adapters normalize on the way out, which makes the port's output independent of which
 * Ollama endpoint served it: `/api/embed` returns L2-normalized vectors and the legacy
 * `/api/embeddings` returns raw ones (measured — norm 1.0 versus ~4.9 for the same text on the
 * same model). Cosine ranking is invariant to scale so retrieval would survive the difference,
 * but "the same text embeds to the same numbers" is a property worth having outright rather
 * than one that happens to not matter yet.
 */
export function normalizeVector(vector: EmbeddingVector): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  if (sumSquares === 0) return [...vector];

  const norm = Math.sqrt(sumSquares);
  return vector.map((value) => value / norm);
}
