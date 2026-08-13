import { createHash } from 'node:crypto';
import {
  createFakeEmbedder,
  createInMemoryVectorStore,
  MAX_EMBEDDING_DIMENSION,
  newId,
  schema,
  settingKey,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  seedProject,
  seedSession,
  seedUser,
  setSecretPresent,
  setSetting,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';

/**
 * The Phase 3 memory foundation against real PostgreSQL.
 *
 * What only this tier can prove:
 *
 *  - the `memory_items` CHECK constraints **actually run in PostgreSQL** rather than merely
 *    being written down in the Drizzle schema — a tier/scope combination that should be
 *    unrepresentable is rejected by the database, not by a TypeScript type;
 *  - the two partial unique indexes make a re-index idempotent per model, and let a *second*
 *    model's rows coexist with the first's, which is what a partial re-index needs;
 *  - the settings reader resolves the same rows the Settings API writes, including the
 *    encrypted Qdrant API key;
 *  - the Services health rows change from `disabled` to real once a model is configured, and
 *    the API key never appears in the HTTP response.
 */

let built: TestApp;

const HASH = createHash('sha256').update('a chunk of transcript').digest('hex');

beforeEach(async () => {
  await truncateAll();
  built = createTestApp();
});

afterEach(async () => {
  await truncateAll();
});

interface RowInput {
  tier?: string;
  projectId?: string | null;
  sessionId?: string | null;
  agentId?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  sourceRef?: string | null;
  chunkOrdinal?: number;
  content?: string | null;
  contentHash?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  id?: string;
  qdrantPointId?: string;
}

async function insertMemoryItem(input: RowInput = {}): Promise<string> {
  const id = input.id ?? newId();
  await testDatabase()
    .db.insert(schema.memoryItems)
    .values({
      id,
      tier: input.tier ?? 'global',
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      agentId: input.agentId ?? null,
      sourceType: input.sourceType ?? 'adr',
      sourceId: input.sourceId === undefined ? newId() : input.sourceId,
      sourceRef: input.sourceRef ?? null,
      chunkOrdinal: input.chunkOrdinal ?? 0,
      content: input.content === undefined ? 'a chunk of transcript' : input.content,
      contentHash: input.contentHash ?? HASH,
      embeddingModel: input.embeddingModel ?? 'nomic-embed-text',
      embeddingDimension: input.embeddingDimension ?? 768,
      qdrantPointId: input.qdrantPointId ?? id,
    });
  return id;
}

/**
 * Assert that an insert is rejected by a **named** constraint.
 *
 * Not `rejects.toThrow(/name/)`: Drizzle wraps the driver error, so its own `message` is only
 * "Failed query: insert into …" and the constraint name lives in `error.cause`. Matching on the
 * wrapper would pass for *any* failed insert — including a typo in the fixture — which would
 * make every one of these tests vacuous.
 */
async function expectRejectedBy(work: Promise<unknown>, constraint: string): Promise<void> {
  let thrown: unknown;
  try {
    await work;
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`Expected the insert to be rejected by ${constraint}, but it succeeded`);
  }

  const chain: string[] = [];
  let current: unknown = thrown;
  while (current instanceof Error) {
    chain.push(current.message);
    current = current.cause;
  }
  expect(chain.join(' | ')).toContain(constraint);
}

// ------------------------------------------------------------------------------ the schema

