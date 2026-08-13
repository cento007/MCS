import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_CONTEXT_TOKENS,
  CONTEXT_RESERVE_TOKENS,
  chunkBudget,
  chunkText,
  DEFAULT_MAX_CHUNK_BYTES,
  MIN_CHUNK_BYTES,
  utf8Bytes,
} from './chunk.js';

/**
 * The chunking bound, and the proof it holds.
 *
 * The finding these tests exist for: **Ollama returns `200` and a normal-looking 768-dimension
 * vector for 108 000 characters of input against a 2048-token context.** No warning, no error,
 * no truncation flag — the vector simply represents the opening fraction. So the bound has to be
 * ours, and it has to hold for text we did not write.
 *
 * The measured ratios that shape the assertions below (binary search for the prefix at which the
 * model's vector stops changing, this machine, `nomic-embed-text`):
 *
 *   English prose 5.09 chars/token · TypeScript 2.80 · JSON 1.85 · hex SHAs 1.14 ·
 *   base64 1.29 · **dense ASCII punctuation 1.00**
 *
 * The last row is why the bound is expressed in bytes: at 1.00 chars/token a characters-based
 * budget derived from any of the other rows truncates.
 */

const BUDGET = chunkBudget(2048);

/** Every chunk fits, nothing was dropped, ordinals are dense from zero. */
function assertWellFormed(text: string, maxBytes: number): string[] {
  const { chunks, truncated } = chunkText(text, { budget: { ...BUDGET, maxBytes } });

  expect(truncated).toBe(false);
  chunks.forEach((chunk, index) => {
    expect(chunk.ordinal).toBe(index);
    expect(chunk.bytes).toBe(utf8Bytes(chunk.text));
    expect(chunk.bytes).toBeLessThanOrEqual(maxBytes);
  });

  return chunks.map((chunk) => chunk.text);
}

describe('chunkBudget — the ceiling comes from the model, downwards', () => {
  it('uses the declared context length, minus the reserve for [CLS]/[SEP]', () => {
    // 2048 tokens declared; the punctuation row proved the runtime spends 2 of them itself.
    const budget = chunkBudget(2048, 4_000);
    expect(budget.maxBytes).toBe(2048 - CONTEXT_RESERVE_TOKENS);
    expect(budget.contextDeclared).toBe(true);
  });

  it('prefers the retrieval-shaped default when it is the smaller of the two', () => {
    const budget = chunkBudget(2048);
    expect(budget.maxBytes).toBe(DEFAULT_MAX_CHUNK_BYTES);
  });

  it('assumes the SMALLEST plausible window when the runtime declares none', () => {
    // Resolving upwards here is the whole failure mode: a 512-token model handed 1 800-byte
    // chunks truncates every one of them and says nothing.
    const budget = chunkBudget(null);
    expect(budget.contextTokens).toBe(CONSERVATIVE_CONTEXT_TOKENS);
    expect(budget.maxBytes).toBe(CONSERVATIVE_CONTEXT_TOKENS - CONTEXT_RESERVE_TOKENS);
  });

  it('treats an absurd declared value as no declaration at all', () => {
    for (const absurd of [0, -1, 4.5, CONTEXT_RESERVE_TOKENS]) {
      expect(chunkBudget(absurd).contextTokens).toBe(CONSERVATIVE_CONTEXT_TOKENS);
    }
  });

  it('shrinks the chunk to fit a small-window model', () => {
    // `all-minilm` and friends: 256 tokens. The default 1 800 bytes would be a silent 7x
    // overrun; the budget has to win.
    expect(chunkBudget(256).maxBytes).toBe(256 - CONTEXT_RESERVE_TOKENS);
  });
});

