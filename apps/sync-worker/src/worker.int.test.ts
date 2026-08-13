import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  decodeRelayEvent,
  EVENT_RELAY_CHANNEL,
  findAdrBySourceSession,
  findLatestSyncRun,
  findSyncRun,
  insertSyncRun,
  QUEUE_NAMES,
  schema,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  seedAdr,
  seedMessage,
  seedOperator,
  seedProject,
  seedSession,
  setObsidianSettings,
  silentLogger,
  testDatabase,
  testDatabaseUrl,
  testOutbox,
  testQueue,
  testVaultDirectory,
  truncateAll,
} from '../test/integration/harness.js';
import { AdrGenerationService } from './adr-generation.js';
import { SyncScheduler } from './schedule.js';
import { SyncService } from './sync.js';

/**
 * The Sync Worker's own jobs against a real database and a **real temporary vault**: the run
 * lifecycle, the scheduler tick, and ADR drafting.
 *
 * The sync *algorithm* is covered by the shared engine's unit tests and by
 * `apps/backend/src/obsidian/obsidian.int.test.ts`; what is under test here is the worker's
 * half — claiming a run, always reaching a terminal state, and being idempotent under the
 * at-least-once delivery the queue actually provides.
 */

let projectId: string;
let userId: string;
let vaultPath: string;
let sync: SyncService;
let scheduler: SyncScheduler;
let adrs: AdrGenerationService;

async function queuedRunId(trigger: 'user' | 'schedule' = 'user'): Promise<string> {
  const run = await testDatabase().db.transaction((tx) => insertSyncRun(tx, { trigger }));
  return run.id;
}

beforeEach(async () => {
  await truncateAll();

  const db = testDatabase().db;
  const queue = await testQueue();
  const outbox = await testOutbox();

  userId = await seedOperator();
  projectId = await seedProject();
  vaultPath = testVaultDirectory();
  await setObsidianSettings({ vaultPath });

  sync = new SyncService({ db, outbox, logger: silentLogger });
  scheduler = new SyncScheduler({ db, queue, logger: silentLogger });
  adrs = new AdrGenerationService({ db, outbox, logger: silentLogger });
});

