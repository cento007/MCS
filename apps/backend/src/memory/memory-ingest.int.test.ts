import {
  createFailingEmbedder,
  createFakeEmbedder,
  createInMemoryVectorStore,
  type FakeEmbeddingPort,
  type InMemoryVectorStore,
  MEMORY_RUN_KIND,
  newId,
  schema,
  settingKey,
} from '@mc/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  type SeededUser,
  seedAdr,
  seedMessage,
  seedProject,
  seedRepository,
  seedSession,
  seedUser,
  setSetting,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';
import type { BackfillStatus } from './indexing.js';

/**
 * Ingestion and retrieval against real PostgreSQL.
 *
 * What only this tier can prove, and what each case is here for:
 *
 *  - **Idempotence costs nothing.** A second index of unchanged content makes *zero* embedding
 *    calls. The unit tier proves the decision (`planChunks`); only a real database proves that
 *    the rows the decision reads are the rows the writer wrote.
 *  - **Deletion sticks.** An archived Session's vectors stop answering queries, and so do the
 *    chunks of a source that shrank.
 *  - **The backfill is bounded, resumable and single-active.** `ux_sync_runs_active` is a
 *    PostgreSQL partial unique index; a test against a fake would be testing the fake.
 *  - **Scope filtering holds end to end**, from an HTTP body through the filter builder and the
 *    store to a hydrated result.
 *
 * The embedder and the store are fakes — deterministic, install-free, and running the *real*
 * cosine arithmetic and the *real* shared filter predicate. Real Ollama and real Qdrant are
 * exercised separately by `packages/shared/src/memory/live.int.test.ts`, which skips when they
 * are absent.
 */

const MODEL = 'nomic-embed-text';
const DIMENSION = 768;

let built: TestApp;
let embedder: FakeEmbeddingPort;
let store: InMemoryVectorStore;

/**
 * Embedding calls since the last `markEmbedBaseline()`.
 *
 * A baseline rather than a reset, because `FakeEmbeddingPort.calls` is deliberately read-only:
 * a test that could clear the fake's history could also clear it by accident and then assert
 * "nothing was embedded" against a record it had just emptied.
 */
let embedBaseline = { batches: 0, chunks: 0 };

function markEmbedBaseline(): void {
  embedBaseline = { batches: embedder.calls.length, chunks: totalChunks() };
}

function totalChunks(): number {
  return embedder.calls.reduce((total, batch) => total + batch.length, 0);
}

function embedCalls(): number {
  return embedder.calls.length - embedBaseline.batches;
}

function chunksEmbedded(): number {
  return totalChunks() - embedBaseline.chunks;
}

async function configuredApp(overrides: { backfillBatchSize?: number } = {}): Promise<TestApp> {
  await setSetting('integrations', settingKey('integrations.qdrant.embeddingModel'), MODEL);

  embedder = createFakeEmbedder({ model: MODEL, dimension: DIMENSION, recordCalls: true });
  store = createInMemoryVectorStore({ collection: 'mc_memory_test' });
  embedBaseline = { batches: 0, chunks: 0 };

  return createTestApp({
    memoryClients: () => ({ embedder, store }),
    ...(overrides.backfillBatchSize === undefined
      ? {}
      : { memoryBackfillBatchSize: overrides.backfillBatchSize }),
  });
}

beforeEach(async () => {
  await truncateAll();
  built = createTestApp();
});

afterEach(async () => {
  await truncateAll();
});

async function memoryRows() {
  return testDatabase()
    .db.select()
    .from(schema.memoryItems)
    .orderBy(schema.memoryItems.chunkOrdinal);
}

/**
 * Log one app in as an already-seeded account.
 *
 * The account is a parameter rather than seeded here because there is exactly one local user
 * (F4.1): `bootstrapLocalUser` never overwrites an existing account, so a second `seedUser()` in
 * the same test returns the first user with the first password and every later login is a 401.
 */
async function loginTo(app: TestApp, user: SeededUser): Promise<string> {
  const response = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
}

