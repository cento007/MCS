/**
 * The deterministic fake embedder — what the unit tier runs on.
 *
 * `pnpm test` must pass on a clean checkout with no PostgreSQL, no Qdrant and no Ollama
 * installed. That is not a nicety: it is what makes `pnpm install && pnpm test` a valid first
 * five minutes in this repository, and an existing test enforces the database half of it. So
 * every unit test of retrieval logic embeds through this.
 *
 * ## What it guarantees
 *
 *  - **Deterministic.** The same text always produces the same vector, in this process and in
 *    the next one, on Windows and on Ubuntu. There is no clock, no randomness and no state.
 *  - **Dimension-correct.** It produces exactly the dimension it was configured with, so a
 *    dimension-mismatch test can be written by constructing two of these rather than by
 *    installing two models.
 *  - **Semantically crude but not arbitrary.** Vectors are built from character trigrams, so
 *    texts that share substrings are nearer than texts that do not. That is enough to make a
 *    ranking assertion — "a near-duplicate outranks a loose match" — mean something, and it is
 *    honest about being a fake: it is a lexical hash, not a language model, and no test should
 *    ask it to know that "cat" and "feline" are related.
 *  - **Unit length.** Normalized on the way out, exactly as the real adapters are, so cosine
 *    and dot product agree and a test's expected scores do not depend on text length.
 *
 * It deliberately does **not** implement a "sometimes fails" mode. Failure arms are exercised
 * by `createFailingEmbedder`, which is explicit at the call site about which failure it is
 * simulating.
 */

import {
  type EmbeddingFailure,
  type EmbeddingModelOutcome,
  type EmbeddingOutcome,
  type EmbeddingPort,
  normalizeVector,
} from './embedding-port.js';
import type { EmbeddingStamp } from './stamp.js';

/**
 * Matches `nomic-embed-text`, the model this project actually runs, so a fixture written
 * against the fake keeps its shape when it is pointed at the real thing.
 */
export const FAKE_EMBEDDING_DIMENSION = 768;
export const FAKE_EMBEDDING_MODEL = 'fake-embed-text';

export interface FakeEmbedderOptions {
  readonly model?: string;
  readonly dimension?: number;
  /** Recorded for assertions: every batch this port was asked to embed, in order. */
  readonly recordCalls?: boolean;
}

export interface FakeEmbeddingPort extends EmbeddingPort {
  readonly stamp: EmbeddingStamp;
  /** Batches seen, when `recordCalls` was set. Empty otherwise. */
  readonly calls: readonly (readonly string[])[];
}

export function createFakeEmbedder(options: FakeEmbedderOptions = {}): FakeEmbeddingPort {
  const model = options.model ?? FAKE_EMBEDDING_MODEL;
  const dimension = options.dimension ?? FAKE_EMBEDDING_DIMENSION;
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new Error(`Fake embedder dimension must be a positive integer, got ${String(dimension)}`);
  }
  const stamp: EmbeddingStamp = { model, dimension };
  const calls: (readonly string[])[] = [];

  return {
    model,
    stamp,
    calls,

    async embed(texts): Promise<EmbeddingOutcome> {
      if (options.recordCalls === true) calls.push([...texts]);
      return { kind: 'ok', vectors: texts.map((text) => fakeVector(text, dimension)), stamp };
    },

    async describeModel(): Promise<EmbeddingModelOutcome> {
      return {
        kind: 'ok',
        stamp,
        capabilities: ['embedding'],
        runtimeVersion: 'fake',
        declaredDimension: dimension,
      };
    },
  };
}

/**
 * A port that always returns one chosen failure arm.
 *
 * Explicit rather than probabilistic: a test that says `createFailingEmbedder({ kind:
 * 'model_missing', … })` states exactly which operator situation it is reproducing, and a test
 * that flakes because a fake decided to fail 10% of the time teaches nobody anything.
 */
export function createFailingEmbedder(
  failure: EmbeddingFailure,
  model = FAKE_EMBEDDING_MODEL,
): EmbeddingPort {
  return {
    model,
    async embed(): Promise<EmbeddingOutcome> {
      return failure;
    },
    async describeModel(): Promise<EmbeddingModelOutcome> {
      return failure;
    },
  };
}

/**
 * Text -> a stable unit vector.
 *
 * Every character trigram of the text is hashed to a coordinate and accumulated with a sign
 * derived from the same hash — a signed feature-hashing sketch, which is the standard cheap way
 * to get "shares substrings => points in a similar direction" without a model. Distinct texts
 * of the same length still differ, because the trigram *multiset* differs.
 *
 * The empty string has no trigrams and would otherwise be the zero vector, which has no
 * direction and would score 0 against everything including itself. It gets a fixed non-zero
 * coordinate instead, so `similarity(x, x) === 1` holds for every input without exception —
 * a property several tests lean on.
 */
export function fakeVector(text: string, dimension: number): readonly number[] {
  const values = new Array<number>(dimension).fill(0);

  if (text.length === 0) {
    values[0] = 1;
    return values;
  }

  const padded = `${text}`;
  for (let index = 0; index + 3 <= padded.length; index += 1) {
    const hash = hash32(padded.slice(index, index + 3));
    const slot = hash % dimension;
    // Bit 31 as the sign keeps collisions from all pushing the same direction, which is what
    // stops long texts from collapsing onto one another.
    values[slot] = (values[slot] ?? 0) + ((hash & 0x8000_0000) === 0 ? 1 : -1);
  }

  // A one- or two-character text yields no trigram from the loop above (padding gives it two
  // at most); guarantee a direction rather than returning zeros.
  const allZero = values.reduce<number>((total, value) => total + Math.abs(value), 0) === 0;
  if (allZero) values[hash32(text) % dimension] = 1;

  return normalizeVector(values);
}

/** FNV-1a, 32-bit. Chosen for being short, dependency-free and identical on every platform. */
function hash32(input: string): number {
  let hash = 0x811c_9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // `Math.imul` keeps the multiply in 32-bit space; `*` would lose precision past 2^53.
    hash = Math.imul(hash, 0x0100_0193);
  }
  return hash >>> 0;
}
