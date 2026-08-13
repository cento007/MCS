import {
  createFailingEmbedder,
  createFakeEmbedder,
  createInMemoryVectorStore,
  type EmbeddingFailure,
  type InMemoryStoreFailure,
  REDACTION_PLACEHOLDER,
} from '@mc/shared';
import { describe, expect, it } from 'vitest';
import { createMemoryProbes, type MemoryClients } from './health.js';
import type { MemoryConfig, MemoryConfigResult } from './settings.js';

/**
 * The Qdrant and Ollama rows of `GET /services/health`.
 *
 * The property under test everywhere here is `health/services.ts`'s rule:
 * **a broken dependency is DATA, never an error.** Every situation an operator can actually
 * get into — no model configured, Ollama stopped, model not pulled, model is a chat model,
 * Qdrant stopped, collection missing, collection stamped for a different model — must come back
 * as a row with a status and a reason, and never as a thrown exception.
 *
 * No database and no network: the config is a literal and the clients are the fakes.
 */

const API_KEY = 'qdrant-key-must-never-appear-9876543210';

const CONFIG: MemoryConfig = {
  qdrant: { host: '127.0.0.1', port: 6333, apiKey: API_KEY },
  ollama: { host: '127.0.0.1', port: 11434 },
  embeddingModel: 'nomic-embed-text',
};

interface Wiring {
  readonly config?: MemoryConfigResult;
  readonly clients?: Partial<MemoryClients>;
}

function probes(wiring: Wiring = {}) {
  const store = createInMemoryVectorStore({ collection: 'mc_memory' });
  const embedder = createFakeEmbedder({ model: 'nomic-embed-text', dimension: 768 });

  return createMemoryProbes({
    readConfig: async () => wiring.config ?? { kind: 'configured', config: CONFIG },
    timeoutMs: 50,
    build: () => ({
      embedder: wiring.clients?.embedder ?? embedder,
      store: wiring.clients?.store ?? store,
    }),
  });
}

/** A store whose collection already exists, stamped correctly, with points in it. */
function provisionedStore(overrides: Parameters<typeof createInMemoryVectorStore>[0] = {}) {
  return createInMemoryVectorStore({
    collection: 'mc_memory',
    existingStamp: { model: 'nomic-embed-text', dimension: 768 },
    existingPointCount: 42,
    ...overrides,
  });
}

// ------------------------------------------------------------------------- not configured

describe('when no embedding model is configured', () => {
  const NOT_CONFIGURED: MemoryConfigResult = {
    kind: 'not_configured',
    reason: 'No embedding model is configured. Set `integrations.qdrant.embeddingModel` …',
    missing: ['qdrant_embedding_model'],
  };

  it('reports both rows as disabled, not down', async () => {
    const subject = probes({ config: NOT_CONFIGURED });

    for (const row of [await subject.qdrant(), await subject.ollama()]) {
      expect(row.status).toBe('disabled');
      expect(row.detail).toContain('embeddingModel');
      expect(row.meta).toMatchObject({ configured: false });
    }
  });
});

describe('when the stored API key cannot be decrypted', () => {
  it('reports down with the decryption reason, not "not configured"', async () => {
    const subject = probes({
      config: {
        kind: 'secret_unreadable',
        reason: 'MC_ENCRYPTION_KEY does not match the stored secret',
        keyVersion: 1,
      },
    });

    const row = await subject.qdrant();
    expect(row.status).toBe('down');
    expect(row.meta).toMatchObject({ configured: true, reason: 'secret_unreadable' });
  });
});

// -------------------------------------------------------------------------------- ollama

describe('the Ollama row', () => {
  it('is healthy and reports the model, dimension and capabilities', async () => {
    const row = await probes().ollama();

    expect(row.status).toBe('healthy');
    expect(row.detail).toContain('nomic-embed-text (768d)');
    expect(row.meta).toMatchObject({
      model: 'nomic-embed-text',
      dimension: 768,
      capabilities: ['embedding'],
      host: '127.0.0.1:11434',
    });
  });

  it.each<[string, EmbeddingFailure]>([
    [
      'unreachable',
      { kind: 'unreachable', reason: 'Could not reach http://127.0.0.1:11434 — ECONNREFUSED' },
    ],
    ['timeout', { kind: 'timeout', timeoutMs: 1500 }],
    [
      'model_missing',
      { kind: 'model_missing', model: 'nomic-embed-text', reason: 'Ollama has no model named …' },
    ],
    [
      'not_an_embedding_model',
      {
        kind: 'not_an_embedding_model',
        model: 'deepseek-r1:8b',
        capabilities: ['tools', 'thinking', 'completion'],
        reason: '"deepseek-r1:8b" is not an embedding model',
      },
    ],
  ])('reports %s as a down row rather than throwing', async (kind, failure) => {
    const row = await probes({ clients: { embedder: createFailingEmbedder(failure) } }).ollama();

    expect(row.status).toBe('down');
    expect(row.meta).toMatchObject({ reason: kind });
    expect(row.detail.length).toBeGreaterThan(0);
  });

  it('names the chat model’s capabilities so the operator knows why', async () => {
    const row = await probes({
      clients: {
        embedder: createFailingEmbedder({
          kind: 'not_an_embedding_model',
          model: 'deepseek-r1:8b',
          capabilities: ['tools', 'thinking', 'completion'],
          reason: '"deepseek-r1:8b" is not an embedding model — Ollama reports [tools, …]',
        }),
      },
    }).ollama();

    expect(row.meta).toMatchObject({ capabilities: ['tools', 'thinking', 'completion'] });
  });
});

