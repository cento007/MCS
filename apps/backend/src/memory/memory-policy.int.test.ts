import {
  createFakeEmbedder,
  createInMemoryVectorStore,
  type FakeEmbeddingPort,
  type InMemoryVectorStore,
  newId,
  schema,
  settingKey,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  type SeededUser,
  seedAdr,
  seedMessage,
  seedProject,
  seedSession,
  seedUser,
  setSetting,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';

/**
 * Settings → Memory, enforced (PRD §4.4 item 4).
 *
 * The rule these tests exist to keep is the one this codebase has been bitten by twice —
 * `integrations.ollama.enabled` was read by nothing for three phases before it was withdrawn, and
 * the Telegram chat-id double-parse silently skipped every notification: **a setting that nothing
 * reads is a lie.**
 * So every assertion below is of the form "the operator flipped a switch and the behaviour
 * changed", against a real database, and never "the document round-trips".
 *
 * Two halves:
 *
 *  - **indexed sources** — a source switched off is not written *and* is not returned. Both, or
 *    the switch reads "off" while its results keep arriving.
 *  - **retention** — a tier's expired chunks leave `memory_items` **and** the vector store, and
 *    nothing at all happens while the default (`0`, never expire) stands.
 */

const MODEL = 'nomic-embed-text';
const DIMENSION = 768;

let embedder: FakeEmbeddingPort;
let store: InMemoryVectorStore;

interface AppOptions {
  readonly retentionBatchSize?: number;
}

async function configuredApp(options: AppOptions = {}): Promise<TestApp> {
  await setSetting('integrations', settingKey('integrations.qdrant.embeddingModel'), MODEL);
  embedder = createFakeEmbedder({ model: MODEL, dimension: DIMENSION, recordCalls: true });
  store = createInMemoryVectorStore({ collection: 'mc_memory_test' });

  return createTestApp({
    memoryClients: () => ({ embedder, store }),
    ...(options.retentionBatchSize === undefined
      ? {}
      : { memoryRetentionBatchSize: options.retentionBatchSize }),
  });
}

async function setIndexedSources(toggles: Record<string, boolean>): Promise<void> {
  await setSetting('memory', settingKey('memory.indexedSources'), toggles);
}

async function setRetentionDays(days: Record<string, number>): Promise<void> {
  await setSetting('memory', settingKey('memory.retentionDays'), days);
}

async function memoryRows() {
  return testDatabase().db.select().from(schema.memoryItems);
}

async function login(app: TestApp, user: SeededUser): Promise<string> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
}

beforeEach(async () => {
  await truncateAll();
});

afterEach(async () => {
  await truncateAll();
});

// ------------------------------------------------------------------------- indexed sources

describe('the indexed-source toggles gate indexing', () => {
  it('DOES NOT INDEX A SOURCE THAT IS SWITCHED OFF', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'PostgreSQL is the single substrate.' });

    await setIndexedSources({ adr: false });
    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });

    expect(await memoryRows()).toEqual([]);
    expect(store.points).toEqual([]);
    // And not one embedding call was spent finding that out.
    expect(embedder.calls).toEqual([]);
  });

  it('indexes the sources that are still on, in the same write', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'PostgreSQL is the single substrate.' });

    await setIndexedSources({ commit: false });
    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });

    expect((await memoryRows()).length).toBeGreaterThan(0);
  });

  it('skips a disabled stage in the backfill without reading its table', async () => {
    const { projectId } = await seedProject();
    await seedAdr({ projectId, decision: 'An ADR that will not be indexed.' });
    const userId = (await seedUser()).id;
    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: 'Kept' });
    await seedMessage({
      sessionId,
      ordinal: 0,
      role: 'user',
      content: 'A question worth keeping.',
    });

    await setIndexedSources({ adr: false });
    const app = await configuredApp();

    const run = await app.memory.indexing.trigger({ mode: 'incremental' });
    for (let slice = 0; slice < 40; slice += 1) {
      await app.memory.indexing.handle({ kind: 'backfill', runId: run.id });
      if ((await app.memory.indexing.status()).state === 'completed') break;
    }

    const types = new Set((await memoryRows()).map((row) => row.sourceType));
    expect(types.has('adr')).toBe(false);
    expect(types.has('session')).toBe(true);
    expect((await app.memory.indexing.status()).state).toBe('completed');
  });

  it('keeps already-indexed rows when a source is switched off, rather than discarding work', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'PostgreSQL is the single substrate.' });

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });
    const before = await memoryRows();
    expect(before.length).toBeGreaterThan(0);

    await setIndexedSources({ adr: false });
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });

    // Deliberate: re-embedding a corpus costs real model time, so turning a toggle off is not
    // a destructive action. `mode: 'rebuild'` is the destructive one, and it has to be typed.
    expect(await memoryRows()).toHaveLength(before.length);
  });
});

