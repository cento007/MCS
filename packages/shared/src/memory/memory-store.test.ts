import { describe, expect, it } from 'vitest';
import { isEmbeddingSuccess } from './embedding-port.js';
import { createFakeEmbedder } from './fake-embedder.js';
import { createInMemoryVectorStore } from './memory-store.js';
import { type EmbeddingStamp, EmbeddingStampMismatchError, VectorDimensionError } from './stamp.js';
import type { MemoryPoint, MemoryPointPayload } from './vector-store-port.js';

/**
 * The in-memory vector store.
 *
 * It is the substrate every retrieval test will run on, so what is proven here is what those
 * tests will be entitled to assume: **the ranking is real cosine similarity**, the filters are
 * the closed shape both stores implement, an unverified write is impossible, and a dimension or
 * stamp disagreement refuses rather than storing.
 */

const STAMP: EmbeddingStamp = { model: 'fake-embed-text', dimension: 64 };
const embedder = createFakeEmbedder({ model: STAMP.model, dimension: STAMP.dimension });

async function vectorFor(text: string): Promise<readonly number[]> {
  const outcome = await embedder.embed([text]);
  if (!isEmbeddingSuccess(outcome)) throw new Error('fake embedder failed');
  const vector = outcome.vectors[0];
  if (vector === undefined) throw new Error('no vector');
  return vector;
}

function payload(overrides: Partial<MemoryPointPayload> = {}): MemoryPointPayload {
  return {
    kind: 'chunk',
    memoryItemId: '0198f0a0-0000-7000-8000-00000000aaaa',
    tier: 'project',
    projectId: 'project-1',
    sessionId: null,
    agentId: null,
    sourceType: 'session',
    sourceId: '0198f0a0-0000-7000-8000-00000000bbbb',
    sourceRef: null,
    chunkOrdinal: 0,
    embeddingModel: STAMP.model,
    embeddingDimension: STAMP.dimension,
    ...overrides,
  };
}

async function point(
  id: string,
  text: string,
  overrides: Partial<MemoryPointPayload> = {},
): Promise<MemoryPoint> {
  return {
    id,
    vector: await vectorFor(text),
    payload: payload({ memoryItemId: id, ...overrides }),
  };
}

async function readyStore(options: Parameters<typeof createInMemoryVectorStore>[0] = {}) {
  const store = createInMemoryVectorStore(options);
  const ensured = await store.ensureCollection(STAMP);
  if (ensured.kind !== 'ok') throw new Error(`ensureCollection failed: ${ensured.kind}`);
  return store;
}

// ------------------------------------------------------------------------------ the ranking

describe('cosine ranking', () => {
  const QUERY = 'the session state machine forbids moving backwards';

  it('ranks a near-duplicate above a loose match above an unrelated chunk', async () => {
    const store = await readyStore();
    await store.upsert([
      await point('id-near', 'the session state machine forbids moving backward'),
      await point('id-loose', 'the state machine for sessions has forbidden transitions'),
      await point('id-far', 'quarterly revenue projections for the northern region'),
    ]);

    const result = await store.search({ vector: await vectorFor(QUERY), limit: 3 });
    if (result.kind !== 'ok') throw new Error(result.kind);

    expect(result.value.map((hit) => hit.id)).toEqual(['id-near', 'id-loose', 'id-far']);
    // And the scores are genuinely ordered, not merely the ids.
    const scores = result.value.map((hit) => hit.score);
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 1);
    expect(scores[1]).toBeGreaterThan(scores[2] ?? 1);
  });

  it('returns an exact match at a similarity of 1', async () => {
    const store = await readyStore();
    await store.upsert([await point('id-exact', QUERY)]);

    const result = await store.search({ vector: await vectorFor(QUERY), limit: 1 });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value[0]?.score).toBeCloseTo(1, 10);
  });

  it('honours the limit', async () => {
    const store = await readyStore();
    await store.upsert([
      await point('id-1', 'alpha alpha alpha'),
      await point('id-2', 'alpha alpha beta'),
      await point('id-3', 'gamma delta epsilon'),
    ]);

    const result = await store.search({ vector: await vectorFor('alpha alpha alpha'), limit: 2 });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value).toHaveLength(2);
  });

  it('drops hits below minScore rather than padding the result to the limit', async () => {
    const store = await readyStore();
    await store.upsert([
      await point('id-near', QUERY),
      await point('id-far', 'entirely unrelated bookkeeping about invoices'),
    ]);

    const result = await store.search({
      vector: await vectorFor(QUERY),
      limit: 5,
      minScore: 0.9,
    });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value.map((hit) => hit.id)).toEqual(['id-near']);
  });

  it('breaks ties by id so the order is total across platforms', async () => {
    const store = await readyStore();
    // Same text, so identical vectors and identical scores.
    await store.upsert([await point('id-b', 'same'), await point('id-a', 'same')]);

    const result = await store.search({ vector: await vectorFor('same'), limit: 2 });
    if (result.kind !== 'ok') throw new Error(result.kind);
    expect(result.value.map((hit) => hit.id)).toEqual(['id-a', 'id-b']);
  });
});