async function readBackfill(app: TestApp, cookie: string): Promise<BackfillStatus> {
  const response = await app.app.inject({
    method: 'GET',
    url: '/api/v1/memory-items/backfill',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return (JSON.parse(response.body) as { data: BackfillStatus }).data;
}

/** Raw DDL against this file's private clone — the only way to make a schema genuinely wrong. */
async function execute(statement: string): Promise<void> {
  await testDatabase().db.execute(sql.raw(statement));
}

/**
 * Rewrite `ck_sync_runs_kind`'s predicate.
 *
 * `"'obsidian'"` is the pre-`0005` schema exactly — a database that never applied
 * `0005_memory_index_runs`. Dropping and re-adding is what the migration itself does.
 */
async function setSyncRunKindCheck(values: string): Promise<void> {
  await execute('ALTER TABLE sync_runs DROP CONSTRAINT ck_sync_runs_kind');
  await execute(
    `ALTER TABLE sync_runs ADD CONSTRAINT ck_sync_runs_kind CHECK ("sync_runs"."kind" IN (${values}))`,
  );
}

// ------------------------------------------------------------------------------- idempotence

describe('indexing one source', () => {
  it('writes rows and points that agree with each other', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({
      projectId,
      title: 'Use pg-boss instead of Redis',
      context: 'Redis has no official native Windows build, which breaks dev parity.',
      decision: 'PostgreSQL is the single stateful substrate; pg-boss is the job queue.',
      alternatives: 'Memurai on Windows dev; an in-process queue with no persistence.',
      consequences: 'WS3 vendors the pgboss schema; health reports queue depth from PostgreSQL.',
    });

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });

    const rows = await memoryRows();
    expect(rows.length).toBeGreaterThan(0);
    expect(store.points).toHaveLength(rows.length);

    for (const row of rows) {
      expect(row.tier).toBe('project');
      expect(row.projectId).toBe(projectId);
      expect(row.sourceType).toBe('adr');
      expect(row.sourceId).toBe(adr.id);
      expect(row.embeddingModel).toBe(MODEL);
      expect(row.embeddingDimension).toBe(DIMENSION);
      // The crash marker: nothing in the write path may leave this null.
      expect(row.indexedAt).not.toBeNull();

      const point = store.points.find((entry) => entry.id === row.qdrantPointId);
      expect(point).toBeDefined();
      expect(point?.payload.memoryItemId).toBe(row.id);
      expect(point?.payload.projectId).toBe(projectId);
    }
  });

  it('RE-INDEXING UNCHANGED CONTENT MAKES ZERO EMBEDDING CALLS', async () => {
    // The claim the whole design rests on. An embedding call is the expensive operation here;
    // skipping it when nothing changed is the difference between a usable backfill and one
    // an operator cancels.
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'PostgreSQL is the single substrate.' });

    const app = await configuredApp();
    const job = { kind: 'source', sourceType: 'adr', sourceId: adr.id } as const;

    await app.memory.indexing.handle(job);
    const afterFirst = chunksEmbedded();
    expect(afterFirst).toBeGreaterThan(0);
    const rowsAfterFirst = await memoryRows();

    markEmbedBaseline();
    await app.memory.indexing.handle(job);

    expect(embedCalls()).toBe(0);
    // And nothing was rewritten: `updated_at` is untouched, which is what proves the skip
    // happened before the write rather than being an idempotent overwrite.
    const rowsAfterSecond = await memoryRows();
    expect(rowsAfterSecond.map((row) => row.updatedAt.toISOString())).toEqual(
      rowsAfterFirst.map((row) => row.updatedAt.toISOString()),
    );
  });

  it('re-embeds only what changed when a source is edited', async () => {
    const { projectId } = await seedProject();
    const long = 'The decision stands. '.repeat(200);
    const adr = await seedAdr({ projectId, context: long, decision: 'Original decision.' });

    const app = await configuredApp();
    const job = { kind: 'source', sourceType: 'adr', sourceId: adr.id } as const;
    await app.memory.indexing.handle(job);

    const before = await memoryRows();
    expect(before.length).toBeGreaterThan(2);

    markEmbedBaseline();
    await testDatabase()
      .db.update(schema.adrs)
      .set({ decision: 'A completely different decision now.' })
      .where(eq(schema.adrs.id, adr.id));
    await app.memory.indexing.handle(job);

    // Some chunks changed, but not all of them — the diff is per chunk, not per source.
    expect(chunksEmbedded()).toBeGreaterThan(0);
    expect(chunksEmbedded()).toBeLessThan(before.length);
  });

  it('drops the chunks a shrinking source no longer has, from both stores', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({
      projectId,
      context: 'Context paragraph. '.repeat(300),
      decision: 'Decision paragraph. '.repeat(300),
      alternatives: 'Alternatives paragraph. '.repeat(300),
      consequences: 'Consequences paragraph. '.repeat(300),
    });

    const app = await configuredApp();
    const job = { kind: 'source', sourceType: 'adr', sourceId: adr.id } as const;
    await app.memory.indexing.handle(job);
    const before = await memoryRows();
    expect(before.length).toBeGreaterThan(4);

    await testDatabase()
      .db.update(schema.adrs)
      .set({ context: 'Short.', alternatives: '', consequences: '' })
      .where(eq(schema.adrs.id, adr.id));
    await app.memory.indexing.handle(job);

    const after = await memoryRows();
    expect(after.length).toBeLessThan(before.length);
    // The stale vectors are gone too — not merely unreferenced.
    expect(store.points).toHaveLength(after.length);
  });

  it('forgets a source whose text became empty', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, context: 'Something.', decision: 'Something else.' });

    const app = await configuredApp();
    const job = { kind: 'source', sourceType: 'adr', sourceId: adr.id } as const;
    await app.memory.indexing.handle(job);
    expect((await memoryRows()).length).toBeGreaterThan(0);

    await testDatabase()
      .db.update(schema.adrs)
      .set({ context: '', decision: '', alternatives: '', consequences: '' })
      .where(eq(schema.adrs.id, adr.id));
    await app.memory.indexing.handle(job);

    expect(await memoryRows()).toEqual([]);
    expect(store.points).toEqual([]);
  });

  it('purges rather than skips when the row vanished between the event and the job', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'A decision worth remembering.' });

    const app = await configuredApp();
    const job = { kind: 'source', sourceType: 'adr', sourceId: adr.id } as const;
    await app.memory.indexing.handle(job);
    expect((await memoryRows()).length).toBeGreaterThan(0);

    await testDatabase().db.delete(schema.adrs).where(eq(schema.adrs.id, adr.id));
    await app.memory.indexing.handle(job);

    expect(await memoryRows()).toEqual([]);
    expect(store.points).toEqual([]);
  });
});