describe('the indexed-source toggles gate retrieval', () => {
  it('DOES NOT RETURN A DISABLED SOURCE’S CHUNKS, so the switch is not a label', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({
      projectId,
      title: 'Use pg-boss instead of Redis',
      decision: 'PostgreSQL is the single stateful substrate; pg-boss is the job queue.',
    });
    const user = await seedUser();

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });
    const cookie = await login(app, user);

    const search = async () =>
      app.app.inject({
        method: 'POST',
        url: '/api/v1/memory-items/search',
        headers: { cookie },
        payload: { q: 'PostgreSQL is the single stateful substrate', minScore: 0.2 },
      });

    const before = JSON.parse((await search()).body) as { data: { results: unknown[] } };
    expect(before.data.results.length).toBeGreaterThan(0);

    await setIndexedSources({ adr: false });

    const after = JSON.parse((await search()).body) as {
      data: { results: unknown[]; emptyReason: string };
    };
    // The rows are still there (nothing was deleted) — they simply stop answering.
    expect((await memoryRows()).length).toBeGreaterThan(0);
    expect(after.data.results).toEqual([]);
  });

  it('answers with a reason when every source the caller asked for is off', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'PostgreSQL holds the job queue.' });
    const user = await seedUser();

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });
    await setIndexedSources({ adr: false });

    const cookie = await login(app, user);
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      headers: { cookie },
      payload: { q: 'anything', sourceTypes: ['adr'], minScore: 0 },
    });

    const body = JSON.parse(response.body) as {
      data: { results: unknown[]; emptyReason: string; detail: string };
    };
    expect(body.data.results).toEqual([]);
    expect(body.data.emptyReason).toBe('index_empty');
    // Actionable: the operator's next step is a settings page, not a bug report.
    expect(body.data.detail).toContain('Settings → Memory');
  });
});

// ------------------------------------------------------------------------------- retention