// ------------------------------------------------------------------------------- the filters

describe('filters', () => {
  async function seeded() {
    const store = await readyStore();
    await store.upsert([
      await point('p-alpha', 'shared text', {
        tier: 'project',
        projectId: 'alpha',
        sessionId: null,
      }),
      await point('p-beta', 'shared text', { tier: 'project', projectId: 'beta', sessionId: null }),
      await point('s-alpha', 'shared text', {
        tier: 'session',
        projectId: 'alpha',
        sessionId: 'session-1',
      }),
      await point('g-1', 'shared text', {
        tier: 'global',
        projectId: null,
        sessionId: null,
        sourceType: 'adr',
      }),
    ]);
    return store;
  }

  async function search(
    store: Awaited<ReturnType<typeof seeded>>,
    filter: Parameters<typeof store.search>[0]['filter'],
  ): Promise<string[]> {
    const result = await store.search({
      vector: await vectorFor('shared text'),
      limit: 10,
      filter,
    });
    if (result.kind !== 'ok') throw new Error(result.kind);
    return result.value.map((hit) => hit.id).sort();
  }

  it('returns everything when no filter is given', async () => {
    expect(await search(await seeded(), undefined)).toEqual([
      'g-1',
      'p-alpha',
      'p-beta',
      's-alpha',
    ]);
  });

  it('ORs within a field', async () => {
    expect(await search(await seeded(), { tiers: ['project', 'global'] })).toEqual([
      'g-1',
      'p-alpha',
      'p-beta',
    ]);
  });

  it('ANDs across fields', async () => {
    expect(await search(await seeded(), { tiers: ['project'], projectIds: ['alpha'] })).toEqual([
      'p-alpha',
    ]);
  });

  it('treats an empty allowlist as "nothing matches", never as "no constraint"', async () => {
    // Silently widening an empty scope filter into "everything" is how visibility leaks.
    expect(await search(await seeded(), { projectIds: [] })).toEqual([]);
  });

  it('never matches a null payload field against an allowlist', async () => {
    // `g-1` is global-tier and has no projectId. "Belongs to no project" is not a member of any
    // project allowlist, so it is excluded even by an allowlist naming every project there is.
    expect(await search(await seeded(), { projectIds: ['alpha', 'beta'] })).toEqual([
      'p-alpha',
      'p-beta',
      's-alpha',
    ]);
  });

  it('filters by source type and by embedding model', async () => {
    const store = await seeded();
    expect(await search(store, { sourceTypes: ['adr'] })).toEqual(['g-1']);
    expect(await search(store, { embeddingModels: [STAMP.model] })).toHaveLength(4);
    expect(await search(store, { embeddingModels: ['some-other-model'] })).toEqual([]);
  });
});

// -------------------------------------------------------------------------------- the gates

describe('the verification gate', () => {
  it('refuses to upsert before ensureCollection has run', async () => {
    const store = createInMemoryVectorStore();
    await expect(store.upsert([await point('id-1', 'x')])).rejects.toThrow(/has not been verified/);
  });

  it('refuses to search before ensureCollection has run', async () => {
    const store = createInMemoryVectorStore();
    await expect(store.search({ vector: await vectorFor('x'), limit: 1 })).rejects.toThrow(
      /has not been verified/,
    );
  });
});