describe('memory_items scope constraints (ck_memory_items_tier_scope)', () => {
  it('stores a global-tier row with no scope', async () => {
    await expect(insertMemoryItem({ tier: 'global' })).resolves.toBeTruthy();
  });

  it('stores a project-tier row scoped to a project', async () => {
    const { projectId } = await seedProject();
    await expect(insertMemoryItem({ tier: 'project', projectId })).resolves.toBeTruthy();
  });

  it('stores a session-tier row carrying its project for filtering', async () => {
    const { projectId } = await seedProject();
    const userId = (await seedUser()).id;
    const sessionId = await seedSession({ projectId, userId });

    await expect(insertMemoryItem({ tier: 'session', sessionId, projectId })).resolves.toBeTruthy();
  });

  it('REJECTS a project-tier row with no project — an unretrievable memory', async () => {
    // Without the CHECK this row is storable, invisible to every project-scoped query, and
    // reported missing by nothing.
    await expectRejectedBy(
      insertMemoryItem({ tier: 'project', projectId: null }),
      'ck_memory_items_tier_scope',
    );
  });

  it('REJECTS a session-tier row with no session', async () => {
    await expectRejectedBy(
      insertMemoryItem({ tier: 'session', sessionId: null }),
      'ck_memory_items_tier_scope',
    );
  });

  it('REJECTS a global-tier row that carries a project', async () => {
    const { projectId } = await seedProject();
    await expectRejectedBy(
      insertMemoryItem({ tier: 'global', projectId }),
      'ck_memory_items_tier_scope',
    );
  });

  it('REJECTS an unknown tier', async () => {
    await expectRejectedBy(insertMemoryItem({ tier: 'workspace' }), 'ck_memory_items_tier');
  });

  it('accepts the agent tier that nothing produces yet, so Phase 4 needed no migration', async () => {
    // Phase 4's first slice made `agents` a real table; the tier it points at is still
    // producer-less (`PRODUCIBLE_MEMORY_TIERS` excludes it), which is why this test inserts the
    // row by hand and why nothing else in the suite ever sees an `agent`-tier chunk.
    const agentId = newId();
    await testDatabase()
      .db.insert(schema.agents)
      .values({
        id: agentId,
        name: 'Architect',
        scope: 'global',
        permissions: { repository: { read: true, write: false, shell: false } },
      });

    await expect(insertMemoryItem({ tier: 'agent', agentId })).resolves.toBeTruthy();
  });
});

describe('memory_items provenance constraints', () => {
  it('stores a row-sourced chunk by id', async () => {
    await expect(
      insertMemoryItem({ sourceType: 'commit', sourceId: newId() }),
    ).resolves.toBeTruthy();
  });

  it('stores a file-sourced chunk by vault-relative ref, with no content', async () => {
    await expect(
      insertMemoryItem({
        sourceType: 'obsidian_note',
        sourceId: null,
        sourceRef: 'Sessions/2026-08-13-launch.md',
        content: null,
      }),
    ).resolves.toBeTruthy();
  });

  it('REJECTS a row with both a source id and a source ref', async () => {
    await expectRejectedBy(
      insertMemoryItem({ sourceId: newId(), sourceRef: 'Notes/x.md' }),
      'ck_memory_items_source_identity',
    );
  });

  it('REJECTS a row with neither', async () => {
    await expectRejectedBy(
      insertMemoryItem({ sourceId: null, sourceRef: null }),
      'ck_memory_items_source_identity',
    );
  });

  it('REJECTS a row with neither content nor a pointer to it', async () => {
    // A hit that can be ranked but never shown is worse than no hit.
    await expectRejectedBy(
      insertMemoryItem({ sourceId: newId(), sourceRef: null, content: null }),
      'ck_memory_items_content_presence',
    );
  });

  it('REJECTS an unknown source type', async () => {
    await expectRejectedBy(
      insertMemoryItem({ sourceType: 'slack_message' }),
      'ck_memory_items_source_type',
    );
  });

  it('REJECTS a negative chunk ordinal', async () => {
    await expectRejectedBy(insertMemoryItem({ chunkOrdinal: -1 }), 'ck_memory_items_chunk_ordinal');
  });
});

describe('memory_items stamp constraints', () => {
  it('REJECTS an empty embedding model — an unattributable vector', async () => {
    await expectRejectedBy(
      insertMemoryItem({ embeddingModel: '' }),
      'ck_memory_items_embedding_model',
    );
  });

  it('REJECTS a zero or oversized dimension', async () => {
    await expectRejectedBy(
      insertMemoryItem({ embeddingDimension: 0 }),
      'ck_memory_items_embedding_dimension',
    );
    await expectRejectedBy(
      insertMemoryItem({ embeddingDimension: MAX_EMBEDDING_DIMENSION + 1 }),
      'ck_memory_items_embedding_dimension',
    );
  });

  it('REJECTS a content hash that is not 64 hex characters', async () => {
    await expectRejectedBy(
      insertMemoryItem({ contentHash: 'not-a-sha256' }),
      'ck_memory_items_content_hash',
    );
  });
});