// -------------------------------------------------------------------------------- qdrant

describe('the Qdrant row', () => {
  it('is healthy when the collection exists and its stamp agrees', async () => {
    const row = await probes({ clients: { store: provisionedStore() } }).qdrant();

    expect(row.status).toBe('healthy');
    expect(row.detail).toContain('42 points');
    expect(row.detail).toContain('nomic-embed-text (768d)');
    expect(row.meta).toMatchObject({ collection: 'mc_memory', exists: true, pointCount: 42 });
  });

  it('is degraded — not down — when nothing has been indexed yet', async () => {
    // A freshly configured instance is working exactly as designed. A red row for the normal
    // first-run state is a row operators learn to ignore.
    const row = await probes().qdrant();

    expect(row.status).toBe('degraded');
    expect(row.detail).toContain('does not exist yet');
    expect(row.meta).toMatchObject({ exists: false });
  });

  it.each<[string, InMemoryStoreFailure]>([
    ['unreachable', { kind: 'unreachable', reason: 'connect ECONNREFUSED 127.0.0.1:6333' }],
    ['timeout', { kind: 'timeout', timeoutMs: 1500 }],
    ['failed', { kind: 'failed', status: 500, reason: 'Qdrant answered 500' }],
  ])('reports %s as a down row rather than throwing', async (kind, failure) => {
    const store = provisionedStore();
    store.failWith(failure);

    const row = await probes({ clients: { store } }).qdrant();
    expect(row.status).toBe('down');
    expect(row.meta).toMatchObject({ reason: kind });
  });

  it('REPORTS a stamp mismatch as down, with the full remedy, instead of throwing', async () => {
    // The one place in the whole layer where `EmbeddingStampMismatchError` becomes data. It is
    // rendered `down` rather than `degraded` because a mismatched index does not return fewer
    // answers — it returns confidently wrong ones.
    const store = provisionedStore({
      existingStamp: { model: 'mxbai-embed-large', dimension: 768 },
    });

    const row = await probes({ clients: { store } }).qdrant();

    expect(row.status).toBe('down');
    expect(row.detail).toContain('mxbai-embed-large');
    expect(row.detail).toContain('nomic-embed-text');
    expect(row.detail).toContain('re-index');
    expect(row.meta).toMatchObject({
      reason: 'stamp_mismatch',
      mismatch: 'model',
      expectedModel: 'nomic-embed-text',
      foundModel: 'mxbai-embed-large',
    });
  });

  it('reports a dimension mismatch the same way', async () => {
    const store = provisionedStore({
      existingStamp: { model: 'nomic-embed-text', dimension: 384 },
    });

    const row = await probes({ clients: { store } }).qdrant();
    expect(row.status).toBe('down');
    expect(row.meta).toMatchObject({ mismatch: 'dimension', foundDimension: 384 });
  });

  it('is degraded, not down, when the stamp cannot be checked because Ollama is off', async () => {
    // An unverifiable stamp is not a failed stamp, and the Ollama row already carries the reason.
    const row = await probes({
      clients: {
        store: provisionedStore(),
        embedder: createFailingEmbedder({ kind: 'unreachable', reason: 'ECONNREFUSED' }),
      },
    }).qdrant();

    expect(row.status).toBe('degraded');
    expect(row.meta).toMatchObject({ reason: 'stamp_unverified' });
    expect(row.detail).toContain('could not be checked');
  });
});

// ------------------------------------------------------------------------------ boundedness

describe('boundedness', () => {
  it('passes its deadline to every probe so a hung dependency cannot hold the page open', async () => {
    const seen: (number | undefined)[] = [];
    const store = provisionedStore();
    const wrapped = {
      ...store,
      describeCollection: async (options?: { timeoutMs?: number | undefined }) => {
        seen.push(options?.timeoutMs);
        return store.describeCollection(options);
      },
    };

    await probes({ clients: { store: wrapped } }).qdrant();
    expect(seen).toEqual([50]);
  });
});

// ------------------------------------------------------------------------------ the API key

describe('the API key never reaches a health row', () => {
  it('is absent from every row, in every state, including the failure text', async () => {
    const rows: unknown[] = [];

    // Healthy.
    rows.push(await probes({ clients: { store: provisionedStore() } }).qdrant());
    rows.push(await probes().ollama());

    // Every failure mode, including ones whose reason text embeds the key the way a transport
    // error quoting a URL would.
    const leaky = provisionedStore();
    leaky.failWith({
      kind: 'unreachable',
      reason: `getaddrinfo ENOTFOUND https://${API_KEY}@qdrant.internal`,
    });
    rows.push(await probes({ clients: { store: leaky } }).qdrant());

    rows.push(
      await probes({
        clients: {
          embedder: createFailingEmbedder({
            kind: 'unreachable',
            reason: `proxy error for https://${API_KEY}@ollama.internal`,
          }),
        },
      }).ollama(),
    );

    // Stamp mismatch.
    rows.push(
      await probes({
        clients: {
          store: provisionedStore({ existingStamp: { model: 'other', dimension: 768 } }),
        },
      }).qdrant(),
    );

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(API_KEY);
    // The scan is meaningful — the key really was present in two of the inputs.
    expect(serialized).toContain(REDACTION_PLACEHOLDER);
  });
});
