import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  beginSyncRun,
  completeSyncRun,
  createDatabaseHeartbeatSink,
  failSyncRun,
  findActiveSyncRun,
  insertSyncRun,
  type ObsidianConflictPolicy,
  type ObsidianSyncMode,
  parseNote,
  QUEUE_NAMES,
  readLedger,
  readObsidianSettings,
  reclaimAbandonedSyncRuns,
  runObsidianSync,
  type SyncOutcome,
  schema,
  sectionText,
  settingKey,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedAdr,
  seedMessage,
  seedProject,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  testVaultDirectory,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';

/**
 * Obsidian two-way sync, end to end: a real PostgreSQL database and a **real temporary vault
 * directory**, never the operator's own (`testVaultDirectory()` creates one under the OS temp
 * root and teardown removes it).
 *
 * The cases that matter most are grouped last: what happens when both sides changed, and where
 * the losing version ends up.
 */

let app: TestApp;
let cookie: string;
let projectId: string;
let userId: string;
let vaultPath: string;

const KEYS = {
  vaultPath: settingKey('integrations.obsidian.vaultPath'),
  syncMode: settingKey('integrations.obsidian.syncMode'),
  interval: settingKey('integrations.obsidian.syncIntervalMinutes'),
  policy: settingKey('integrations.obsidian.conflictPolicy'),
};

async function configureObsidian(
  overrides: {
    vaultPath?: string | null;
    syncMode?: ObsidianSyncMode;
    conflictPolicy?: ObsidianConflictPolicy;
    intervalMinutes?: number;
  } = {},
): Promise<void> {
  const db = testDatabase().db;
  await db.delete(schema.settings).where(eq(schema.settings.category, 'integrations'));

  const rows: { key: string; value: unknown; valueType: 'string' | 'number' }[] = [
    {
      key: KEYS.syncMode,
      value: overrides.syncMode ?? 'two_way',
      valueType: 'string',
    },
    {
      key: KEYS.policy,
      value: overrides.conflictPolicy ?? 'newer_wins',
      valueType: 'string',
    },
    { key: KEYS.interval, value: overrides.intervalMinutes ?? 0, valueType: 'number' },
  ];

  const path = overrides.vaultPath === undefined ? vaultPath : overrides.vaultPath;
  if (path !== null) rows.push({ key: KEYS.vaultPath, value: path, valueType: 'string' });

  for (const row of rows) {
    await db.insert(schema.settings).values({
      id: crypto.randomUUID(),
      category: 'integrations',
      key: row.key,
      value: row.value,
      valueType: row.valueType,
    });
  }
}