describe('memory_items uniqueness — what makes a re-index safe', () => {
  it('rejects a duplicate (source, chunk, model) so re-indexing is idempotent', async () => {
    const sourceId = newId();
    await insertMemoryItem({ sourceType: 'session', sourceId, chunkOrdinal: 3 });

    await expectRejectedBy(
      insertMemoryItem({ sourceType: 'session', sourceId, chunkOrdinal: 3 }),
      'ux_memory_items_source_chunk',
    );
  });

  it('allows the SAME chunk under a DIFFERENT model — the partial re-index case', async () => {
    // The old vectors must keep answering queries until the new set is complete.
    const sourceId = newId();
    await insertMemoryItem({ sourceId, chunkOrdinal: 0, embeddingModel: 'nomic-embed-text' });

    await expect(
      insertMemoryItem({
        sourceId,
        chunkOrdinal: 0,
        embeddingModel: 'mxbai-embed-large',
        embeddingDimension: 1024,
      }),
    ).resolves.toBeTruthy();
  });

  it('applies the same rule to file-sourced chunks', async () => {
    const ref = 'ADRs/0007-pg-boss.md';
    await insertMemoryItem({ sourceType: 'adr', sourceId: null, sourceRef: ref, chunkOrdinal: 0 });

    await expectRejectedBy(
      insertMemoryItem({ sourceType: 'adr', sourceId: null, sourceRef: ref, chunkOrdinal: 0 }),
      'ux_memory_items_source_ref_chunk',
    );
  });

  it('rejects two rows claiming the same Qdrant point', async () => {
    const pointId = newId();
    await insertMemoryItem({ qdrantPointId: pointId });

    await expectRejectedBy(
      insertMemoryItem({ qdrantPointId: pointId }),
      'ux_memory_items_qdrant_point',
    );
  });
});

describe('memory_items cascades', () => {
  it('drops a session-tier memory when its session is deleted', async () => {
    const { projectId } = await seedProject();
    const userId = (await seedUser()).id;
    const sessionId = await seedSession({ projectId, userId });
    const memoryId = await insertMemoryItem({ tier: 'session', sessionId, projectId });

    await testDatabase().db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));

    const rows = await testDatabase()
      .db.select({ id: schema.memoryItems.id })
      .from(schema.memoryItems)
      .where(eq(schema.memoryItems.id, memoryId));
    expect(rows).toEqual([]);
  });
});

// ----------------------------------------------------------------------- the settings read

describe('reading the memory configuration', () => {
  it('reports not_configured on a fresh install', async () => {
    const result = await built.memory.verify();
    expect(result).toMatchObject({ kind: 'not_configured' });
  });

  it('resolves host, port and model once an embedding model is saved', async () => {
    await setSetting(
      'integrations',
      settingKey('integrations.qdrant.embeddingModel'),
      'nomic-embed-text',
    );
    await setSetting('integrations', settingKey('integrations.qdrant.port'), 7333);
    await setSetting('integrations', settingKey('integrations.ollama.host'), '10.0.0.5');

    const seen: unknown[] = [];
    const app = createTestApp({
      memoryClients: (config) => {
        seen.push(config);
        return {
          embedder: createFakeEmbedder({ model: config.embeddingModel, dimension: 768 }),
          store: createInMemoryVectorStore({ collection: 'mc_memory' }),
        };
      },
    });

    const report = await app.memory.verify();
    expect(report).toMatchObject({ kind: 'ready', created: true });
    expect(seen[0]).toMatchObject({
      qdrant: { host: '127.0.0.1', port: 7333 },
      ollama: { host: '10.0.0.5', port: 11434 },
      embeddingModel: 'nomic-embed-text',
    });
  });

  it('reports secret_unreadable when the stored API key does not decrypt', async () => {
    await setSetting(
      'integrations',
      settingKey('integrations.qdrant.embeddingModel'),
      'nomic-embed-text',
    );
    // Inert bytes: sealed under no key at all, so the vault cannot authenticate them.
    await setSecretPresent('integrations', settingKey('integrations.qdrant.apiKey'));

    const report = await createTestApp().memory.verify();
    expect(report).toMatchObject({ kind: 'not_configured' });
    expect(report.message).toMatch(/could not be decrypted|does not match/i);
  });
});

