import { describe, expect, it } from 'vitest';
import { cosineSimilarity, isEmbeddingSuccess, normalizeVector } from './embedding-port.js';
import {
  createFailingEmbedder,
  createFakeEmbedder,
  FAKE_EMBEDDING_DIMENSION,
} from './fake-embedder.js';

/**
 * The deterministic fake embedder.
 *
 * Its whole value is that a retrieval test can be written with no Ollama installed, so the
 * properties under test are the ones such a test would silently rely on: same input, same
 * vector; the configured dimension, exactly; and enough lexical signal that a ranking assertion
 * is arithmetic rather than wishful thinking.
 */

async function embed(port: ReturnType<typeof createFakeEmbedder>, texts: string[]) {
  const outcome = await port.embed(texts);
  if (!isEmbeddingSuccess(outcome)) throw new Error(`fake embedder failed: ${outcome.kind}`);
  return outcome;
}

describe('determinism', () => {
  it('produces the same vector for the same text, every time', async () => {
    const port = createFakeEmbedder();
    const first = await embed(port, ['the launch hung for 45 seconds']);
    const second = await embed(port, ['the launch hung for 45 seconds']);

    expect(second.vectors[0]).toEqual(first.vectors[0]);
  });

  it('produces the same vector from a freshly constructed port — no hidden state', async () => {
    const first = await embed(createFakeEmbedder(), ['pg-boss on PostgreSQL']);
    const second = await embed(createFakeEmbedder(), ['pg-boss on PostgreSQL']);

    expect(second.vectors[0]).toEqual(first.vectors[0]);
  });

  it('produces different vectors for different texts', async () => {
    const [a, b] = (await embed(createFakeEmbedder(), ['authentication', 'deployment'])).vectors;
    expect(a).not.toEqual(b);
  });
});

describe('dimension', () => {
  it('defaults to 768 — the same width as the nomic-embed-text this project runs', async () => {
    const outcome = await embed(createFakeEmbedder(), ['x']);
    expect(outcome.vectors[0]).toHaveLength(FAKE_EMBEDDING_DIMENSION);
    expect(outcome.stamp.dimension).toBe(768);
  });

  it('honours a configured dimension exactly', async () => {
    const outcome = await embed(createFakeEmbedder({ dimension: 16 }), ['x', 'y']);
    expect(outcome.vectors.map((vector) => vector.length)).toEqual([16, 16]);
    expect(outcome.stamp.dimension).toBe(16);
  });

  it('refuses a nonsensical dimension at construction rather than at first use', () => {
    expect(() => createFakeEmbedder({ dimension: 0 })).toThrow(/positive integer/);
    expect(() => createFakeEmbedder({ dimension: 1.5 })).toThrow(/positive integer/);
  });
});

describe('shape', () => {
  it('returns one vector per input, in input order', async () => {
    const port = createFakeEmbedder({ dimension: 32 });
    const batch = await embed(port, ['alpha', 'beta', 'gamma']);
    const alpha = await embed(port, ['alpha']);
    const gamma = await embed(port, ['gamma']);

    expect(batch.vectors).toHaveLength(3);
    expect(batch.vectors[0]).toEqual(alpha.vectors[0]);
    expect(batch.vectors[2]).toEqual(gamma.vectors[0]);
  });

  it('handles an empty batch without inventing a vector', async () => {
    expect((await embed(createFakeEmbedder(), [])).vectors).toEqual([]);
  });

  it('gives the empty string a real direction rather than a zero vector', async () => {
    // A zero vector scores 0 against everything including itself, which breaks every ranking
    // assertion in an unobvious way.
    const [vector] = (await embed(createFakeEmbedder({ dimension: 8 }), [''])).vectors;
    expect(vector).toBeDefined();
    expect(cosineSimilarity(vector ?? [], vector ?? [])).toBeCloseTo(1, 10);
  });

  it('records the batches it was asked for, when told to', async () => {
    const port = createFakeEmbedder({ recordCalls: true });
    await port.embed(['a', 'b']);
    await port.embed(['c']);
    expect(port.calls).toEqual([['a', 'b'], ['c']]);
  });
});

describe('normalization', () => {
  it('returns unit-length vectors, so cosine and dot product agree', async () => {
    const outcome = await embed(createFakeEmbedder({ dimension: 64 }), [
      'a short chunk',
      'a considerably longer chunk of text with many more trigrams in it than the first',
    ]);

    for (const vector of outcome.vectors) {
      const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
      expect(norm).toBeCloseTo(1, 10);
    }
  });

  it('leaves a zero vector alone rather than dividing by zero', () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('lexical signal', () => {
  it('scores a near-duplicate above an unrelated text', async () => {
    const port = createFakeEmbedder({ dimension: 256 });
    const { vectors } = await embed(port, [
      'the session state machine forbids moving backwards',
      'the session state machine forbids moving backward',
      'quarterly revenue projections for the northern region',
    ]);

    const [query, nearDuplicate, unrelated] = vectors;
    expect(query && nearDuplicate && unrelated).toBeTruthy();

    const near = cosineSimilarity(query ?? [], nearDuplicate ?? []);
    const far = cosineSimilarity(query ?? [], unrelated ?? []);
    expect(near).toBeGreaterThan(far);
  });

  it('scores a text against itself at exactly 1', async () => {
    const [vector] = (await embed(createFakeEmbedder({ dimension: 128 }), ['identity'])).vectors;
    expect(cosineSimilarity(vector ?? [], vector ?? [])).toBeCloseTo(1, 10);
  });
});

describe('describeModel', () => {
  it('reports itself as an embedder of the configured width', async () => {
    const outcome = await createFakeEmbedder({ model: 'test-embed', dimension: 4 }).describeModel();
    expect(outcome).toMatchObject({
      kind: 'ok',
      stamp: { model: 'test-embed', dimension: 4 },
      capabilities: ['embedding'],
    });
  });
});

describe('the failing embedder', () => {
  it('returns the chosen failure from both methods, unchanged', async () => {
    const failure = { kind: 'model_missing', model: 'gone', reason: 'not pulled' } as const;
    const port = createFailingEmbedder(failure);

    expect(await port.embed(['x'])).toEqual(failure);
    expect(await port.describeModel()).toEqual(failure);
  });
});

describe('cosine similarity', () => {
  it('refuses to compare vectors of different widths', () => {
    // The one arithmetic that must never silently succeed: two models' output.
    expect(() => cosineSimilarity([1, 0], [1, 0, 0])).toThrow(/equal lengths/);
  });

  it('defines a zero vector as similarity 0 rather than NaN', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('is 1 for identical directions and -1 for opposite ones', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });
});