async function sync(
  options: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<SyncOutcome> {
  const settings = await readObsidianSettings(testDatabase().db);
  return runObsidianSync({
    db: testDatabase().db,
    settings,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function vaultFiles(folder = ''): Promise<string[]> {
  try {
    return (await readdir(join(vaultPath, folder))).sort();
  } catch {
    return [];
  }
}

async function readVault(relative: string): Promise<string> {
  return readFile(join(vaultPath, ...relative.split('/')), 'utf8');
}

beforeEach(async () => {
  await truncateAll();

  const queue = await testQueue();
  app = createTestApp({ queue, cookieSecure: false });

  const user = await seedUser();
  userId = user.id;

  const login = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = `${SESSION_COOKIE_NAME}=${cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME)}`;

  ({ projectId } = await seedProject());
  vaultPath = testVaultDirectory();
  await configureObsidian();
});

// ------------------------------------------------------------------------------ the API (§10)

describe('POST /api/v1/sync-runs', () => {
  it('queues a run and its job in one transaction', async () => {
    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/sync-runs',
      headers: { cookie },
      payload: { kind: 'obsidian' },
    });

    expect(response.statusCode).toBe(202);
    const run = response.json().data;
    expect(run).toMatchObject({ kind: 'obsidian', state: 'queued', trigger: 'user', stats: null });

    const jobs = await testDatabase().db.execute<{ id: string; data: { syncRunId: string } }>(
      `SELECT id, data FROM pgboss.job WHERE name = '${QUEUE_NAMES.OBSIDIAN_SYNC}'`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.data.syncRunId).toBe(run.id);
    // The job id IS the run id, so a repeated enqueue cannot queue two syncs of one run.
    expect(jobs.rows[0]?.id).toBe(run.id);
  });

  it('refuses a second run while one is in flight — the database decides, not a SELECT', async () => {
    const first = await app.app.inject({
      method: 'POST',
      url: '/api/v1/sync-runs',
      headers: { cookie },
      payload: {},
    });
    expect(first.statusCode).toBe(202);

    const second = await app.app.inject({
      method: 'POST',
      url: '/api/v1/sync-runs',
      headers: { cookie },
      payload: {},
    });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('CONFLICT');
  });

  it('refuses when no vault path is configured', async () => {
    await configureObsidian({ vaultPath: null });

    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/sync-runs',
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'INTEGRATION_NOT_CONFIGURED',
      details: { reason: 'vault_path_missing' },
    });
  });

  it('refuses while sync is paused, and says which setting is in the way', async () => {
    await configureObsidian({ syncMode: 'paused' });

    const response = await app.app.inject({
      method: 'POST',
      url: '/api/v1/sync-runs',
      headers: { cookie },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.details.reason).toBe('sync_paused');
  });
});

describe('GET /api/v1/sync-runs', () => {
  it('lists newest first and reports the per-file detail on the detail route', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    await sync();

    const runId = await testDatabase().db.transaction(async (tx) => {
      const run = await insertSyncRun(tx, { trigger: 'schedule' });
      await beginSyncRun(tx, run.id, new Date());
      await completeSyncRun(
        tx,
        run.id,
        { notesExported: 1, notesImported: 0, conflicts: 0 },
        new Date(),
      );
      return run.id;
    });

    const list = await app.app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs',
      headers: { cookie },
    });
    expect(list.json().data[0].id).toBe(runId);

    const detail = await app.app.inject({
      method: 'GET',
      url: `/api/v1/sync-runs/${runId}`,
      headers: { cookie },
    });
    expect(detail.json().data).toMatchObject({
      state: 'completed',
      stats: { notesExported: 1, notesImported: 0, conflicts: 0 },
      conflicts: [],
      errors: [],
    });
  });

  it('404s for an unknown run', async () => {
    const response = await app.app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs/0199a3f1-9999-7a10-9f01-3d4e5f607182',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});

// ------------------------------------------------------------------------------------ export

describe('export — Mission Control to the vault', () => {
  it('writes the §7.1 layout and both note types', async () => {
    const adr = await seedAdr({ projectId, title: 'Use pg-boss for the job queue' });
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Wire the sync worker',
      startedAt: new Date('2026-08-13T08:00:00.000Z'),
    });
    await seedMessage({ sessionId, ordinal: 0, role: 'user', content: 'Wire it up.' });
    await seedMessage({ sessionId, ordinal: 1, role: 'assistant', content: 'Done.' });

    const outcome = await sync();

    expect(outcome.stats).toEqual({ notesExported: 2, notesImported: 0, conflicts: 0 });
    expect(await vaultFiles()).toEqual(['ADRs', 'Sessions']);
    expect(await vaultFiles('ADRs')).toEqual(['ADR-0001 Use pg-boss for the job queue.md']);
    expect(await vaultFiles('Sessions')).toEqual(['2026-08-13 Wire the sync worker.md']);

    const note = await readVault('ADRs/ADR-0001 Use pg-boss for the job queue.md');
    const parsed = parseNote(note);
    // Front matter carries the id, so the note can be matched back without the file name.
    expect(note).toContain(`mcId: "${adr.id}"`);
    expect(parsed.sections.map((section) => section.heading)).toEqual([
      'Context',
      'Decision',
      'Alternatives',
      'Consequences',
    ]);

    const sessionNote = parseNote(await readVault('Sessions/2026-08-13 Wire the sync worker.md'));
    expect(sectionText(sessionNote, 'Prompts')).toBe('> Wire it up.');
  });

  it('records the ledger and denormalises the path onto the ADR row', async () => {
    const adr = await seedAdr({ projectId, title: 'Queue decision' });
    await sync();

    const ledger = await readLedger(testDatabase().db, ['adr']);
    expect(ledger[0]).toMatchObject({
      vaultPath: 'ADRs/ADR-0001 Queue decision.md',
      entityType: 'adr',
      entityId: adr.id,
      status: 'in_sync',
    });
    expect(ledger[0]?.mcHash).not.toBeNull();
    expect(ledger[0]?.vaultHash).not.toBeNull();

    const rows = await testDatabase()
      .db.select()
      .from(schema.adrs)
      .where(eq(schema.adrs.id, adr.id));
    expect(rows[0]?.obsidianPath).toBe('ADRs/ADR-0001 Queue decision.md');
  });

  it('is idempotent — a second run with nothing changed writes nothing', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    await sync();

    const before = await stat(join(vaultPath, 'ADRs', 'ADR-0001 Queue decision.md'));
    const second = await sync();

    expect(second.stats).toEqual({ notesExported: 0, notesImported: 0, conflicts: 0 });
    const after = await stat(join(vaultPath, 'ADRs', 'ADR-0001 Queue decision.md'));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('pushes a Mission Control edit over an untouched vault copy', async () => {
    const adr = await seedAdr({ projectId, title: 'Queue decision', decision: 'First.' });
    await sync();

    await testDatabase()
      .db.update(schema.adrs)
      .set({ decision: 'Second.', updatedAt: new Date() })
      .where(eq(schema.adrs.id, adr.id));

    const outcome = await sync();

    expect(outcome.stats.notesExported).toBe(1);
    expect(outcome.stats.conflicts).toBe(0);
    expect(await readVault('ADRs/ADR-0001 Queue decision.md')).toContain('Second.');
  });

  it('does not export a session that is still running', async () => {
    await seedSession({ projectId, userId, state: 'running', title: 'In flight' });
    await sync();

    expect(await vaultFiles('Sessions')).toEqual([]);
  });

  it('follows a note the operator renamed instead of writing a second copy', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    await sync();

    const from = join(vaultPath, 'ADRs', 'ADR-0001 Queue decision.md');
    const to = join(vaultPath, 'ADRs', 'My own name for this.md');
    await writeFile(to, await readFile(from, 'utf8'), 'utf8');
    await rm(from);

    const outcome = await sync();

    expect(await vaultFiles('ADRs')).toEqual(['My own name for this.md']);
    expect(outcome.stats.notesExported).toBe(0);

    const ledger = await readLedger(testDatabase().db, ['adr']);
    expect(ledger[0]?.vaultPath).toBe('ADRs/My own name for this.md');
  });

  it('re-creates a note the operator deleted, rather than deleting the ADR', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    await sync();
    await rm(join(vaultPath, 'ADRs', 'ADR-0001 Queue decision.md'));

    const outcome = await sync();

    expect(outcome.stats.notesExported).toBe(1);
    expect(await vaultFiles('ADRs')).toEqual(['ADR-0001 Queue decision.md']);
  });
});