describe('per-tier retention', () => {
  /** A chunk of the given tier, aged by writing `created_at` directly. */
  async function seedChunk(input: {
    readonly tier: 'session' | 'project' | 'global';
    readonly projectId?: string;
    readonly sessionId?: string;
    readonly ageDays: number;
  }): Promise<string> {
    const id = newId();
    const createdAt = new Date(Date.now() - input.ageDays * 24 * 60 * 60 * 1000);

    await testDatabase()
      .db.insert(schema.memoryItems)
      .values({
        id,
        tier: input.tier,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        sourceType: input.tier === 'global' ? 'obsidian_note' : 'adr',
        ...(input.tier === 'global' ? { sourceRef: `note-${id}.md` } : { sourceId: newId() }),
        chunkOrdinal: 0,
        content: 'a stored chunk',
        contentHash: 'a'.repeat(64),
        embeddingModel: MODEL,
        embeddingDimension: DIMENSION,
        qdrantPointId: newId(),
        indexedAt: createdAt,
        createdAt,
      });
    return id;
  }

  /** Put a point in the store for each row, so "both stores" is observable. */
  async function mirrorToStore(): Promise<void> {
    const rows = await memoryRows();
    await store.ensureCollection({ model: MODEL, dimension: DIMENSION });
    await store.upsert(
      rows.map((row) => ({
        id: row.qdrantPointId,
        vector: Array.from({ length: DIMENSION }, () => 0.1),
        payload: {
          kind: 'chunk' as const,
          memoryItemId: row.id,
          tier: row.tier as 'session' | 'project' | 'global',
          projectId: row.projectId,
          sessionId: row.sessionId,
          agentId: null,
          sourceType: row.sourceType as 'adr' | 'obsidian_note',
          sourceId: row.sourceId,
          sourceRef: row.sourceRef,
          chunkOrdinal: row.chunkOrdinal,
          embeddingModel: row.embeddingModel,
          embeddingDimension: row.embeddingDimension,
        },
      })),
    );
  }

  it('DOES NOTHING BY DEFAULT — every tier is "never expire"', async () => {
    const { projectId } = await seedProject();
    await seedChunk({ tier: 'project', projectId, ageDays: 4_000 });

    const app = await configuredApp();
    const summary = await app.memory.retention.tick();

    // Nothing deleted, and no next tick: an operator who never opens Settings → Memory pays for
    // no wake-ups at all.
    expect(summary.reason).toBe('disabled');
    expect(summary.deleted).toBe(0);
    expect(summary.nextTickAt).toBeNull();
    expect(await memoryRows()).toHaveLength(1);
  });

  it('DELETES EXPIRED SESSION CHUNKS FROM BOTH STORES', async () => {
    const { projectId } = await seedProject();
    const userId = (await seedUser()).id;
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });

    const old = await seedChunk({ tier: 'session', projectId, sessionId, ageDays: 40 });
    const fresh = await seedChunk({ tier: 'session', projectId, sessionId, ageDays: 3 });

    const app = await configuredApp();
    await mirrorToStore();
    expect(store.points).toHaveLength(2);

    await setRetentionDays({ session: 30 });
    const summary = await app.memory.retention.tick();

    expect(summary.reason).toBe('ok');
    expect(summary.deleted).toBe(1);
    expect(summary.storeError).toBeNull();

    const remaining = await memoryRows();
    expect(remaining.map((row) => row.id)).toEqual([fresh]);
    // The half that makes the deletion real: the vector is gone too. A row deleted without its
    // point leaves a vector the operator believes they deleted.
    expect(store.points).toHaveLength(1);
    expect(store.points.every((point) => point.payload.memoryItemId !== old)).toBe(true);
  });

  it('expires one tier without touching the others', async () => {
    const { projectId } = await seedProject();
    const userId = (await seedUser()).id;
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });

    await seedChunk({ tier: 'session', projectId, sessionId, ageDays: 100 });
    const project = await seedChunk({ tier: 'project', projectId, ageDays: 100 });
    const global = await seedChunk({ tier: 'global', ageDays: 100 });

    const app = await configuredApp();
    await mirrorToStore();
    await setRetentionDays({ session: 30 });
    const summary = await app.memory.retention.tick();

    expect(summary.byTier).toEqual({ session: 1 });
    expect((await memoryRows()).map((row) => row.id).sort()).toEqual([project, global].sort());
  });

  it('POSTPONES rather than half-deleting when the vector store cannot be reached', async () => {
    const { projectId } = await seedProject();
    await seedChunk({ tier: 'project', projectId, ageDays: 100 });

    await setRetentionDays({ project: 30 });
    const app = await configuredApp();
    // The runtime cannot resolve: `ensureCollection` fails, so there is no way to delete points.
    store.failWith({ kind: 'unreachable', reason: 'ECONNREFUSED 127.0.0.1:6333' });
    app.memory.runtime.invalidate();

    const summary = await app.memory.retention.tick();

    expect(summary.reason).toBe('unavailable');
    expect(summary.deleted).toBe(0);
    // Nothing was deleted from PostgreSQL either — deleting rows whose points we cannot delete
    // is the one outcome worse than deleting nothing.
    expect(await memoryRows()).toHaveLength(1);
    // But the chain keeps ticking: Ollama and Qdrant come back.
    expect(summary.nextTickAt).not.toBeNull();
  });

  it('is bounded per tick and schedules a catch-up when it fills its budget', async () => {
    const { projectId } = await seedProject();
    for (let index = 0; index < 5; index += 1) {
      await seedChunk({ tier: 'project', projectId, ageDays: 100 });
    }

    const app = await configuredApp({ retentionBatchSize: 2 });
    await mirrorToStore();
    await setRetentionDays({ project: 30 });

    const first = await app.memory.retention.tick();
    expect(first.deleted).toBe(2);
    expect(first.budgetExhausted).toBe(true);
    expect(await memoryRows()).toHaveLength(3);

    await app.memory.retention.tick();
    await app.memory.retention.tick();
    expect(await memoryRows()).toEqual([]);
    expect(store.points).toEqual([]);
  });

  it('deletes the oldest first, so a backlog drains in a defensible order', async () => {
    const { projectId } = await seedProject();
    const oldest = await seedChunk({ tier: 'project', projectId, ageDays: 400 });
    await seedChunk({ tier: 'project', projectId, ageDays: 100 });

    const app = await configuredApp({ retentionBatchSize: 1 });
    await mirrorToStore();
    await setRetentionDays({ project: 30 });
    await app.memory.retention.tick();

    expect((await memoryRows()).some((row) => row.id === oldest)).toBe(false);
  });

  it('keeps a chunk that is exactly inside its window', async () => {
    const { projectId } = await seedProject();
    await seedChunk({ tier: 'project', projectId, ageDays: 29 });

    const app = await configuredApp();
    await mirrorToStore();
    await setRetentionDays({ project: 30 });

    expect((await app.memory.retention.tick()).deleted).toBe(0);
    expect(await memoryRows()).toHaveLength(1);
  });
});