// ------------------------------------------------------------------------------ session tier

describe('sessions', () => {
  async function seedConversation(
    turns: number,
  ): Promise<{ projectId: string; sessionId: string }> {
    const { projectId } = await seedProject();
    const userId = (await seedUser()).id;
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Adopting pg-boss for the job queue',
    });

    for (let ordinal = 0; ordinal < turns; ordinal += 1) {
      await seedMessage({
        sessionId,
        ordinal,
        role: ordinal % 2 === 0 ? 'user' : 'assistant',
        content: `Turn ${String(ordinal)}: discussing whether Redis or PostgreSQL should hold the queue.`,
      });
    }
    return { projectId, sessionId };
  }

  it('indexes turns at session tier, carrying the project for filtering', async () => {
    const { projectId, sessionId } = await seedConversation(6);
    const app = await configuredApp();

    await app.memory.indexing.handle({
      kind: 'source',
      sourceType: 'session',
      sourceId: sessionId,
    });

    const rows = await memoryRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.tier).toBe('session');
      expect(row.sessionId).toBe(sessionId);
      expect(row.projectId).toBe(projectId);
    }
  });

  it('excludes tool traffic — a Read result is a file, not a discussion', async () => {
    const { sessionId } = await seedConversation(2);
    await seedMessage({
      sessionId,
      ordinal: 99,
      role: 'tool',
      content: 'SECRETMARKERFROMATOOLRESULT contents of some file',
    });

    const app = await configuredApp();
    await app.memory.indexing.handle({
      kind: 'source',
      sourceType: 'session',
      sourceId: sessionId,
    });

    const rows = await memoryRows();
    expect(rows.map((row) => row.content ?? '').join('\n')).not.toContain(
      'SECRETMARKERFROMATOOLRESULT',
    );
  });

  it('ARCHIVING A SESSION PURGES ITS MEMORY, from both stores', async () => {
    const { sessionId } = await seedConversation(4);
    const app = await configuredApp();

    await app.memory.indexing.handle({
      kind: 'source',
      sourceType: 'session',
      sourceId: sessionId,
    });
    expect((await memoryRows()).length).toBeGreaterThan(0);
    const before = store.points.length;
    expect(before).toBeGreaterThan(0);

    await app.memory.indexing.handle({ kind: 'purge_session', sessionId });

    expect(await memoryRows()).toEqual([]);
    expect(store.points).toEqual([]);
  });

  it('refuses to re-index an archived session, so the purge is not undone on a schedule', async () => {
    const { sessionId } = await seedConversation(4);
    const app = await configuredApp();

    await testDatabase()
      .db.update(schema.sessions)
      .set({ state: 'archived' })
      .where(eq(schema.sessions.id, sessionId));

    await app.memory.indexing.handle({
      kind: 'source',
      sourceType: 'session',
      sourceId: sessionId,
    });
    expect(await memoryRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------- backfill

describe('the backfill run', () => {
  async function seedCorpus(): Promise<{ projectId: string }> {
    const { projectId } = await seedProject();
    const repositoryId = await seedRepository(projectId);
    const userId = (await seedUser()).id;

    for (let index = 0; index < 6; index += 1) {
      await seedAdr({
        projectId,
        title: `Decision number ${String(index)}`,
        decision: `We chose option ${String(index)} because it survives a restart.`,
      });
      await testDatabase()
        .db.insert(schema.commits)
        .values({
          id: newId(),
          repositoryId,
          sha: index.toString(16).padStart(40, '0'),
          authorName: 'cento007',
          message: `Commit number ${String(index)}: wire the queue`,
          files: [
            {
              path: `src/file-${String(index)}.ts`,
              status: 'modified',
              additions: 1,
              deletions: 0,
            },
          ],
          committedAt: new Date(),
        });
      await testDatabase()
        .db.insert(schema.pullRequests)
        .values({
          id: newId(),
          repositoryId,
          number: index + 1,
          title: `Pull request ${String(index)}`,
          description: 'Wire the queue through the port.',
          state: 'merged',
        });
    }

    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: 'Wiring' });
    await seedMessage({
      sessionId,
      ordinal: 0,
      role: 'user',
      content: 'How do we wire the queue?',
    });

    return { projectId };
  }

  /** Drain the self-continuing run by handling each slice inline. */
  async function drain(app: TestApp, runId: string, maxSlices = 40): Promise<number> {
    for (let slice = 0; slice < maxSlices; slice += 1) {
      await app.memory.indexing.handle({ kind: 'backfill', runId });
      const status = await app.memory.indexing.status();
      if (status.state === 'completed' || status.state === 'failed') return slice + 1;
    }
    throw new Error('backfill did not finish within the slice budget');
  }

  it('indexes every source type, in bounded resumable slices', async () => {
    await seedCorpus();
    const app = await configuredApp({ backfillBatchSize: 2 });

    const run = await app.memory.indexing.trigger({ mode: 'incremental' });
    const slices = await drain(app, run.id);

    // Bounded: 19 sources at 2 per slice cannot have been one delivery.
    expect(slices).toBeGreaterThan(5);

    const status = await app.memory.indexing.status();
    expect(status.state).toBe('completed');
    expect(status.progress?.failures).toBe(0);
    expect(status.progress?.sourcesIndexed).toBeGreaterThanOrEqual(19);

    const rows = await memoryRows();
    const types = new Set(rows.map((row) => row.sourceType));
    expect([...types].sort()).toEqual(['adr', 'commit', 'pull_request', 'session']);
  });

  it('is resumable: progress and the cursor survive between slices', async () => {
    await seedCorpus();
    const app = await configuredApp({ backfillBatchSize: 2 });
    const run = await app.memory.indexing.trigger({ mode: 'incremental' });

    await app.memory.indexing.handle({ kind: 'backfill', runId: run.id });
    const first = await app.memory.indexing.status();
    expect(first.state).toBe('running');
    expect(first.progress?.sourcesSeen).toBe(2);
    expect(first.progress?.cursor).not.toBeNull();

    await app.memory.indexing.handle({ kind: 'backfill', runId: run.id });
    const second = await app.memory.indexing.status();
    // The cursor moved rather than restarting: the second slice saw two *different* sources.
    expect(second.progress?.sourcesSeen).toBe(4);
    expect(second.progress?.cursor).not.toBe(first.progress?.cursor);
  });

  it('A SECOND BACKFILL CANNOT START — the guard is the partial unique index', async () => {
    await seedCorpus();
    const app = await configuredApp({ backfillBatchSize: 2 });

    await app.memory.indexing.trigger({ mode: 'incremental' });
    await expect(app.memory.indexing.trigger({ mode: 'incremental' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const runs = await testDatabase()
      .db.select()
      .from(schema.syncRuns)
      .where(eq(schema.syncRuns.kind, MEMORY_RUN_KIND));
    expect(runs).toHaveLength(1);
  });

  it('does not block an Obsidian sync run, because the guard is per kind', async () => {
    await seedCorpus();
    const app = await configuredApp();
    await app.memory.indexing.trigger({ mode: 'incremental' });

    await expect(
      testDatabase()
        .db.insert(schema.syncRuns)
        .values({ id: newId(), kind: 'obsidian', state: 'queued', trigger: 'user' }),
    ).resolves.toBeDefined();
  });

  it('a completed run re-run from scratch embeds nothing new', async () => {
    await seedCorpus();
    const app = await configuredApp({ backfillBatchSize: 5 });

    const first = await app.memory.indexing.trigger({ mode: 'incremental' });
    await drain(app, first.id);
    const embeddedFirst = chunksEmbedded();
    expect(embeddedFirst).toBeGreaterThan(0);

    markEmbedBaseline();
    const second = await app.memory.indexing.trigger({ mode: 'incremental' });
    await drain(app, second.id);

    // The whole corpus was re-diffed and not one chunk was re-embedded.
    expect(chunksEmbedded()).toBe(0);
    const status = await app.memory.indexing.status();
    expect(status.progress?.chunksEmbedded).toBe(0);
    expect(status.state).toBe('completed');
  });

  it('prunes chunks whose source row was deleted out from under it', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'This ADR will be deleted.' });
    const app = await configuredApp();

    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });
    expect((await memoryRows()).length).toBeGreaterThan(0);

    // A hard delete leaves `memory_items` behind: `source_id` is polymorphic and carries no FK.
    await testDatabase().db.delete(schema.adrs).where(eq(schema.adrs.id, adr.id));

    const run = await app.memory.indexing.trigger({ mode: 'incremental' });
    await drain(app, run.id);

    expect(await memoryRows()).toEqual([]);
    expect(store.points).toEqual([]);
  });

  it('fails the run with a reason when the embedder is unavailable, keeping its progress', async () => {
    await seedCorpus();
    const app = await configuredApp({ backfillBatchSize: 2 });
    const run = await app.memory.indexing.trigger({ mode: 'incremental' });

    await app.memory.indexing.handle({ kind: 'backfill', runId: run.id });
    // Ollama goes away mid-run.
    store.failWith({ kind: 'unreachable', reason: 'ECONNREFUSED 127.0.0.1:6333' });
    await app.memory.indexing.handle({ kind: 'backfill', runId: run.id });

    const status = await app.memory.indexing.status();
    expect(status.state).toBe('failed');
    expect(status.error).toContain('ECONNREFUSED');
    // A run that indexed two sources did index two sources; reporting zero would send the
    // operator looking for a problem that is not there.
    expect(status.progress?.sourcesIndexed).toBe(2);
  });
});