// ------------------------------------------------------------------------------------ import

describe('import — the vault back into Mission Control', () => {
  it('applies an ADR edit made in Obsidian', async () => {
    const adr = await seedAdr({ projectId, title: 'Queue decision', context: 'Original.' });
    await sync();

    const path = 'ADRs/ADR-0001 Queue decision.md';
    const edited = (await readVault(path))
      .replace('Original.', 'Rewritten by the operator.')
      .replace('status: "proposed"', 'status: "accepted"')
      .replace('# Queue decision', '# Queue decision, revised');
    await writeFile(join(vaultPath, ...path.split('/')), edited, 'utf8');

    const outcome = await sync();

    expect(outcome.stats).toEqual({ notesExported: 0, notesImported: 1, conflicts: 0 });

    const rows = await testDatabase()
      .db.select()
      .from(schema.adrs)
      .where(eq(schema.adrs.id, adr.id));

    expect(rows[0]).toMatchObject({
      context: 'Rewritten by the operator.',
      status: 'accepted',
      title: 'Queue decision, revised',
    });
  });

  it('settles after an import — the next run has nothing to do', async () => {
    await seedAdr({ projectId, title: 'Queue decision', context: 'Original.' });
    await sync();

    const path = 'ADRs/ADR-0001 Queue decision.md';
    await writeFile(
      join(vaultPath, ...path.split('/')),
      (await readVault(path)).replace('Original.', 'Edited.'),
      'utf8',
    );

    await sync();
    const third = await sync();

    expect(third.stats).toEqual({ notesExported: 0, notesImported: 0, conflicts: 0 });
  });

  it('ignores a hand-made note that carries no Mission Control id', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    await sync();

    const mine = join(vaultPath, 'ADRs', 'My own thinking.md');
    await writeFile(mine, '# Mine\n\nNothing to do with Mission Control.\n', 'utf8');

    const outcome = await sync();

    expect(outcome.plan?.unmanagedCount).toBe(1);
    expect(await readFile(mine, 'utf8')).toBe('# Mine\n\nNothing to do with Mission Control.\n');

    const adrs = await testDatabase().db.select().from(schema.adrs);
    expect(adrs).toHaveLength(1);
  });

  it('does not import a Session Note — they are export-only in V1', async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Wire it',
      startedAt: new Date('2026-08-13T08:00:00.000Z'),
    });
    await sync();

    const path = 'Sessions/2026-08-13 Wire it.md';
    await writeFile(
      join(vaultPath, ...path.split('/')),
      (await readVault(path)).replace('# Wire it', '# Renamed by hand'),
      'utf8',
    );

    const outcome = await sync();

    expect(outcome.stats.notesImported).toBe(0);
    expect(outcome.plan?.items[0]).toMatchObject({ action: 'pending_pull' });
    // The operator's edit is still there: a note we will not import is a note we do not touch.
    expect(await readVault(path)).toContain('# Renamed by hand');

    const rows = await testDatabase()
      .db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    expect(rows[0]?.title).toBe('Wire it');
  });

  it('takes the fields it understands and records the one it does not', async () => {
    await seedAdr({ projectId, title: 'Queue decision', context: 'Original.' });
    await sync();

    const path = 'ADRs/ADR-0001 Queue decision.md';
    await writeFile(
      join(vaultPath, ...path.split('/')),
      (await readVault(path))
        .replace('Original.', 'Edited.')
        .replace('status: "proposed"', 'status: "sort of accepted"'),
      'utf8',
    );

    await sync();

    const rows = await testDatabase().db.select().from(schema.adrs);
    expect(rows[0]?.context).toBe('Edited.');
    // The unrecognised status was refused, not coerced.
    expect(rows[0]?.status).toBe('proposed');

    const ledger = await readLedger(testDatabase().db, ['adr']);
    expect(ledger[0]?.lastError).toMatch(/"sort of accepted" is not one of/);
  });
});