describe('one sync run', () => {
  it('claims the run, writes the vault, and completes with stats', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    const syncRunId = await queuedRunId();

    const result = await sync.runOne({ syncRunId });

    expect(result.kind).toBe('completed');
    expect(result.stats.notesExported).toBe(1);

    const run = await findSyncRun(testDatabase().db, syncRunId);
    expect(run).toMatchObject({ state: 'completed' });
    expect(run?.stats).toEqual({ notesExported: 1, notesImported: 0, conflicts: 0 });
    expect(run?.startedAt).not.toBeNull();
    expect(run?.completedAt).not.toBeNull();

    expect(await readdir(join(vaultPath, 'ADRs'))).toEqual(['ADR-0001 Queue decision.md']);
  });

  it('emits sync.started and sync.completed on the events queue', async () => {
    const syncRunId = await queuedRunId();
    await sync.runOne({ syncRunId });

    const jobs = await testDatabase().db.execute<{ data: { type: string; source: string } }>(
      `SELECT data FROM pgboss.job WHERE name = '${QUEUE_NAMES.EVENTS}' ORDER BY created_on`,
    );

    const types = jobs.rows.map((row) => row.data.type);
    expect(types).toEqual(['sync.started', 'sync.completed']);
    expect(jobs.rows[0]?.data.source).toBe('sync-worker');
  });

  it('also raises the LISTEN/NOTIFY relay for each of them, on a real second connection', async () => {
    // A durable job on `events` is not enough on its own: the Backend does not consume that
    // queue (it would compete with the Telegram Worker), so the WS `sync` channel learns about
    // a run only through the notify half (TDS 04 §15.1). The listener here is a genuine second
    // PostgreSQL connection — the fan-out is the property under test, so it is not mocked.
    const listener = new pg.Client({ connectionString: testDatabaseUrl() });
    const received: string[] = [];
    listener.on('notification', (message) => {
      if (message.payload !== undefined) received.push(message.payload);
    });

    try {
      await listener.connect();
      await listener.query(`LISTEN ${EVENT_RELAY_CHANNEL}`);

      const syncRunId = await queuedRunId();
      await sync.runOne({ syncRunId });

      await vi.waitFor(() => {
        expect(received).toHaveLength(2);
      });

      const decoded = received.map((payload) => decodeRelayEvent(payload));
      expect(decoded.every((entry) => entry.ok)).toBe(true);
      expect(decoded.map((entry) => (entry.ok ? entry.event.type : 'rejected'))).toEqual([
        'sync.started',
        'sync.completed',
      ]);
      // The envelope id is the same one on the durable job, so a consumer that sees both copies
      // de-duplicates rather than acting twice (F6.3).
      const jobs = await testDatabase().db.execute<{ data: { id: string; type: string } }>(
        `SELECT data FROM pgboss.job WHERE name = '${QUEUE_NAMES.EVENTS}' ORDER BY created_on`,
      );
      expect(decoded.map((entry) => (entry.ok ? entry.event.id : null))).toEqual(
        jobs.rows.map((row) => row.data.id),
      );
    } finally {
      await listener.end();
    }
  });

  it('ignores a redelivered job — the run is claimed exactly once', async () => {
    const syncRunId = await queuedRunId();

    const first = await sync.runOne({ syncRunId });
    const second = await sync.runOne({ syncRunId });

    expect(first.kind).toBe('completed');
    expect(second.kind).toBe('ignored');
  });

  it('fails the run — never leaves it running — when the vault is gone', async () => {
    await setObsidianSettings({ vaultPath: null });
    await testDatabase()
      .db.update(schema.settings)
      .set({ value: join(vaultPath, 'does-not-exist') })
      .where(eq(schema.settings.key, 'obsidian_vault_path'));

    const syncRunId = await queuedRunId();
    const result = await sync.runOne({ syncRunId });

    expect(result.kind).toBe('failed');
    const run = await findSyncRun(testDatabase().db, syncRunId);
    expect(run?.state).toBe('failed');
    expect(run?.error).toMatch(/missing/);

    const jobs = await testDatabase().db.execute<{ data: { type: string } }>(
      `SELECT data FROM pgboss.job WHERE name = '${QUEUE_NAMES.EVENTS}'`,
    );
    expect(jobs.rows.map((row) => row.data.type)).toContain('sync.failed');
  });

  it('completes as a no-op when sync was paused after the trigger', async () => {
    await testDatabase()
      .db.update(schema.settings)
      .set({ value: 'paused' })
      .where(eq(schema.settings.key, 'obsidian_sync_mode'));

    const syncRunId = await queuedRunId();
    const result = await sync.runOne({ syncRunId });

    expect(result.kind).toBe('skipped');
    expect((await findSyncRun(testDatabase().db, syncRunId))?.state).toBe('completed');
    expect(await readdir(vaultPath)).toEqual([]);
  });

  it('fails the run rather than hanging when shutdown interrupts it', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    const syncRunId = await queuedRunId();

    const controller = new AbortController();
    controller.abort();

    const result = await sync.runOne({ syncRunId }, controller.signal);

    expect(result.kind).toBe('interrupted');
    const run = await findSyncRun(testDatabase().db, syncRunId);
    expect(run?.state).toBe('failed');
    expect(run?.error).toMatch(/shut down/);
    // A failed run must not hold the single-active-run slot.
    expect(run?.completedAt).not.toBeNull();
  });

  it('emits one sync.conflict_detected per conflicted file', async () => {
    const adrId = await seedAdr({ projectId, title: 'Queue decision' });
    await sync.runOne({ syncRunId: await queuedRunId() });

    const notePath = join(vaultPath, 'ADRs', 'ADR-0001 Queue decision.md');
    await writeFile(
      notePath,
      (await readFile(notePath, 'utf8')).replace('_Not recorded._', 'Edited in Obsidian.'),
      'utf8',
    );
    await testDatabase()
      .db.update(schema.adrs)
      .set({ context: 'Edited in Mission Control.', updatedAt: new Date() })
      .where(eq(schema.adrs.id, adrId));

    const result = await sync.runOne({ syncRunId: await queuedRunId() });

    expect(result.stats.conflicts).toBe(1);

    const jobs = await testDatabase().db.execute<{
      data: { type: string; payload: { path?: string; resolution?: string } };
    }>(`SELECT data FROM pgboss.job WHERE name = '${QUEUE_NAMES.EVENTS}'`);

    const conflict = jobs.rows
      .map((row) => row.data)
      .find((data) => data.type === 'sync.conflict_detected');
    expect(conflict?.payload.path).toBe('ADRs/ADR-0001 Queue decision.md');
    expect(conflict?.payload.resolution).toBe('newer_wins');
  });
});