describe('dimension enforcement', () => {
  it('refuses a wrongly-sized vector rather than storing it', async () => {
    const store = await readyStore();
    const bad: MemoryPoint = { id: 'id-bad', vector: [1, 2, 3], payload: payload() };

    await expect(store.upsert([bad])).rejects.toBeInstanceOf(VectorDimensionError);
    expect(store.points).toHaveLength(0);
  });

  it('rejects the whole batch rather than half-applying it', async () => {
    const store = await readyStore();
    await expect(
      store.upsert([
        await point('id-good', 'fine'),
        { id: 'id-bad', vector: [1, 2, 3], payload: payload() },
      ]),
    ).rejects.toBeInstanceOf(VectorDimensionError);

    expect(store.points).toHaveLength(0);
  });

  it('refuses a wrongly-sized query vector', async () => {
    const store = await readyStore();
    await expect(store.search({ vector: [1, 2], limit: 1 })).rejects.toBeInstanceOf(
      VectorDimensionError,
    );
  });
});

describe('the stamp gate', () => {
  it('creates and stamps a collection that does not exist', async () => {
    const store = createInMemoryVectorStore();
    const result = await store.ensureCollection(STAMP);
    if (result.kind !== 'ok') throw new Error(result.kind);

    expect(result.value.created).toBe(true);
    expect(result.value.info.stamp).toEqual(STAMP);
  });

  it('refuses a collection stamped for a different model', async () => {
    const store = createInMemoryVectorStore({
      existingStamp: { model: 'mxbai-embed-large', dimension: 64 },
    });
    await expect(store.ensureCollection(STAMP)).rejects.toBeInstanceOf(EmbeddingStampMismatchError);
  });

  it('refuses a collection built for a different dimension', async () => {
    const store = createInMemoryVectorStore({
      existingStamp: { model: STAMP.model, dimension: 1024 },
    });
    await expect(store.ensureCollection(STAMP)).rejects.toBeInstanceOf(EmbeddingStampMismatchError);
  });

  it('leaves the store unwritable after a refusal', async () => {
    const store = createInMemoryVectorStore({
      existingStamp: { model: 'mxbai-embed-large', dimension: 64 },
    });
    await store.ensureCollection(STAMP).catch(() => undefined);

    // The refusal is not advisory: nothing may be written afterwards either.
    await expect(store.upsert([await point('id-1', 'x')])).rejects.toThrow(/has not been verified/);
  });

  it('is idempotent — a second ensure over a matching collection is a no-op', async () => {
    const store = await readyStore();
    const again = await store.ensureCollection(STAMP);
    if (again.kind !== 'ok') throw new Error(again.kind);
    expect(again.value).toMatchObject({ created: false, adopted: false });
  });
});

// ------------------------------------------------------------------------------- deletion

describe('deleteByFilter', () => {
  it('deletes only what the filter names', async () => {
    const store = await readyStore();
    await store.upsert([
      await point('p-alpha', 'x', { projectId: 'alpha' }),
      await point('p-beta', 'x', { projectId: 'beta' }),
    ]);

    const deleted = await store.deleteByFilter({ projectIds: ['alpha'] });
    if (deleted.kind !== 'ok') throw new Error(deleted.kind);

    expect(deleted.value.deleted).toBe(1);
    expect(store.points.map((entry) => entry.id)).toEqual(['p-beta']);
  });

  it('refuses an empty filter rather than erasing the index', async () => {
    const store = await readyStore();
    await store.upsert([await point('p-1', 'x')]);

    const result = await store.deleteByFilter({});
    expect(result).toMatchObject({ kind: 'failed' });
    expect(store.points).toHaveLength(1);
  });

  it('selects stale rows by model — the partial re-index cleanup', async () => {
    const store = await readyStore();
    await store.upsert([
      await point('old-1', 'x', { embeddingModel: 'previous-model' }),
      await point('new-1', 'x', { embeddingModel: STAMP.model }),
    ]);

    const deleted = await store.deleteByFilter({ embeddingModels: ['previous-model'] });
    if (deleted.kind !== 'ok') throw new Error(deleted.kind);
    expect(store.points.map((entry) => entry.id)).toEqual(['new-1']);
  });
});

// ------------------------------------------------------------------------- failure as data

describe('failures are data', () => {
  it('reports an unreachable store as an outcome, not an exception', async () => {
    const store = await readyStore();
    store.failWith({ kind: 'unreachable', reason: 'connect ECONNREFUSED 127.0.0.1:6333' });

    const result = await store.search({ vector: await vectorFor('x'), limit: 1 });
    expect(result).toMatchObject({ kind: 'unreachable' });
  });

  it('reports a timeout as an outcome', async () => {
    const store = await readyStore();
    store.failWith({ kind: 'timeout', timeoutMs: 1500 });
    expect(await store.describeCollection()).toMatchObject({ kind: 'timeout', timeoutMs: 1500 });
  });
});