// --------------------------------------------------------------------------------- conflicts

describe('both sides changed since the last sync', () => {
  async function divergeBothSides(): Promise<{ adrId: string; path: string }> {
    const adr = await seedAdr({ projectId, title: 'Queue decision', context: 'Original.' });
    await sync();

    const path = 'ADRs/ADR-0001 Queue decision.md';
    await writeFile(
      join(vaultPath, ...path.split('/')),
      (await readVault(path)).replace('Original.', 'Edited in Obsidian.'),
      'utf8',
    );

    await testDatabase()
      .db.update(schema.adrs)
      .set({ context: 'Edited in Mission Control.', updatedAt: new Date() })
      .where(eq(schema.adrs.id, adr.id));

    return { adrId: adr.id, path };
  }

  it('is reported as a conflict and counted on the run', async () => {
    await divergeBothSides();

    const outcome = await sync();

    expect(outcome.stats.conflicts).toBe(1);
    expect(outcome.conflicts[0]).toMatchObject({ vaultPath: 'ADRs/ADR-0001 Queue decision.md' });
  });

  it('mission_control_wins keeps the operator version as a conflict copy', async () => {
    await configureObsidian({ conflictPolicy: 'mission_control_wins' });
    const { path } = await divergeBothSides();

    const outcome = await sync();

    expect(outcome.conflicts[0]?.resolution).toBe('mission_control_wins');
    expect(await readVault(path)).toContain('Edited in Mission Control.');

    // THE GUARANTEE: the losing version is still in the vault, under a name Obsidian indexes.
    const backupPath = outcome.conflicts[0]?.backupPath;
    expect(backupPath).toMatch(/\.conflict-\d{8}-\d{6}\.md$/);
    expect(await readVault(backupPath as string)).toContain('Edited in Obsidian.');
  });

  it('obsidian_wins keeps the replaced database version in the audit log', async () => {
    await configureObsidian({ conflictPolicy: 'obsidian_wins' });
    const { adrId } = await divergeBothSides();

    const outcome = await sync();

    expect(outcome.conflicts[0]?.resolution).toBe('obsidian_wins');

    const rows = await testDatabase()
      .db.select()
      .from(schema.adrs)
      .where(eq(schema.adrs.id, adrId));
    expect(rows[0]?.context).toBe('Edited in Obsidian.');

    // THE GUARANTEE, other direction: what the vault overwrote is recoverable.
    const audit = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, adrId));

    const imported = audit.find((row) => row.action === 'adr.imported');
    expect(imported?.before).toMatchObject({ context: 'Edited in Mission Control.' });
    expect(imported?.after).toMatchObject({ context: 'Edited in Obsidian.' });
  });

  it('manual writes nothing on either side and leaves the conflict visible', async () => {
    await configureObsidian({ conflictPolicy: 'manual' });
    const { adrId, path } = await divergeBothSides();

    const outcome = await sync();

    expect(outcome.conflicts[0]?.resolution).toBe('manual_pending');
    expect(await readVault(path)).toContain('Edited in Obsidian.');

    const rows = await testDatabase()
      .db.select()
      .from(schema.adrs)
      .where(eq(schema.adrs.id, adrId));
    expect(rows[0]?.context).toBe('Edited in Mission Control.');

    // No conflict copy was needed, because nothing was overwritten.
    expect((await vaultFiles('ADRs')).filter((name) => name.includes('.conflict-'))).toEqual([]);

    const ledger = await readLedger(testDatabase().db, ['adr']);
    expect(ledger[0]?.status).toBe('conflict');
  });

  it('an unresolved conflict stays unresolved on the next run', async () => {
    await configureObsidian({ conflictPolicy: 'manual' });
    await divergeBothSides();

    await sync();
    const second = await sync();

    // It must NOT quietly settle: the hashes are deliberately not advanced for an unresolved
    // conflict, so the operator keeps being told until they act.
    expect(second.stats.conflicts).toBe(1);
  });

  it('surfaces the conflict through GET /sync-runs/{id}', async () => {
    await configureObsidian({ conflictPolicy: 'manual' });
    await divergeBothSides();
    await sync();

    const runId = await testDatabase().db.transaction(async (tx) => {
      const run = await insertSyncRun(tx, { trigger: 'user' });
      await beginSyncRun(tx, run.id, new Date());
      await completeSyncRun(
        tx,
        run.id,
        { notesExported: 0, notesImported: 0, conflicts: 1 },
        new Date(),
      );
      return run.id;
    });

    const response = await app.app.inject({
      method: 'GET',
      url: `/api/v1/sync-runs/${runId}`,
      headers: { cookie },
    });

    expect(response.json().data.stats.conflicts).toBe(1);
    expect(response.json().data.conflicts[0]).toMatchObject({
      vaultPath: 'ADRs/ADR-0001 Queue decision.md',
      entityType: 'adr',
      status: 'conflict',
    });
  });

  it('newer_wins takes the vault when the file is clearly newer', async () => {
    await configureObsidian({ conflictPolicy: 'newer_wins' });
    const { adrId, path } = await divergeBothSides();

    // Set the mtime explicitly: the filesystem clock and the database clock are different
    // clocks (see CLOCK_SKEW_MS), so a test that relied on write ordering would be asserting
    // the machine's clock rather than the policy.
    const future = new Date(Date.now() + 60_000);
    await utimes(join(vaultPath, ...path.split('/')), future, future);

    const outcome = await sync();

    expect(outcome.conflicts[0]?.resolution).toBe('newer_wins');
    const rows = await testDatabase()
      .db.select()
      .from(schema.adrs)
      .where(eq(schema.adrs.id, adrId));
    expect(rows[0]?.context).toBe('Edited in Obsidian.');
  });

  it('newer_wins keeps Mission Control when the file is older or within clock skew', async () => {
    await configureObsidian({ conflictPolicy: 'newer_wins' });
    const { adrId, path } = await divergeBothSides();

    const past = new Date(Date.now() - 60_000);
    await utimes(join(vaultPath, ...path.split('/')), past, past);

    const outcome = await sync();

    expect(outcome.conflicts[0]?.resolution).toBe('newer_wins');
    const rows = await testDatabase()
      .db.select()
      .from(schema.adrs)
      .where(eq(schema.adrs.id, adrId));
    expect(rows[0]?.context).toBe('Edited in Mission Control.');
    // The losing side is still recoverable, which is why ties go this way.
    expect(await readVault(outcome.conflicts[0]?.backupPath as string)).toContain(
      'Edited in Obsidian.',
    );
  });

  it('preserves an operator-added section through a conflict', async () => {
    await configureObsidian({ conflictPolicy: 'mission_control_wins' });
    const adr = await seedAdr({ projectId, title: 'Queue decision', context: 'Original.' });
    await sync();

    const path = 'ADRs/ADR-0001 Queue decision.md';
    await writeFile(
      join(vaultPath, ...path.split('/')),
      `${await readVault(path)}\n## My notes\n\nAsk Marc about retries.\n`,
      'utf8',
    );
    await testDatabase()
      .db.update(schema.adrs)
      .set({ context: 'Edited in Mission Control.', updatedAt: new Date() })
      .where(eq(schema.adrs.id, adr.id));

    await sync();

    const rewritten = await readVault(path);
    expect(rewritten).toContain('Edited in Mission Control.');
    expect(rewritten).toContain('## My notes');
    expect(rewritten).toContain('Ask Marc about retries.');
  });
});

