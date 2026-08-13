/**
 * Chunking — the bound that stops Ollama silently truncating what we index.
 *
 * ## The failure this file exists to prevent
 *
 * **Ollama does not complain about over-long input. It answers `200` with a normal-looking
 * vector built from the opening fraction of the text.** Measured on this machine against
 * Ollama 0.32.9 + `nomic-embed-text`: 108 000 characters in, `200` out, 768 dimensions, no
 * warning anywhere. The tail of the document is simply not in the vector.
 *
 * That is the worst failure shape available. A crash is found in seconds; an index that is
 * quietly missing 90 % of every long document is found months later by someone who has been
 * making decisions on it. So the rule here is the opposite of "trust the runtime":
 *
 *   > **We bound the input ourselves, before the call, and never rely on the runtime to
 *   > refuse.** A chunk that this module admits is one the model can read whole.
 *
 * ## Establishing the bound: measured, then made sound
 *
 * The truncation point was found by binary search — embed `T`, embed prefixes of `T`, and
 * locate the smallest prefix whose vector is bit-identical to `T`'s. Every class truncated at
 * **exactly 2048 tokens**, which is `nomic-bert.context_length` from `POST /api/show`:
 *
 * | text class                          | truncated at | chars/token | bytes/token |
 * |-------------------------------------|-------------:|------------:|------------:|
 * | English prose                       | 10 429 chars |        5.09 |        5.09 |
 * | TypeScript source                   |  5 728 chars |        2.80 |        2.80 |
 * | JSON payloads                       |  3 780 chars |        1.85 |        1.85 |
 * | Chinese prose                       |  2 507 chars |        1.22 |        2.93 |
 * | hex SHAs                            |  2 328 chars |        1.14 |        1.14 |
 * | base64                              |  2 648 chars |        1.29 |        1.29 |
 * | dense ASCII punctuation `{[()]}<>|&` |  2 046 chars |    **1.00** |    **1.00** |
 *
 * Three conclusions, and each one rules out a design:
 *
 *  1. **A characters-per-token ratio cannot be a constant.** The usual "≈4 chars per token"
 *     rule of thumb is off by **5×** on the last row. A chunker built on it would truncate
 *     exactly the content this product indexes most — commit diffs, JSON tool payloads, SHAs —
 *     while looking correct on the prose someone tested it with.
 *  2. **We are not shipping a tokenizer.** A real one is a per-model vocabulary file, a
 *     dependency, and a second thing that can disagree with whatever model the operator
 *     actually configured. `nomic-embed-text` is WordPiece; the next model an operator picks
 *     will not be.
 *  3. **UTF-8 bytes are a sound upper bound on tokens, for every subword tokenizer.** Byte-level
 *     BPE starts from single bytes and only ever *merges*, so it emits at most one token per
 *     byte. WordPiece falls back to single characters (and collapses unknown words to one
 *     `[UNK]`), so it emits at most one token per character, and a character is at least one
 *     byte. **`tokens ≤ utf8Bytes` therefore holds without knowing the vocabulary**, and the
 *     table above is the evidence: the densest row reaches 1.00 and nothing goes below it.
 *
 * So the bound is **bytes**, compared against the model's **own declared context length**:
 *
 *     maxChunkBytes = min(DEFAULT_MAX_CHUNK_BYTES, contextTokens - CONTEXT_RESERVE_TOKENS)
 *
 * `contextTokens` comes from `/api/show` (`<family>.context_length`) when the runtime reports
 * one and falls back to {@link CONSERVATIVE_CONTEXT_TOKENS} when it does not — "I could not
 * find out" resolves *downwards*, because the cost of a chunk that is too small is a slightly
 * worse ranking and the cost of one that is too large is silent data loss.
 *
 * ## The reserve, and why it is not zero
 *
 * The punctuation row truncated at 2046, not 2048: BERT wraps the input in `[CLS]` … `[SEP]`.
 * Some models also prepend a task instruction (`search_document: `) server-side. Eight tokens
 * of headroom covers both and costs 0.4 % of the window.
 *
 * ## What this costs
 *
 * On prose, a 1 800-byte chunk is ~350 tokens against a 2048-token window — we use a sixth of
 * it. That is not waste: retrieval quality *wants* chunks in the 200–500 token range, because a
 * vector averaged over 2000 tokens of mixed subject matter is near nothing in particular. The
 * byte bound and the retrieval optimum point the same way, so the conservative choice is also
 * the better one.
 */

/**
 * Target chunk size in UTF-8 bytes.
 *
 * ~350 tokens of prose, ~640 of code, ~970 of JSON, and 1 800 in the pathological
 * one-byte-per-token case — all comfortably inside a 2048-token window, and all inside the
 * range where a single vector still means one thing.
 */
export const DEFAULT_MAX_CHUNK_BYTES = 1_800;

/**
 * Headroom for tokens the runtime adds that are not in our text: `[CLS]`/`[SEP]`, a
 * server-side task prefix. Measured need is 2; eight is cheap insurance.
 */