// ----------------------------------------------------------------------- the model-change path

describe('a model change', () => {
  it('rebuild resets the collection and drops every row from the old model', async () => {
    const { projectId } = await seedProject();
    await seedAdr({ projectId, decision: 'Indexed under the first model.' });

    const app = await configuredApp();
    const first = await app.memory.indexing.trigger({ mode: 'incremental' });
    for (let slice = 0; slice < 20; slice += 1) {
      await app.memory.indexing.handle({ kind: 'backfill', runId: first.id });
      if ((await app.memory.indexing.status()).state === 'completed') break;
    }
    const beforeRows = await memoryRows();
    expect(beforeRows.length).toBeGreaterThan(0);
    expect(beforeRows.every((row) => row.embeddingModel === MODEL)).toBe(true);

    // The operator changes `integrations.qdrant.embeddingModel`.
    embedder = createFakeEmbedder({
      model: 'mxbai-embed-large',
      dimension: 1024,
      recordCalls: true,
    });
    const changed = createTestApp({ memoryClients: () => ({ embedder, store }) });

    // An `incremental` run under a changed model is refused: it would write nothing and report
    // success. `rebuild` is the way through.
    await expect(changed.memory.indexing.trigger({ mode: 'incremental' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });

    const rebuild = await changed.memory.indexing.trigger({ mode: 'rebuild' });
    for (let slice = 0; slice < 20; slice += 1) {
      await changed.memory.indexing.handle({ kind: 'backfill', runId: rebuild.id });
      if ((await changed.memory.indexing.status()).state === 'completed') break;
    }

    const afterRows = await memoryRows();
    expect(afterRows.length).toBeGreaterThan(0);
    expect(afterRows.every((row) => row.embeddingModel === 'mxbai-embed-large')).toBe(true);
    expect(afterRows.every((row) => row.embeddingDimension === 1024)).toBe(true);
    // No straggler from the old model is left claiming a point that no longer exists.
    expect(store.points).toHaveLength(afterRows.length);
  });

  it('status names every model present, so a straggler is visible', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'Indexed.' });
    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });

    const status = await app.memory.indexing.status();
    expect(status.indexedModels).toEqual([MODEL]);
    expect(status.rowsFromOtherModels).toBe(0);
  });
});