// -------------------------------------------------------------------- the settings document

describe('PUT /api/v1/settings/memory', () => {
  it('stores both fields with the value_type their CHECK requires, and reads them back', async () => {
    const app = await configuredApp();
    const cookie = await login(app, await seedUser());

    const saved = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/memory',
      headers: { cookie },
      payload: {
        indexedSources: {
          session: true,
          commit: false,
          adr: true,
          obsidianNote: true,
          pullRequest: true,
          document: true,
        },
        retentionDays: { session: 90, project: 0, global: 0 },
      },
    });

    expect(saved.statusCode).toBe(200);
    const body = JSON.parse(saved.body) as { data: Record<string, unknown> };
    expect(body.data['retentionDays']).toEqual({ session: 90, project: 0, global: 0 });

    const rows = await testDatabase()
      .db.select()
      .from(schema.settings)
      .where(eq(schema.settings.category, 'memory'));
    expect(rows.map((row) => row.key).sort()).toEqual(['indexed_sources', 'retention_days']);
    expect(rows.every((row) => row.valueType === 'object')).toBe(true);

    const read = await app.app.inject({
      method: 'GET',
      url: '/api/v1/settings/memory',
      headers: { cookie },
    });
    expect(JSON.parse(read.body)).toEqual({ data: body.data });
  });

  it('rejects an unknown field by name rather than resetting the ones it did not mention', async () => {
    const app = await configuredApp();
    const cookie = await login(app, await seedUser());

    const response = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/memory',
      headers: { cookie },
      payload: { retentionDay: { session: 90 } },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('rejects a retention window beyond the ten-year bound at the boundary', async () => {
    const app = await configuredApp();
    const cookie = await login(app, await seedUser());

    const response = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/memory',
      headers: { cookie },
      payload: { retentionDays: { session: 10_000 } },
    });

    expect(response.statusCode).toBe(400);
  });

  it('records the change in the audit log, values included, secrets not involved', async () => {
    const app = await configuredApp();
    const cookie = await login(app, await seedUser());

    await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/memory',
      headers: { cookie },
      payload: { retentionDays: { session: 30, project: 0, global: 0 } },
    });

    const entries = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.action, 'setting.updated'));

    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]?.after)).toContain('retention_days');
  });

  it('re-primes the retention chain when the policy changes, with no restart', async () => {
    // The mechanism `github.poll` uses for `syncIntervalMinutes`: a chain that stopped because
    // nothing expired has to restart when something does, without an operator restarting the
    // Backend.
    const app = await configuredApp();
    const cookie = await login(app, await seedUser());

    const primed: string[] = [];
    app.bus.on('setting.updated', (event) => {
      primed.push(String((event.payload as { category?: unknown }).category));
    });

    await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/memory',
      headers: { cookie },
      payload: { retentionDays: { session: 30, project: 0, global: 0 } },
    });

    expect(primed).toContain('memory');
    // And a tick now finds work to do rather than answering `disabled`.
    expect((await app.memory.retention.tick()).reason).toBe('ok');
  });
});