// -------------------------------------------------------------------------- modes and dry run

describe('sync modes', () => {
  it('paused does nothing at all', async () => {
    await configureObsidian({ syncMode: 'paused' });
    await seedAdr({ projectId, title: 'Queue decision' });

    const outcome = await sync();

    expect(outcome.skipped).toBe('sync_paused');
    expect(outcome.stats).toEqual({ notesExported: 0, notesImported: 0, conflicts: 0 });
    expect(await vaultFiles()).toEqual([]);
    expect(await readLedger(testDatabase().db, ['adr'])).toEqual([]);
  });

  it('one-way exports but never imports', async () => {
    await configureObsidian({ syncMode: 'one_way' });
    const adr = await seedAdr({ projectId, title: 'Queue decision', context: 'Original.' });
    await sync();

    const path = 'ADRs/ADR-0001 Queue decision.md';
    await writeFile(
      join(vaultPath, ...path.split('/')),
      (await readVault(path)).replace('Original.', 'Edited in Obsidian.'),
      'utf8',
    );

    const outcome = await sync();

    expect(outcome.stats.notesImported).toBe(0);
    expect(outcome.plan?.items[0]?.action).toBe('pending_pull');

    const rows = await testDatabase()
      .db.select()
      .from(schema.adrs)
      .where(eq(schema.adrs.id, adr.id));
    expect(rows[0]?.context).toBe('Original.');
    // And the operator's edit is still on disk — one-way means "we do not take it", not
    // "we overwrite it".
    expect(await readVault(path)).toContain('Edited in Obsidian.');
  });
});