describe('the proof: a document far larger than the context is SPLIT, never truncated', () => {
  /**
   * 108 000 characters — the exact size that Ollama answered `200` to on this machine while
   * silently reading only the first ~10 000 of it.
   */
  const HUGE = 'The Backend produces into a queue with exactly one consuming process. '.repeat(
    Math.ceil(108_000 / 69),
  );

  it('splits 108 000 characters into many bounded chunks and drops nothing', () => {
    expect(HUGE.length).toBeGreaterThanOrEqual(108_000);

    const texts = assertWellFormed(HUGE, BUDGET.maxBytes);

    // The headline: not one chunk (which is what "silently truncated" looks like from here),
    // but at least the number the byte budget requires.
    expect(texts.length).toBeGreaterThanOrEqual(Math.floor(utf8Bytes(HUGE) / BUDGET.maxBytes));

    // Nothing was dropped: every word of the source survives into some chunk, in order. The
    // separators differ (whitespace is normalized at boundaries), so the comparison is on the
    // word sequence rather than on the raw string.
    const words = (value: string): string[] => value.split(/\s+/).filter((w) => w.length > 0);
    expect(words(texts.join(' '))).toEqual(words(HUGE));
  });

  it('holds at 1.00 chars per token — the densest text measured', () => {
    // `{[()]}<>|&^%$#@!~` tokenizes one token per character on this model. A budget of
    // `maxBytes` bytes therefore admits at most `maxBytes` tokens, which is the bound's whole
    // claim. There is no whitespace and no sentence end here, so this also exercises the
    // code-point-level fallback split.
    const punctuation = '{[()]}<>|&^%$#@!~`;:,./?\\-_=+*'.repeat(2_000);
    expect(punctuation).not.toMatch(/\s/);

    const texts = assertWellFormed(punctuation, BUDGET.maxBytes);
    expect(texts.join('')).toBe(punctuation);
    expect(texts.length).toBeGreaterThan(30);
  });

  it('counts BYTES, not characters, so multi-byte text is not 3x over budget', () => {
    // 1.22 chars/token but 2.93 bytes/token measured: a character budget would let a CJK chunk
    // carry three times the bytes it thought it did.
    const chinese = '我们在二零二六年八月决定采用基于数据库的作业队列而不是Redis。'.repeat(400);
    expect(utf8Bytes(chinese)).toBeGreaterThan(chinese.length * 2);

    const texts = assertWellFormed(chinese, BUDGET.maxBytes);
    expect(texts.join('')).toBe(chinese);
  });

  it('never splits a code point — a broken surrogate would change its own hash', () => {
    // Emoji are 4 UTF-8 bytes each; a naive byte slice would cut one in half, the string would
    // re-encode with U+FFFD, and the chunk's SHA-256 would differ between the run that wrote it
    // and the run that checked it — making every re-index re-embed everything.
    const emoji = '🚀🔥✅🐛⚡'.repeat(400);
    const texts = assertWellFormed(emoji, 101);

    expect(texts.join('')).toBe(emoji);
    for (const text of texts) expect(text).not.toContain('�');
  });

  it('emits a single code point wider than the whole budget rather than looping forever', () => {
    const { chunks } = chunkText('🚀🚀', { budget: { ...BUDGET, maxBytes: 2 } });
    expect(chunks.map((chunk) => chunk.text)).toEqual(['🚀', '🚀']);
  });
});

describe('boundaries — coarsest first', () => {
  it('splits on blank lines before anything else', () => {
    const paragraphs = ['alpha '.repeat(60), 'beta '.repeat(60), 'gamma '.repeat(60)];
    const texts = assertWellFormed(paragraphs.join('\n\n'), 400);

    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('alpha');
    expect(texts[0]).not.toContain('beta');
  });

  it('packs several small paragraphs into one chunk rather than one chunk each', () => {
    const texts = assertWellFormed(['one', 'two', 'three'].join('\n\n'), 1_000);
    expect(texts).toHaveLength(1);
  });

  it('falls through to lines when a paragraph does not fit', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${String(i)} ${'x'.repeat(80)}`);
    const texts = assertWellFormed(lines.join('\n'), 200);
    expect(texts.length).toBeGreaterThan(5);
  });

  it('falls through to sentences when a line does not fit', () => {
    const sentence = 'The queue is PostgreSQL. ';
    const texts = assertWellFormed(sentence.repeat(40), 200);
    for (const text of texts) expect(text.startsWith('The')).toBe(true);
  });

  it('folds a runt into its neighbour instead of storing a 3-byte vector', () => {
    const body = 'x'.repeat(300);
    const texts = assertWellFormed(`${body}\n\nend`, 400);

    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('end');
  });

  it('keeps a legitimately short source as its own chunk', () => {
    // A one-line commit message is short and must still be indexed; the runt rule only merges
    // *backwards* into an existing chunk.
    const texts = assertWellFormed('Fix the relay gap policy', 400);
    expect(texts).toEqual(['Fix the relay gap policy']);
    expect(utf8Bytes(texts[0] ?? '')).toBeLessThan(MIN_CHUNK_BYTES);
  });
});

describe('degenerate input', () => {
  it('produces no chunks for empty or whitespace-only text', () => {
    for (const text of ['', '   ', '\n\n\t\n']) {
      expect(chunkText(text, { budget: BUDGET }).chunks).toEqual([]);
    }
  });

  it('reports truncation as a value when maxChunks bites, rather than silently cutting', () => {
    const result = chunkText('word '.repeat(20_000), { budget: BUDGET, maxChunks: 3 });
    expect(result.chunks).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('is deterministic — the same text chunks identically every time', () => {
    // Idempotence depends on this: a chunker with any nondeterminism would change every
    // content hash on every run and re-embed the entire corpus.
    const text = 'alpha beta gamma. '.repeat(500);
    const first = chunkText(text, { budget: BUDGET }).chunks.map((c) => c.text);
    const second = chunkText(text, { budget: BUDGET }).chunks.map((c) => c.text);
    expect(second).toEqual(first);
  });
});