export const CONTEXT_RESERVE_TOKENS = 8;

/**
 * The context length assumed when the runtime does not declare one.
 *
 * 512 is the smallest window in common use among sentence-transformer embedders (`all-minilm`,
 * `bge-small`, the MiniLM family). Assuming the *smallest* plausible window when we do not know
 * is the only direction that fails safe: too-small chunks are a ranking nuisance, too-large
 * chunks are invisible data loss.
 */
export const CONSERVATIVE_CONTEXT_TOKENS = 512;

/**
 * Chunks below this are folded into their neighbour rather than stored alone.
 *
 * A 12-byte chunk ("Fixes #1234") embeds to a direction dominated by noise and will out- or
 * under-rank unpredictably. Below the floor the text is appended to the previous chunk when
 * that keeps it under the byte bound, and kept as-is when it cannot be — a short *source* (a
 * one-line commit message) is legitimate and must still be indexed.
 */
export const MIN_CHUNK_BYTES = 64;

export interface ChunkBudget {
  /** Hard ceiling on one chunk, in UTF-8 bytes. Guarantees `tokens <= maxBytes`. */
  readonly maxBytes: number;
  /** What the ceiling was derived from, for logs and for the report a backfill emits. */
  readonly contextTokens: number;
  /** True when `contextTokens` was declared by the runtime rather than assumed. */
  readonly contextDeclared: boolean;
}

/**
 * Derive the byte budget from what the runtime says about the model.
 *
 * `declaredContextTokens` is `<family>.context_length` off `/api/show`, or `null` when the
 * runtime did not report one. A declared value that is absurd (zero, negative, non-integer) is
 * treated as absent rather than trusted — a manifest is data from outside this process.
 */
export function chunkBudget(
  declaredContextTokens: number | null,
  maxBytes: number = DEFAULT_MAX_CHUNK_BYTES,
): ChunkBudget {
  const declared =
    declaredContextTokens !== null &&
    Number.isInteger(declaredContextTokens) &&
    declaredContextTokens > CONTEXT_RESERVE_TOKENS;

  const contextTokens = declared ? (declaredContextTokens as number) : CONSERVATIVE_CONTEXT_TOKENS;

  const ceiling = contextTokens - CONTEXT_RESERVE_TOKENS;
  return {
    maxBytes: Math.max(1, Math.min(Math.trunc(maxBytes), ceiling)),
    contextTokens,
    contextDeclared: declared,
  };
}

/** UTF-8 byte length. The unit the bound is expressed in — see the header for why. */
export function utf8Bytes(text: string): number {
  // `Buffer.byteLength` would be marginally faster and would pull `node:buffer` into a module
  // the Frontend type-checks against. `TextEncoder` is in every runtime this code touches.
  return ENCODER.encode(text).length;
}

const ENCODER = new TextEncoder();

export interface TextChunk {
  readonly ordinal: number;
  readonly text: string;
  /** UTF-8 length, carried so callers do not re-encode to check the bound. */
  readonly bytes: number;
}

export interface ChunkOptions {
  readonly budget: ChunkBudget;
  /**
   * Chunks emitted at most, per source. A transcript of a 12-hour session is legitimately
   * enormous, and an unbounded chunker turns it into an unbounded number of embedding calls
   * inside one job. When the cap is hit the remainder is dropped and `truncated` says so —
   * loudly, as a value the caller records, which is the opposite of what Ollama does.
   */
  readonly maxChunks?: number | undefined;
}

/** Chunks a source may produce before the ingester declares it oversized. */
export const DEFAULT_MAX_CHUNKS = 400;

export interface ChunkResult {
  readonly chunks: readonly TextChunk[];
  /** True when `maxChunks` cut the document short. Recorded, never silent. */
  readonly truncated: boolean;
}

/**
 * Split `text` into chunks that each fit the byte budget.
 *
 * ## The split order
 *
 * Boundaries are tried from most to least semantically meaningful, and the next one is used
 * only when the previous one leaves a piece that still does not fit:
 *
 *   blank line  ->  single newline  ->  sentence end  ->  whitespace  ->  UTF-8 code point
 *
 * The last level is what makes the bound total: a 4 000-byte "word" (a base64 blob, a minified
 * bundle line) has no whitespace to split on, and a chunker whose finest boundary is a space
 * would emit it whole and be back to silent truncation. Splitting there **never splits a code
 * point** — a chunk cut mid-character would be re-encoded with a replacement character and
 * change its own hash on the next run, so idempotence depends on this too.
 *
 * ## Why there is no overlap
 *
 * Sliding-window overlap is the usual RAG default and it is declined here. It multiplies both
 * the embedding cost and the stored point count by the overlap factor, it makes near-duplicate
 * hits crowd out genuinely different sources in a top-5, and the projections that feed this
 * (`projection.ts`) already emit semantically whole units — a commit message, one ADR section,
 * a run of conversation turns — so a boundary rarely lands mid-thought. If a later evaluation
 * shows boundary misses, overlap is an additive change to this function and to nothing else.
 */