// --------------------------------------------------------------------------------- retrieval

describe('POST /api/v1/memory-items/search', () => {
  async function login(app: TestApp): Promise<string> {
    const user = await seedUser();
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: user.username, password: user.password },
    });
    expect(response.statusCode).toBe(200);
    const raw = response.headers['set-cookie'];
    return Array.isArray(raw) ? raw.join('; ') : (raw ?? '');
  }

  it('returns hits with everything a client needs to build a link', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({
      projectId,
      title: 'Use pg-boss instead of Redis',
      decision: 'PostgreSQL is the single stateful substrate; pg-boss is the job queue.',
    });

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });

    const cookie = await login(app);
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      headers: { cookie },
      // The fake embedder is a lexical sketch, so the query has to share substrings with the
      // corpus. Semantic quality is the live model's job, proved in `live.int.test.ts`.
      payload: { q: 'PostgreSQL is the single stateful substrate', minScore: 0.2 },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      data: {
        results: {
          memoryItemId: string;
          title: string;
          sourceType: string;
          content: string;
          chunkOrdinal: number;
          chunkCount: number;
          context: { projectId: string | null; sessionId: string | null };
        }[];
        emptyReason: string;
        embeddingModel: string;
      };
    };

    expect(body.data.emptyReason).toBe('none');
    expect(body.data.embeddingModel).toBe(MODEL);

    const hit = body.data.results[0];
    expect(hit).toBeDefined();
    // Reachable: a title to show and a project to route to. An id alone is unclickable — the
    // lesson the Phase 2 search learned the hard way.
    expect(hit?.title).toBe(
      `ADR-${String(adr.adrNumber).padStart(4, '0')} — Use pg-boss instead of Redis`,
    );
    expect(hit?.context.projectId).toBe(projectId);
    expect(hit?.sourceType).toBe('adr');
    expect(hit?.chunkCount).toBeGreaterThanOrEqual(1);
    expect(hit?.content.length).toBeGreaterThan(0);
  });

  it('answers "nothing relevant" rather than five bad matches', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'PostgreSQL holds the job queue.' });

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });

    const cookie = await login(app);
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      headers: { cookie },
      payload: { q: 'zzzzz qqqqq wwwww vvvvv', minScore: 0.9 },
    });

    const body = JSON.parse(response.body) as {
      data: {
        results: unknown[];
        emptyReason: string;
        detail: string;
        candidatesConsidered: number;
      };
    };
    expect(body.data.results).toEqual([]);
    expect(body.data.emptyReason).toBe('below_threshold');
    // The floor is visible: the operator can see that chunks *were* considered and rejected.
    expect(body.data.candidatesConsidered).toBeGreaterThan(0);
    expect(body.data.detail).toContain('0.90');
  });

  it('says "not configured" rather than 503 when no model is set', async () => {
    const cookie = await login(built);
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      headers: { cookie },
      payload: { q: 'anything at all' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { data: { emptyReason: string; detail: string } };
    expect(body.data.emptyReason).toBe('not_configured');
    expect(body.data.detail).toContain('embeddingModel');
  });

  it('never returns another project’s memory', async () => {
    const a = await seedProject('Project A');
    const b = await seedProject('Project B');
    const adrA = await seedAdr({ projectId: a.projectId, decision: 'Alpha decided on pg-boss.' });
    const adrB = await seedAdr({ projectId: b.projectId, decision: 'Beta decided on pg-boss.' });

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adrA.id });
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adrB.id });

    const cookie = await login(app);
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      headers: { cookie },
      payload: { q: 'decided on pg-boss', projectId: a.projectId, minScore: 0 },
    });

    const body = JSON.parse(response.body) as {
      data: { results: { context: { projectId: string | null }; sourceId: string | null }[] };
    };
    expect(body.data.results.length).toBeGreaterThan(0);
    expect(body.data.results.every((hit) => hit.context.projectId === a.projectId)).toBe(true);
    expect(body.data.results.every((hit) => hit.sourceId !== adrB.id)).toBe(true);
  });

  it('rejects an unknown body field rather than silently ignoring it', async () => {
    const cookie = await login(built);
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      headers: { cookie },
      payload: { q: 'x', projectID: '018f6b2e-aaaa-7abc-8def-0123456789ab' },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
  });

  it('requires authentication', async () => {
    const response = await built.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      payload: { q: 'x' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('drops a hit whose row has gone — the mechanism that makes an orphan point inert', async () => {
    const { projectId } = await seedProject();
    const adr = await seedAdr({ projectId, decision: 'PostgreSQL holds the job queue.' });

    const app = await configuredApp();
    await app.memory.indexing.handle({ kind: 'source', sourceType: 'adr', sourceId: adr.id });
    expect(store.points.length).toBeGreaterThan(0);

    // Simulate the crash window: rows deleted, points not.
    await testDatabase().db.delete(schema.memoryItems);
    expect(store.points.length).toBeGreaterThan(0);

    const cookie = await login(app);
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/search',
      headers: { cookie },
      payload: { q: 'PostgreSQL holds the job queue', minScore: 0 },
    });

    const body = JSON.parse(response.body) as {
      data: { results: unknown[]; emptyReason: string };
    };
    expect(body.data.results).toEqual([]);
    expect(body.data.emptyReason).toBe('index_empty');
  });
});