describe('dry run', () => {
  it('reports what a first sync would do and writes nothing', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });

    const outcome = await sync({ dryRun: true });

    expect(outcome.dryRun).toBe(true);
    expect(outcome.plan?.counts.create).toBe(1);
    expect(await vaultFiles()).toEqual([]);
    expect(await readLedger(testDatabase().db, ['adr'])).toEqual([]);
  });

  it('is served by GET /sync-runs/preview without creating a run', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    await writeFile(join(vaultPath, 'stray.md'), '# not in a managed folder\n', 'utf8');

    const response = await app.app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs/preview',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const preview = response.json().data;
    expect(preview).toMatchObject({
      vaultPath,
      syncMode: 'two_way',
      conflictPolicy: 'newer_wins',
      paused: false,
      problem: null,
    });
    expect(preview.summary.create).toBe(1);
    expect(preview.items[0]).toMatchObject({
      action: 'create',
      vaultPath: 'ADRs/ADR-0001 Queue decision.md',
      wouldKeepVaultCopy: false,
    });

    expect(await findActiveSyncRun(testDatabase().db)).toBeNull();
    expect(await vaultFiles()).toEqual(['stray.md']);
  });

  it('previews even while paused, and says that it is hypothetical', async () => {
    await configureObsidian({ syncMode: 'paused' });
    await seedAdr({ projectId, title: 'Queue decision' });

    const response = await app.app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs/preview',
      headers: { cookie },
    });

    expect(response.json().data).toMatchObject({ paused: true, syncMode: 'two_way' });
    expect(response.json().data.summary.create).toBe(1);
  });

  it('warns about a conflict before it happens', async () => {
    await configureObsidian({ conflictPolicy: 'mission_control_wins' });
    const adr = await seedAdr({ projectId, title: 'Queue decision', context: 'Original.' });
    await sync();

    const path = 'ADRs/ADR-0001 Queue decision.md';
    await writeFile(
      join(vaultPath, ...path.split('/')),
      (await readVault(path)).replace('Original.', 'Edited in Obsidian.'),
      'utf8',
    );
    await testDatabase()
      .db.update(schema.adrs)
      .set({ context: 'Edited in Mission Control.', updatedAt: new Date() })
      .where(eq(schema.adrs.id, adr.id));

    const response = await app.app.inject({
      method: 'GET',
      url: '/api/v1/sync-runs/preview',
      headers: { cookie },
    });

    expect(response.json().data.summary.conflict).toBe(1);
    expect(response.json().data.items[0]).toMatchObject({
      action: 'conflict',
      resolution: 'mission_control_wins',
      wouldKeepVaultCopy: true,
    });
    // …and nothing happened yet.
    expect(await readVault(path)).toContain('Edited in Obsidian.');
  });
});

