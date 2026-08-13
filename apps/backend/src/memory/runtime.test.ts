import {
  createFailingEmbedder,
  createFakeEmbedder,
  createInMemoryVectorStore,
  DEFAULT_MAX_CHUNK_BYTES,
} from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryRuntime } from './runtime.js';
import type { MemoryConfigResult } from './settings.js';

/**
 * The verified runtime — one stamp verification, shared by indexing and retrieval.
 *
 * The property worth protecting: `ensureCollection` is the gate that declares a collection safe
 * to write and query, and its danger is that a wrong answer is invisible. Two independent
 * verifications are two chances to disagree, so there is exactly one, cached, and these tests
 * pin both halves of that — that it is cached when it succeeds, and that it is *not* cached when
 * it fails, because a stopped Ollama is a machine state an operator fixes while this process
 * keeps running.
 */

const CONFIGURED: MemoryConfigResult = {
  kind: 'configured',
  config: {
    qdrant: { host: '127.0.0.1', port: 6333, apiKey: null },
    ollama: { host: '127.0.0.1', port: 11434 },
    embeddingModel: 'nomic-embed-text',
  },
};

function runtimeOver(
  readConfig: () => Promise<MemoryConfigResult>,
  build?: () => {
    embedder: ReturnType<typeof createFakeEmbedder>;
    store: ReturnType<typeof createInMemoryVectorStore>;
  },
) {
  const store = createInMemoryVectorStore({ collection: 'mc_memory_test' });
  const embedder = createFakeEmbedder({ model: 'nomic-embed-text', dimension: 768 });
  const clients = build ?? (() => ({ embedder, store }));
  return { runtime: createMemoryRuntime({ readConfig, build: clients }), store, embedder };
}

describe('resolution', () => {
  it('reports not_configured without touching either service', async () => {
    let built = 0;
    const runtime = createMemoryRuntime({
      readConfig: async () => ({
        kind: 'not_configured',
        reason: 'No embedding model is configured.',
        missing: ['qdrant_embedding_model'],
      }),
      build: () => {
        built += 1;
        throw new Error('should not be built');
      },
    });

    const state = await runtime.ready();
    expect(state.kind).toBe('not_configured');
    // The whole "an install that never opens Memory settings behaves exactly as Phase 2" claim.
    expect(built).toBe(0);
  });

  it('resolves the stamp and derives the chunk budget from the model window', async () => {
    const { runtime } = runtimeOver(async () => CONFIGURED);
    const state = await runtime.ready();

    expect(state.kind).toBe('ready');
    if (state.kind !== 'ready') return;
    expect(state.stamp).toEqual({ model: 'nomic-embed-text', dimension: 768 });
    // The fake declares `nomic-embed-text`'s real 2048-token window.
    expect(state.budget.contextDeclared).toBe(true);
    expect(state.budget.maxBytes).toBe(DEFAULT_MAX_CHUNK_BYTES);
  });

  it('creates and verifies the collection exactly once across many callers', async () => {
    const { runtime, store } = runtimeOver(async () => CONFIGURED);

    await Promise.all([runtime.ready(), runtime.ready(), runtime.ready()]);
    await runtime.ready();

    expect(store.calls.filter((call) => call === 'ensureCollection')).toHaveLength(1);
  });

  it('shrinks the budget for a model that declares a smaller window', async () => {
    const store = createInMemoryVectorStore({ collection: 'mc_memory_test' });
    const runtime = createMemoryRuntime({
      readConfig: async () => CONFIGURED,
      build: () => ({
        embedder: createFakeEmbedder({ model: 'all-minilm', dimension: 384, contextTokens: 256 }),
        store,
      }),
    });

    const state = await runtime.ready();
    if (state.kind !== 'ready') throw new Error(state.reason);
    expect(state.budget.maxBytes).toBeLessThan(256);
  });
});

describe('failures are not cached', () => {
  it('re-probes after the embedder was unavailable', async () => {
    let attempt = 0;
    const store = createInMemoryVectorStore({ collection: 'mc_memory_test' });
    const runtime = createMemoryRuntime({
      readConfig: async () => CONFIGURED,
      build: () => {
        attempt += 1;
        return {
          embedder:
            attempt === 1
              ? createFailingEmbedder({ kind: 'unreachable', reason: 'ECONNREFUSED' })
              : createFakeEmbedder({ model: 'nomic-embed-text', dimension: 768 }),
          store,
        };
      },
    });

    expect((await runtime.ready()).kind).toBe('unavailable');
    // The operator started Ollama. Without a restart.
    expect((await runtime.ready()).kind).toBe('ready');
  });

  it('reports a stamp mismatch as its own arm, with both models named', async () => {
    const runtime = createMemoryRuntime({
      readConfig: async () => CONFIGURED,
      build: () => ({
        embedder: createFakeEmbedder({ model: 'nomic-embed-text', dimension: 768 }),
        store: createInMemoryVectorStore({
          collection: 'mc_memory_test',
          existingStamp: { model: 'mxbai-embed-large', dimension: 768 },
          existingPointCount: 500,
        }),
      }),
    });

    const state = await runtime.ready();
    expect(state.kind).toBe('stamp_mismatch');
    if (state.kind !== 'stamp_mismatch') return;
    // Retrieval must refuse, not degrade: mismatched vectors return confident nonsense.
    expect(state.reason).toContain('mxbai-embed-large');
    expect(state.reason).toContain('nomic-embed-text');
    expect(state.detail.kind).toBe('model');
  });

  it('treats an undecryptable API key as unavailable, not unconfigured', async () => {
    const runtime = createMemoryRuntime({
      readConfig: async () => ({
        kind: 'secret_unreadable',
        reason: 'The stored Qdrant API key could not be decrypted',
        keyVersion: 1,
      }),
      build: () => {
        throw new Error('should not be built');
      },
    });

    const state = await runtime.ready();
    expect(state.kind).toBe('unavailable');
  });
});

describe('invalidation', () => {
  it('re-resolves after invalidate — how a model change takes effect without a restart', async () => {
    const { runtime, store } = runtimeOver(async () => CONFIGURED);

    await runtime.ready();
    expect(runtime.cached).toBe(true);

    runtime.invalidate();
    expect(runtime.cached).toBe(false);

    await runtime.ready();
    expect(store.calls.filter((call) => call === 'ensureCollection')).toHaveLength(2);
  });

  it('reset destroys every stored vector and re-stamps — the rebuild path', async () => {
    const { runtime, store } = runtimeOver(async () => CONFIGURED);
    const state = await runtime.ready();
    if (state.kind !== 'ready') throw new Error(state.reason);

    await store.upsert([
      {
        id: '00000000-0000-8000-8000-00000000000a',
        vector: new Array(768).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
        payload: {
          kind: 'chunk',
          memoryItemId: 'row-a',
          tier: 'global',
          projectId: null,
          sessionId: null,
          agentId: null,
          sourceType: 'obsidian_note',
          sourceId: null,
          sourceRef: 'x.md',
          chunkOrdinal: 0,
          embeddingModel: 'nomic-embed-text',
          embeddingDimension: 768,
        },
      },
    ]);
    expect(store.points).toHaveLength(1);

    const after = await runtime.reset();
    expect(after.kind).toBe('ready');
    expect(store.points).toHaveLength(0);
  });
});