// ------------------------------------------------------------------------------- backfill API

describe('the backfill routes', () => {
  it('reports nothing before any run, then the run it started', async () => {
    const app = await configuredApp();
    const user = await seedUser();
    const login = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: user.username, password: user.password },
    });
    const raw = login.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw.join('; ') : (raw ?? '');

    const before = await app.app.inject({
      method: 'GET',
      url: '/api/v1/memory-items/backfill',
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);
    expect(JSON.parse(before.body)).toMatchObject({ data: { runId: null, state: null } });

    const triggered = await app.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/backfill',
      headers: { cookie },
      payload: {},
    });
    expect(triggered.statusCode).toBe(202);
    const runId = (JSON.parse(triggered.body) as { data: { runId: string } }).data.runId;

    const after = await app.app.inject({
      method: 'GET',
      url: '/api/v1/memory-items/backfill',
      headers: { cookie },
    });
    expect(JSON.parse(after.body)).toMatchObject({ data: { runId, state: 'queued' } });

    // And a second trigger is a 409, from the database's own guard.
    const again = await app.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/backfill',
      headers: { cookie },
      payload: {},
    });
    expect(again.statusCode).toBe(409);
  });

  it('refuses to trigger when no embedding model is configured', async () => {
    const user = await seedUser();
    const login = await built.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: user.username, password: user.password },
    });
    const raw = login.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw.join('; ') : (raw ?? '');

    const response = await built.app.inject({
      method: 'POST',
      url: '/api/v1/memory-items/backfill',
      headers: { cookie },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: 'INTEGRATION_NOT_CONFIGURED' },
    });
  });

  /**
   * The three situations that used to be one document.
   *
   * Every field except these three is identical across all of them — an all-null run and an
   * empty `indexedModels` — and the operator's next action is different in each. This is the
   * whole reason `configured` alone was not enough: two of the three have `configured: true`.
   */
  it('tells "not configured" from "nothing indexed" from "Ollama is down"', async () => {
    const user = await seedUser();

    // 1. Nothing configured at all.
    const cookie = await loginTo(built, user);
    const unconfigured = await readBackfill(built, cookie);
    expect(unconfigured).toMatchObject({
      runId: null,
      configured: false,
      runtime: 'not_configured',
      indexedModels: [],
    });
    // The reason is the operator-facing sentence, not a code word.
    expect(unconfigured.runtimeReason).toContain('embedding model');

    // 2. Configured, reachable, and nothing has ever been indexed. Same all-null run.
    const ready = await configuredApp();
    const readyCookie = await loginTo(ready, user);
    expect(await readBackfill(ready, readyCookie)).toMatchObject({
      runId: null,
      configured: true,
      runtime: 'ready',
      runtimeReason: null,
      indexedModels: [],
    });

    // 3. Configured, but the embedding runtime cannot be reached — a third answer, and the one
    //    a bare boolean would have merged into (2). "Open Settings" would be the wrong advice.
    const down = createTestApp({
      memoryClients: () => ({
        embedder: createFailingEmbedder(
          { kind: 'unreachable', reason: 'Ollama is not running (scripted)' },
          MODEL,
        ),
        store: createInMemoryVectorStore({ collection: 'mc_memory_test' }),
      }),
    });
    const downCookie = await loginTo(down, user);
    const unavailable = await readBackfill(down, downCookie);
    expect(unavailable).toMatchObject({
      runId: null,
      configured: true,
      runtime: 'unavailable',
      indexedModels: [],
    });
    expect(unavailable.runtimeReason).toContain('Ollama is not running (scripted)');
  });

  /**
   * The reported failure, reproduced: a database that has not applied `0005_memory_index_runs`
   * still carries `ck_sync_runs_kind CHECK (kind IN ('obsidian'))`, so the insert of a
   * `memory_index` run is refused with a `23514` — which used to arrive as `500 INTERNAL` and
   * told the operator nothing.
   *
   * The constraint is genuinely reverted against real PostgreSQL, in this file's private
   * template clone, and put back afterwards. Nothing here fakes the error.
   */
  it('answers a check violation on sync_runs.kind with the command that fixes it', async () => {
    const app = await configuredApp();
    const cookie = await loginTo(app, await seedUser());

    await setSyncRunKindCheck("'obsidian'");
    try {
      const response = await app.app.inject({
        method: 'POST',
        url: '/api/v1/memory-items/backfill',
        headers: { cookie },
        payload: {},
      });

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body) as {
        error: { code: string; message: string; details: Record<string, unknown> };
      };
      expect(body.error.code).toBe('DATABASE_SCHEMA_MISMATCH');
      // Actionable, and specific about what was rejected.
      expect(body.error.message).toContain('ck_sync_runs_kind');
      expect(body.error.message).toContain('memory_index');
      expect(body.error.message).toContain('pnpm db:migrate');
      expect(body.error.details).toMatchObject({
        constraint: 'ck_sync_runs_kind',
        table: 'sync_runs',
        column: 'kind',
        value: 'memory_index',
      });
    } finally {
      await setSyncRunKindCheck("'obsidian', 'memory_index'");
    }
  });

  /**
   * The other half of the same rule: a `23514` from a constraint this code does *not* claim to
   * understand must keep surfacing as `INTERNAL`. Translating every check violation into "run
   * your migrations" would paper over a genuinely bad value with confident, wrong advice.
   */
  it('does not claim schema drift for a check violation it cannot explain', async () => {
    const app = await configuredApp();
    const cookie = await loginTo(app, await seedUser());

    await execute(`ALTER TABLE sync_runs DROP CONSTRAINT ck_sync_runs_trigger`);
    await execute(
      `ALTER TABLE sync_runs ADD CONSTRAINT ck_sync_runs_trigger CHECK ("sync_runs"."trigger" IN ('schedule'))`,
    );
    try {
      const response = await app.app.inject({
        method: 'POST',
        url: '/api/v1/memory-items/backfill',
        headers: { cookie },
        payload: {},
      });

      expect(response.statusCode).toBe(500);
      expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'INTERNAL' } });
    } finally {
      await execute(`ALTER TABLE sync_runs DROP CONSTRAINT ck_sync_runs_trigger`);
      await execute(
        `ALTER TABLE sync_runs ADD CONSTRAINT ck_sync_runs_trigger CHECK ("sync_runs"."trigger" IN ('user', 'schedule'))`,
      );
    }
  });
});