// ---------------------------------------------------------------------------- vault problems

describe('a vault that is not there, or not usable', () => {
  it('reports a vanished vault as data', async () => {
    await rm(vaultPath, { recursive: true, force: true });
    await seedAdr({ projectId, title: 'Queue decision' });

    const outcome = await sync();

    expect(outcome.problem).toMatchObject({ kind: 'missing' });
    expect(outcome.stats.notesExported).toBe(0);
  });

  it('reports a vault path that is a file', async () => {
    const file = join(vaultPath, 'not-a-vault.md');
    await writeFile(file, 'x', 'utf8');
    await configureObsidian({ vaultPath: file });

    expect((await sync()).problem).toMatchObject({ kind: 'not_a_directory' });
  });

  it('reports a relative vault path instead of resolving it against the process cwd', async () => {
    await configureObsidian({ vaultPath: 'vault' });

    expect((await sync()).problem).toMatchObject({ kind: 'not_absolute' });
  });

  it('refuses to decide on a truncated scan rather than duplicating every note', async () => {
    await seedAdr({ projectId, title: 'One' });
    await seedAdr({ projectId, title: 'Two' });
    await sync();

    const settings = await readObsidianSettings(testDatabase().db);
    const outcome = await runObsidianSync({
      db: testDatabase().db,
      settings,
      bounds: { maxFiles: 1 },
    });

    expect(outcome.problem).toMatchObject({ kind: 'scan_truncated' });
    expect(outcome.plan).toBeNull();
    // The vault is exactly as it was — no second copy of anything.
    expect(await vaultFiles('ADRs')).toHaveLength(2);
  });

  it('records an unreadable note as a per-file error and never overwrites it', async () => {
    await seedAdr({ projectId, title: 'Queue decision' });
    await sync();

    const settings = await readObsidianSettings(testDatabase().db);
    const outcome = await runObsidianSync({
      db: testDatabase().db,
      settings,
      // The note is bigger than this cap, so the scan records it without reading it.
      bounds: { maxFileBytes: 10 },
    });

    expect(outcome.errors).toHaveLength(1);
    expect(outcome.plan?.items[0]?.action).toBe('error');

    const ledger = await readLedger(testDatabase().db, ['adr']);
    expect(ledger[0]?.status).toBe('error');
  });
});

// ------------------------------------------------------------------------- run bookkeeping