export function chunkText(text: string, options: ChunkOptions): ChunkResult {
  const maxBytes = options.budget.maxBytes;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

  const pieces = splitToFit(text, maxBytes);
  const merged = mergeSmall(pieces, maxBytes);

  const chunks: TextChunk[] = [];
  for (const piece of merged) {
    if (chunks.length >= maxChunks) {
      return { chunks, truncated: true };
    }
    chunks.push({ ordinal: chunks.length, text: piece, bytes: utf8Bytes(piece) });
  }

  return { chunks, truncated: false };
}

/**
 * Recursive descent through the boundary levels.
 *
 * Returns non-empty pieces that each fit `maxBytes`. Pieces keep their own trailing whitespace
 * trimmed but are otherwise verbatim, so concatenating them reproduces the source modulo the
 * separators — a property the tests assert, because "nothing was dropped" is the whole claim.
 */
function splitToFit(text: string, maxBytes: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (utf8Bytes(trimmed) <= maxBytes) return [trimmed];

  for (const separator of SEPARATORS) {
    const parts = separator.split(trimmed);
    if (parts.length < 2) continue;

    const packed = packGreedily(parts, separator.join, maxBytes);
    // A level that produced one oversized piece and nothing else has not helped; fall through
    // to the next, finer level rather than recursing on the same string forever.
    if (packed.length === 1 && packed[0] === trimmed) continue;

    const out: string[] = [];
    for (const piece of packed) {
      if (utf8Bytes(piece) <= maxBytes) out.push(piece);
      else out.push(...splitToFit(piece, maxBytes));
    }
    return out.filter((piece) => piece.length > 0);
  }

  // No separator produced a usable split: cut on code-point boundaries.
  return sliceByBytes(trimmed, maxBytes);
}

interface Separator {
  split(text: string): string[];
  /** Re-joined between pieces packed back together, so the text reads as it did. */
  readonly join: string;
}

const SEPARATORS: readonly Separator[] = [
  { split: (text) => text.split(/\n[ \t]*\n+/), join: '\n\n' },
  { split: (text) => text.split('\n'), join: '\n' },
  // Sentence end: terminator + whitespace, keeping the terminator with the sentence it ends.
  { split: (text) => text.split(/(?<=[.!?;:])\s+/), join: ' ' },
  { split: (text) => text.split(/\s+/), join: ' ' },
];

/** Greedily pack parts into pieces at or under the byte ceiling. */
function packGreedily(parts: readonly string[], join: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = '';

  for (const raw of parts) {
    const part = raw.trim();
    if (part.length === 0) continue;

    const candidate = current.length === 0 ? part : `${current}${join}${part}`;
    if (utf8Bytes(candidate) <= maxBytes) {
      current = candidate;
      continue;
    }

    if (current.length > 0) out.push(current);
    current = part;
  }

  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Hard slice on UTF-8 byte count, never inside a code point.
 *
 * The loop advances by code point (`for…of` iterates code points, not UTF-16 units), so a
 * surrogate pair and a 4-byte emoji stay intact. Splitting one would produce a lone surrogate
 * that JSON-serializes to `�`, which changes the chunk's own SHA-256 between the run that
 * wrote it and the run that checks it — making every re-index re-embed everything.
 */
function sliceByBytes(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = '';
  let bytes = 0;

  for (const codePoint of text) {
    const size = utf8Bytes(codePoint);
    // A single code point wider than the whole budget cannot be split further; emit it alone
    // rather than looping. `maxBytes >= 1` is guaranteed by `chunkBudget`.
    if (size > maxBytes) {
      if (current.length > 0) {
        out.push(current);
        current = '';
        bytes = 0;
      }
      out.push(codePoint);
      continue;
    }

    if (bytes + size > maxBytes) {
      out.push(current);
      current = codePoint;
      bytes = size;
      continue;
    }

    current += codePoint;
    bytes += size;
  }

  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Fold a runt into its predecessor when that keeps the predecessor under the ceiling.
 *
 * Greedy packing leaves a short tail whenever the text does not divide evenly, and a 20-byte
 * final chunk is a stored vector that answers queries about nothing. A runt that cannot be
 * folded (because the previous chunk is already full, or because it is the only chunk) is kept:
 * a one-line commit message is a legitimate short source, not a defect.
 */
function mergeSmall(pieces: readonly string[], maxBytes: number): string[] {
  const out: string[] = [];

  for (const piece of pieces) {
    const previous = out[out.length - 1];
    if (previous !== undefined && utf8Bytes(piece) < MIN_CHUNK_BYTES) {
      const merged = `${previous}\n${piece}`;
      if (utf8Bytes(merged) <= maxBytes) {
        out[out.length - 1] = merged;
        continue;
      }
    }
    out.push(piece);
  }

  return out;
}