// --------------------------------------------------------------------------- the API key scan

describe('secrets', () => {
  it('never lets the Qdrant API key reach a memory response', async () => {
    const apiKey = 'qdrant_ingest_test_plaintext_key_1234567890';

    const app = await configuredApp();
    const user = await seedUser();
    const login = await app.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: user.username, password: user.password },
    });
    const raw = login.headers['set-cookie'];
    const cookie = Array.isArray(raw) ? raw.join('; ') : (raw ?? '');

    const saved = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/qdrant',
      headers: { cookie },
      payload: { host: '127.0.0.1', port: 6333, apiKey, embeddingModel: MODEL },
    });
    expect(saved.statusCode).toBe(200);

    for (const request of [
      { method: 'POST' as const, url: '/api/v1/memory-items/search', payload: { q: 'anything' } },
      { method: 'GET' as const, url: '/api/v1/memory-items/backfill' },
    ]) {
      const response = await app.app.inject({ ...request, headers: { cookie } });
      // The whole serialized response, not one field — the only assertion that stays true when
      // someone adds a field later.
      expect(response.body).not.toContain(apiKey);
    }
  });

  /**
   * The scan above only ever sees a `ready` runtime, so `runtimeReason` is `null` in it and the
   * new field is covered in name only. This one makes the dependency *fail with the key in its
   * own words* — the shape a real transport error takes — and proves the sentence that reaches
   * the operator has been scrubbed. `runtime.ts` redacts at source; this is the end-to-end
   * evidence for the one field that carries dependency text into a response.
   */
  it('scrubs the Qdrant API key out of the backfill document’s runtime reason', async () => {
    const apiKey = 'qdrant_runtime_reason_key_0987654321';

    const app = createTestApp({
      memoryClients: () => ({
        embedder: createFailingEmbedder(
          { kind: 'unreachable', reason: `refused while presenting api-key ${apiKey}` },
          MODEL,
        ),
        store: createInMemoryVectorStore({ collection: 'mc_memory_test' }),
      }),
    });
    // Written through this app's own settings route: each test app holds a freshly generated
    // MC_ENCRYPTION_KEY, so a secret sealed by one cannot be opened by another.
    const cookie = await loginTo(app, await seedUser());
    const saved = await app.app.inject({
      method: 'PUT',
      url: '/api/v1/settings/integrations/qdrant',
      headers: { cookie },
      payload: { host: '127.0.0.1', port: 6333, apiKey, embeddingModel: MODEL },
    });
    expect(saved.statusCode).toBe(200);

    const response = await app.app.inject({
      method: 'GET',
      url: '/api/v1/memory-items/backfill',
      headers: { cookie },
    });
    const status = (JSON.parse(response.body) as { data: BackfillStatus }).data;

    // The failure did reach the field — otherwise this would pass vacuously.
    expect(status.runtime).toBe('unavailable');
    expect(status.runtimeReason).toContain('refused while presenting api-key');
    expect(status.runtimeReason).not.toContain(apiKey);
    expect(response.body).not.toContain(apiKey);
  });
});

// -------------------------------------------------------------------------------- the schema

describe('memory_items under a real PostgreSQL', () => {
  it('keeps the two rows of one chunk under two models apart', async () => {
    // What makes a partial re-index representable at the row level, even though the collection
    // can only hold one model's vectors at a time.
    const { projectId } = await seedProject();
    const sourceId = newId();
    const hash = 'a'.repeat(64);

    for (const [model, dimension] of [
      ['nomic-embed-text', 768],
      ['mxbai-embed-large', 1024],
    ] as const) {
      await testDatabase().db.insert(schema.memoryItems).values({
        id: newId(),
        tier: 'project',
        projectId,
        sourceType: 'adr',
        sourceId,
        chunkOrdinal: 0,
        content: 'chunk',
        contentHash: hash,
        embeddingModel: model,
        embeddingDimension: dimension,
        qdrantPointId: newId(),
      });
    }

    const rows = await testDatabase()
      .db.select()
      .from(schema.memoryItems)
      .where(
        and(eq(schema.memoryItems.sourceId, sourceId), eq(schema.memoryItems.chunkOrdinal, 0)),
      );
    expect(rows).toHaveLength(2);
  });
});