describe('run lifecycle', () => {
  it('claims a run once — a redelivered job finds nothing to do', async () => {
    const runId = await testDatabase().db.transaction(async (tx) => {
      const run = await insertSyncRun(tx, { trigger: 'user' });
      return run.id;
    });

    const first = await testDatabase().db.transaction((tx) => beginSyncRun(tx, runId, new Date()));
    const second = await testDatabase().db.transaction((tx) => beginSyncRun(tx, runId, new Date()));

    expect(first?.trigger).toBe('user');
    expect(second).toBeNull();
  });

  it('completes and fails only from the state it expects', async () => {
    const runId = await testDatabase().db.transaction(async (tx) => {
      const run = await insertSyncRun(tx, { trigger: 'schedule' });
      await beginSyncRun(tx, run.id, new Date());
      return run.id;
    });

    const stats = { notesExported: 3, notesImported: 1, conflicts: 0 };
    expect(
      await testDatabase().db.transaction((tx) => completeSyncRun(tx, runId, stats, new Date())),
    ).toBe(true);
    expect(
      await testDatabase().db.transaction((tx) => failSyncRun(tx, runId, 'too late', new Date())),
    ).toBe(false);
  });

  it('reclaims a run a killed process left behind, so the guard is not permanent', async () => {
    await testDatabase().db.transaction(async (tx) => {
      const run = await insertSyncRun(tx, { trigger: 'user' });
      await beginSyncRun(tx, run.id, new Date());
    });

    // Nothing can start while it is there.
    expect(await findActiveSyncRun(testDatabase().db)).not.toBeNull();

    const reclaimed = await reclaimAbandonedSyncRuns(testDatabase().db, {
      now: new Date(Date.now() + 60 * 60_000),
      olderThanMs: 15 * 60_000,
    });

    expect(reclaimed).toBe(1);
    expect(await findActiveSyncRun(testDatabase().db)).toBeNull();
  });

  it('leaves a fresh run alone when reclaiming', async () => {
    await testDatabase().db.transaction(async (tx) => {
      await insertSyncRun(tx, { trigger: 'user' });
    });

    expect(await reclaimAbandonedSyncRuns(testDatabase().db, { now: new Date() })).toBe(0);
  });
});

describe('shutdown', () => {
  it('stops between files and leaves everything it wrote consistent', async () => {
    await seedAdr({ projectId, title: 'One' });
    await seedAdr({ projectId, title: 'Two' });

    const controller = new AbortController();
    controller.abort();

    const outcome = await sync({ signal: controller.signal });

    expect(outcome.interrupted).toBe(true);
    expect(outcome.stats.notesExported).toBe(0);
    // No half-written note, and no ledger row claiming a file that is not there.
    expect(await vaultFiles('ADRs')).toEqual([]);
    expect(await readLedger(testDatabase().db, ['adr'])).toEqual([]);
  });
});

// --------------------------------------------------------------------------- worker health

describe('worker health', () => {
  it('a sync-worker heartbeat flips the Services row from disabled to healthy', async () => {
    const findService = (body: { data: { services: { name: string; status: string }[] } }) =>
      body.data.services.find((service) => service.name === 'sync-worker');

    const before = await app.app.inject({
      method: 'GET',
      url: '/api/v1/services/health',
      headers: { cookie },
    });

    // No heartbeat row has ever been written: the worker reads as "not deployed".
    expect(findService(before.json())?.status).toBe('disabled');

    await createDatabaseHeartbeatSink(testDatabase().db)({
      service: 'sync-worker',
      pid: process.pid,
      version: '0.0.0-test',
      startedAt: new Date(),
      heartbeatAt: new Date(),
      stats: { jobsProcessed: 1, syncRuns: 1 },
    });

    // A second app, because the read model caches for ~5 s per process (TDS 02 §7.1) and
    // sleeping the cache out would be a slow test that proves nothing extra.
    const fresh = createTestApp({ cookieSecure: false });
    const after = await fresh.app.inject({
      method: 'GET',
      url: '/api/v1/services/health',
      headers: { cookie },
    });

    expect(findService(after.json())?.status).toBe('healthy');
    await fresh.sessions.registry.stop();
    await fresh.app.close();
  });
});

describe('settings storage', () => {
  it('round-trips a Windows vault path through the settings row', async () => {
    await configureObsidian({ vaultPath: 'D:\\Repos\\Vault\\Notes' });

    const settings = await readObsidianSettings(testDatabase().db);
    expect(settings.vaultPath).toBe('D:\\Repos\\Vault\\Notes');
  });
});