// ------------------------------------------------------------------------- the health rows

describe('GET /api/v1/services/health', () => {
  async function readRows(
    app: TestApp,
  ): Promise<Record<string, { status: string; detail: string }>> {
    const model = await app.serviceHealth.read();
    return Object.fromEntries(
      model.services.map((service) => [
        service.name,
        { status: service.status, detail: service.detail ?? '' },
      ]),
    );
  }

  it('reports Qdrant and Ollama disabled until an embedding model is configured', async () => {
    const rows = await readRows(built);
    expect(rows['qdrant']?.status).toBe('disabled');
    expect(rows['ollama']?.status).toBe('disabled');
    expect(rows['qdrant']?.detail).toContain('embeddingModel');
  });

  it('reports real rows once configured', async () => {
    await setSetting(
      'integrations',
      settingKey('integrations.qdrant.embeddingModel'),
      'nomic-embed-text',
    );

    const store = createInMemoryVectorStore({
      collection: 'mc_memory',
      existingStamp: { model: 'nomic-embed-text', dimension: 768 },
      existingPointCount: 7,
    });
    const app = createTestApp({
      memoryClients: () => ({
        embedder: createFakeEmbedder({ model: 'nomic-embed-text', dimension: 768 }),
        store,
      }),
    });

    const rows = await readRows(app);
    expect(rows['ollama']?.status).toBe('healthy');
    expect(rows['qdrant']?.status).toBe('healthy');
    expect(rows['qdrant']?.detail).toContain('nomic-embed-text (768d)');
  });

  it('reports a stamp mismatch as down, with both models named', async () => {
    await setSetting(
      'integrations',
      settingKey('integrations.qdrant.embeddingModel'),
      'nomic-embed-text',
    );

    const app = createTestApp({
      memoryClients: () => ({
        embedder: createFakeEmbedder({ model: 'nomic-embed-text', dimension: 768 }),
        store: createInMemoryVectorStore({
          collection: 'mc_memory',
          existingStamp: { model: 'mxbai-embed-large', dimension: 768 },
          existingPointCount: 500,
        }),
      }),
    });

    const rows = await readRows(app);
    expect(rows['qdrant']?.status).toBe('down');
    expect(rows['qdrant']?.detail).toContain('mxbai-embed-large');
    expect(rows['qdrant']?.detail).toContain('nomic-embed-text');
  });

  it('never puts the Qdrant API key in the HTTP response', async () => {
    const apiKey = 'qdrant_int_test_plaintext_key_0987654321';

    // **One app for the whole test, and that is load-bearing**: `testConfig()` mints a fresh
    // random `MC_ENCRYPTION_KEY` per call, so a second app could not decrypt what the first
    // sealed — it would report `secret_unreadable` and the scan below would prove nothing.
    //
    // Its store's failure text quotes the key the way a transport error quoting a URL would,
    // which is exactly the shape that leaked credentials in the Telegram integration.
    const store = createInMemoryVectorStore({ collection: 'mc_memory' });
    store.failWith({
      kind: 'unreachable',
      reason: `getaddrinfo ENOTFOUND https://${apiKey}@qdrant.internal`,
    });
    const app = createTestApp({
      memoryClients: () => ({
        embedder: createFakeEmbedder({ model: 'nomic-embed-text', dimension: 768 }),
        store,
      }),
    });

    const user = await seedUser();
    const login = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: user.username, password: user.password },
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw.join('; ') : (raw ?? '');

    // Saved through the real settings service, so the key is really sealed into `secret_items`
    // and really unsealed again by the memory config reader.
    const saved = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/qdrant',
      headers: { cookie },
      payload: { host: '127.0.0.1', port: 6333, apiKey, embeddingModel: 'nomic-embed-text' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(apiKey);

    const response = await app.app.inject({
      method: 'GET',
      url: '/api/v1/services/health',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    // Proves the key really did reach the adapter — otherwise the scan below is vacuous.
    expect(response.body).toContain('«redacted»');
    // The whole serialized response, not one field — the only assertion that stays true when
    // someone adds a field later.
    expect(response.body).not.toContain(apiKey);
  });
});

// ------------------------------------------------------------- changing the model takes effect

/**
 * Changing the embedding model in Settings must take effect **without a restart**.
 *
 * `runtime.ts` states this as its contract and nothing implemented it: no module subscribed to
 * `setting.updated`, so the verified runtime — embedder, store, stamp, chunk budget — was cached
 * for the life of the process. The operator-visible failure is the nastiest kind, because it is
 * silent: after switching models you keep receiving ten confident results, retrieved from the
 * collection the *previous* model built. Mismatched vectors do not return fewer matches, they
 * return wrong ones, and `stamp_mismatch` — the state built precisely to refuse this — could
 * never be reached until someone restarted the backend.
 *
 * Only this tier can prove it: the chain is HTTP → settings service → transactional outbox →
 * event bus → the memory subscriber, and the three middle links are real infrastructure. A unit
 * test of the predicate (`invalidation.test.ts`) cannot show that the event ever arrives.
 */
describe('a settings change invalidates the verified runtime', () => {
  /** Log in over HTTP so the write travels the operator's real path, cookie and all. */
  async function loginTo(app: TestApp): Promise<string> {
    const user = await seedUser();
    const login = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: user.username, password: user.password },
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers['set-cookie'];
    return Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
  }

  /** Every model the runtime has built an embedder for, in order. The witness for re-resolution. */
  function appOverModels(seen: string[]): TestApp {
    return createTestApp({
      memoryClients: (config) => {
        seen.push(config.embeddingModel);
        return {
          embedder: createFakeEmbedder({ model: config.embeddingModel, dimension: 768 }),
          // A fresh store per resolution, so this test isolates invalidation rather than
          // re-testing the stamp check that `health.ts` already covers.
          store: createInMemoryVectorStore({ collection: 'mc_memory' }),
        };
      },
    });
  }

  it('re-resolves with the new embedding model after a real settings write', async () => {
    await setSetting(
      'integrations',
      settingKey('integrations.qdrant.embeddingModel'),
      'nomic-embed-text',
    );

    const seen: string[] = [];
    const app = appOverModels(seen);
    const cookie = await loginTo(app);

    // Warm it, exactly as a first query would.
    const before = await app.memory.runtime.ready();
    expect(before.kind).toBe('ready');
    if (before.kind === 'ready') expect(before.stamp.model).toBe('nomic-embed-text');
    expect(app.memory.runtime.cached).toBe(true);

    const saved = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/qdrant',
      headers: { cookie },
      payload: { host: '127.0.0.1', port: 6333, embeddingModel: 'mxbai-embed-large' },
    });
    expect(saved.statusCode).toBe(200);

    // The cache is gone by the time the write returns — the outbox publishes to the bus in the
    // same synchronous step as the commit, so no polling or waiting is involved.
    expect(app.memory.runtime.cached).toBe(false);

    const after = await app.memory.runtime.ready();
    expect(after.kind).toBe('ready');
    if (after.kind === 'ready') expect(after.stamp.model).toBe('mxbai-embed-large');
    // The property that failed before the fix: a *second* resolution happened, against the
    // model the operator just chose.
    expect(seen).toEqual(['nomic-embed-text', 'mxbai-embed-large']);
  });

  it('keeps the cache when an unrelated integration is written', async () => {
    // The other half. An invalidator that fired on every `setting.updated` would also pass the
    // test above, while throwing away a verified runtime — three round trips, one of them a
    // cold model load — every time an unrelated setting was saved.
    await setSetting(
      'integrations',
      settingKey('integrations.qdrant.embeddingModel'),
      'nomic-embed-text',
    );

    const seen: string[] = [];
    const app = appOverModels(seen);
    const cookie = await loginTo(app);

    expect((await app.memory.runtime.ready()).kind).toBe('ready');
    expect(app.memory.runtime.cached).toBe(true);

    const saved = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/telegram',
      headers: { cookie },
      payload: { chatId: '12345', enabled: false },
    });
    expect(saved.statusCode).toBe(200);

    expect(app.memory.runtime.cached).toBe(true);
    expect(seen).toEqual(['nomic-embed-text']);
  });
});