describe('the scheduler tick', () => {
  it('does nothing while the interval is 0 — that means manual only', async () => {
    const summary = await scheduler.tick();

    expect(summary.triggeredRunId).toBeNull();
    expect(await findLatestSyncRun(testDatabase().db)).toBeNull();
  });

  it('queues a scheduled run when one is due, and its job with it', async () => {
    await setObsidianSettings({ vaultPath, intervalMinutes: 15 });
    await testDatabase()
      .db.update(schema.settings)
      .set({ value: 15 })
      .where(eq(schema.settings.key, 'obsidian_sync_interval_minutes'));

    const summary = await scheduler.tick();

    expect(summary.triggeredRunId).not.toBeNull();
    const run = await findLatestSyncRun(testDatabase().db);
    expect(run).toMatchObject({ state: 'queued', trigger: 'schedule' });

    const jobs = await testDatabase().db.execute<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = '${QUEUE_NAMES.OBSIDIAN_SYNC}'`,
    );
    expect(jobs.rows.map((row) => row.id)).toEqual([summary.triggeredRunId]);
  });

  it('reschedules itself so the chain survives a restart', async () => {
    await scheduler.tick();

    const jobs = await testDatabase().db.execute<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = '${QUEUE_NAMES.OBSIDIAN_SCHEDULE}'`,
    );
    expect(jobs.rows).toHaveLength(1);
  });

  it('stops rescheduling once shutdown has begun', async () => {
    scheduler.setStopping(true);
    const summary = await scheduler.tick();

    expect(summary.rescheduled).toBe(false);
    const jobs = await testDatabase().db.execute<{ id: string }>(
      `SELECT id FROM pgboss.job WHERE name = '${QUEUE_NAMES.OBSIDIAN_SCHEDULE}'`,
    );
    expect(jobs.rows).toHaveLength(0);
  });

  it('reclaims a run a killed process left behind, so the guard is not permanent', async () => {
    const db = testDatabase().db;
    const abandoned = await db.transaction(async (tx) => {
      const run = await insertSyncRun(tx, { trigger: 'user' });
      return run.id;
    });
    // Age it past the reclaim threshold.
    await db
      .update(schema.syncRuns)
      .set({ updatedAt: new Date(Date.now() - 60 * 60_000) })
      .where(eq(schema.syncRuns.id, abandoned));

    const summary = await scheduler.tick();

    expect(summary.reclaimed).toBe(1);
    expect((await findSyncRun(db, abandoned))?.state).toBe('failed');
  });

  it('does not start a second run while one is in flight', async () => {
    await testDatabase()
      .db.update(schema.settings)
      .set({ value: 15 })
      .where(eq(schema.settings.key, 'obsidian_sync_interval_minutes'));
    await queuedRunId();

    const summary = await scheduler.tick();

    expect(summary.triggeredRunId).toBeNull();
  });
});

describe('drafting an ADR from a session', () => {
  it('creates a `proposed` ADR with all four template sections', async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Replace Redis with pg-boss',
    });
    await seedMessage({ sessionId, ordinal: 0, role: 'user', content: 'Get rid of Redis.' });
    await seedMessage({ sessionId, ordinal: 1, role: 'assistant', content: 'Swapped to pg-boss.' });
    await seedMessage({
      sessionId,
      ordinal: 2,
      role: 'tool',
      content: '',
      toolFilePath: 'D:\\Repos\\MCS\\packages\\shared\\src\\queue\\pg-boss.ts',
    });

    const result = await adrs.generate({ sessionId });

    expect(result.kind).toBe('created');
    expect(result.adrNumber).toBe(1);

    const row = await findAdrBySourceSession(testDatabase().db, sessionId);
    expect(row).toMatchObject({
      title: 'Replace Redis with pg-boss',
      status: 'proposed',
      sourceSessionId: sessionId,
    });
    expect(row?.context).toContain('> Get rid of Redis.');
    expect(row?.decision).toContain('Swapped to pg-boss.');
    expect(row?.alternatives).toContain('[!todo]');
    expect(row?.consequences).toContain('pg-boss.ts');
  });

  it('emits adr.created from the sync worker', async () => {
    const sessionId = await seedSession({ projectId, userId, title: 'Something' });
    await adrs.generate({ sessionId });

    const jobs = await testDatabase().db.execute<{
      data: { type: string; source: string; payload: { sourceSessionId?: string } };
    }>(`SELECT data FROM pgboss.job WHERE name = '${QUEUE_NAMES.EVENTS}'`);

    const created = jobs.rows.map((row) => row.data).find((data) => data.type === 'adr.created');
    expect(created?.source).toBe('sync-worker');
    expect(created?.payload.sourceSessionId).toBe(sessionId);
  });

  it('drafts once per session — a redelivered job creates no second ADR', async () => {
    const sessionId = await seedSession({ projectId, userId, title: 'Something' });

    const first = await adrs.generate({ sessionId });
    const second = await adrs.generate({ sessionId });

    expect(first.kind).toBe('created');
    expect(second.kind).toBe('already_exists');
    expect(second.adrId).toBe(first.adrId);

    const rows = await testDatabase().db.select().from(schema.adrs);
    expect(rows).toHaveLength(1);
  });

  it('records the draft in the audit log', async () => {
    const sessionId = await seedSession({ projectId, userId, title: 'Something' });
    const result = await adrs.generate({ sessionId });

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, result.adrId as string));

    expect(rows[0]).toMatchObject({ action: 'adr.generated', actorType: 'system' });
  });

  it('does nothing for a session that no longer exists', async () => {
    const result = await adrs.generate({ sessionId: '0199a3f1-9999-7a10-9f01-3d4e5f607182' });

    expect(result.kind).toBe('session_missing');
    expect(await testDatabase().db.select().from(schema.adrs)).toHaveLength(0);
  });

  it('exports the drafted ADR to the vault on the next run', async () => {
    const sessionId = await seedSession({ projectId, userId, title: 'Replace Redis' });
    await adrs.generate({ sessionId });

    await sync.runOne({ syncRunId: await queuedRunId() });

    expect(await readdir(join(vaultPath, 'ADRs'))).toEqual(['ADR-0001 Replace Redis.md']);
  });
});
