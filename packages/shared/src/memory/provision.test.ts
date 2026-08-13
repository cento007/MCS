import { describe, expect, it } from 'vitest';
import { createFailingEmbedder, createFakeEmbedder } from './fake-embedder.js';
import { createInMemoryVectorStore } from './memory-store.js';
import { provisionMemoryCollection } from './provision.js';

/**
 * Startup provisioning: identify the model, then stamp and verify the collection.
 *
 * The ordering is the thing under test. Stamping a collection with a dimension taken from a
 * setting or a manifest instead of from a vector the model actually produced is how a
 * collection ends up permanently mis-sized, and that mistake is unrecoverable without a full
 * re-index — so the dimension must be *measured* first, and every failure before that point
 * must stop the sequence rather than fall through to a guess.
 */

const embedder = (dimension = 768, model = 'nomic-embed-text') =>
  createFakeEmbedder({ model, dimension });

describe('a fresh install', () => {
  it('creates the collection stamped with the measured model and dimension', async () => {
    const store = createInMemoryVectorStore();
    const report = await provisionMemoryCollection({ embedder: embedder(), store });

    expect(report).toMatchObject({
      kind: 'ready',
      created: true,
      adopted: false,
      pointCount: 0,
      stampPersisted: true,
      stamp: { model: 'nomic-embed-text', dimension: 768 },
    });
    expect(report.kind === 'ready' && report.message).toContain('nomic-embed-text (768d)');
  });

  it('stamps with the dimension the model actually produced, not the configured name', async () => {
    // The fake is configured for 32; nothing anywhere declared 32. Only the measurement knows.
    const store = createInMemoryVectorStore();
    const report = await provisionMemoryCollection({ embedder: embedder(32), store });

    if (report.kind !== 'ready') throw new Error(report.kind);
    expect(report.stamp.dimension).toBe(32);
    const info = await store.describeCollection();
    expect(info.kind === 'ok' && info.value.vectorSize).toBe(32);
  });
});

describe('an existing install', () => {
  it('verifies an already-correct collection without creating or adopting', async () => {
    const store = createInMemoryVectorStore({
      existingStamp: { model: 'nomic-embed-text', dimension: 768 },
    });

    const report = await provisionMemoryCollection({ embedder: embedder(), store });
    expect(report).toMatchObject({ kind: 'ready', created: false, adopted: false });
  });

  it('is idempotent — running it twice changes nothing', async () => {
    const store = createInMemoryVectorStore();
    const first = await provisionMemoryCollection({ embedder: embedder(), store });
    const second = await provisionMemoryCollection({ embedder: embedder(), store });

    expect(first).toMatchObject({ kind: 'ready', created: true });
    expect(second).toMatchObject({ kind: 'ready', created: false, adopted: false });
  });

  it('adopts an empty, unstamped collection', async () => {
    const store = createInMemoryVectorStore({ existingPointCount: 0 });
    // Force "exists but unstamped" by seeding a point count of zero with no stamp — the
    // hand-created-collection case.
    const report = await provisionMemoryCollection({ embedder: embedder(), store });
    expect(report).toMatchObject({ kind: 'ready' });
  });
});

describe('the model changed under an existing collection', () => {
  it('reports stamp_mismatch instead of throwing — startup must continue', async () => {
    const store = createInMemoryVectorStore({
      existingStamp: { model: 'mxbai-embed-large', dimension: 768 },
    });

    const report = await provisionMemoryCollection({ embedder: embedder(768), store });

    expect(report.kind).toBe('stamp_mismatch');
    if (report.kind !== 'stamp_mismatch') return;
    expect(report.detail.kind).toBe('model');
    expect(report.message).toContain('nomic-embed-text');
    expect(report.message).toContain('mxbai-embed-large');
    expect(report.message).toContain('re-index');
  });

  it('reports a dimension change the same way', async () => {
    const store = createInMemoryVectorStore({
      existingStamp: { model: 'nomic-embed-text', dimension: 1024 },
    });

    const report = await provisionMemoryCollection({ embedder: embedder(768), store });
    expect(report.kind).toBe('stamp_mismatch');
    if (report.kind !== 'stamp_mismatch') return;
    expect(report.detail.kind).toBe('dimension');
  });

  it('leaves the store refusing writes after a mismatch', async () => {
    const store = createInMemoryVectorStore({
      existingStamp: { model: 'other-model', dimension: 768 },
    });
    await provisionMemoryCollection({ embedder: embedder(), store });

    await expect(
      store.upsert([
        {
          id: '0198f0a0-0000-7000-8000-000000000001',
          vector: new Array<number>(768).fill(0.1),
          payload: {
            kind: 'chunk',
            memoryItemId: 'm-1',
            tier: 'global',
            projectId: null,
            sessionId: null,
            agentId: null,
            sourceType: 'adr',
            sourceId: 'a-1',
            sourceRef: null,
            chunkOrdinal: 0,
            embeddingModel: 'nomic-embed-text',
            embeddingDimension: 768,
          },
        },
      ]),
    ).rejects.toThrow(/has not been verified/);
  });
});

describe('an unavailable dependency', () => {
  it('reports the embedder failure and never touches the store', async () => {
    const store = createInMemoryVectorStore();
    const report = await provisionMemoryCollection({
      embedder: createFailingEmbedder({
        kind: 'unreachable',
        reason: 'Could not reach http://127.0.0.1:11434 — connect ECONNREFUSED',
      }),
      store,
    });

    expect(report.kind).toBe('embedder_unavailable');
    expect(report.message).toContain('ECONNREFUSED');
    // Crucially: no collection was created from a guessed dimension.
    expect(store.calls).toEqual([]);
  });

  it('refuses to provision from a chat model, and creates nothing', async () => {
    const store = createInMemoryVectorStore();
    const report = await provisionMemoryCollection({
      embedder: createFailingEmbedder({
        kind: 'not_an_embedding_model',
        model: 'deepseek-r1:8b',
        capabilities: ['tools', 'thinking', 'completion'],
        reason: '"deepseek-r1:8b" is not an embedding model — pick nomic-embed-text',
      }),
      store,
    });

    expect(report.kind).toBe('embedder_unavailable');
    expect(report.message).toContain('is not an embedding model');
    expect(store.calls).toEqual([]);
  });

  it('reports an unreachable vector store', async () => {
    const store = createInMemoryVectorStore();
    store.failWith({ kind: 'unreachable', reason: 'connect ECONNREFUSED 127.0.0.1:6333' });

    const report = await provisionMemoryCollection({ embedder: embedder(), store });
    expect(report.kind).toBe('store_unavailable');
    expect(report.message).toContain('6333');
  });

  it('reports a vector-store timeout', async () => {
    const store = createInMemoryVectorStore();
    store.failWith({ kind: 'timeout', timeoutMs: 10_000 });

    const report = await provisionMemoryCollection({ embedder: embedder(), store });
    expect(report.kind).toBe('store_unavailable');
    expect(report.message).toContain('10000 ms');
  });
});
