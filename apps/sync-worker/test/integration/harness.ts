import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, insertAdr, newId, type PgBossQueue, schema } from '@mc/shared';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseHandle } from '../../src/db.js';
import { WorkerOutbox } from '../../src/outbox.js';
import { createWorkerQueue } from '../../src/queue.js';

/**
 * Integration support for the Sync Worker (TDS 07 §3.1).
 *
 * Everything the worker's own `*.int.test.ts` files need: the per-file database created by
 * `setup.ts`, a real pg-boss queue over it, an outbox, real temp vault directories, and the
 * few row factories the sync and drafting paths consume.
 *
 * **No Fastify app is built here.** This process has no HTTP surface (F2.2), and a test that
 * reached for one would be testing the wrong process.
 */

let currentDatabaseUrl: string | null = null;
let currentDatabase: DatabaseHandle | null = null;
let currentQueue: PgBossQueue | null = null;
const tempDirectories: string[] = [];

export const silentLogger = createLogger({ service: 'sync-worker', level: 'silent' });

export function setTestDatabaseUrl(url: string): void {
  currentDatabaseUrl = url;
}

export function testDatabaseUrl(): string {
  if (currentDatabaseUrl === null) {
    throw new Error('No test database — is this file running under the integration config?');
  }
  return currentDatabaseUrl;
}

export function testDatabase(): DatabaseHandle {
  currentDatabase ??= createDatabase({ connectionString: testDatabaseUrl(), maxConnections: 6 });
  return currentDatabase;
}

/** The real queue driver, with the polling floor dropped so no case waits out a poll. */
export async function testQueue(): Promise<PgBossQueue> {
  if (currentQueue !== null) return currentQueue;

  const queue = createWorkerQueue({
    connectionString: testDatabaseUrl(),
    pollingIntervalSeconds: 0.5,
    supervise: false,
    schedule: false,
  });
  await queue.start();
  currentQueue = queue;
  return queue;
}

export async function testOutbox(): Promise<WorkerOutbox> {
  return new WorkerOutbox({ db: testDatabase().db, queue: await testQueue() });
}

/** A real, empty directory to use as a vault — never the operator's own. */
export function testVaultDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mc-worker-vault-'));
  tempDirectories.push(directory);
  return directory;
}

export async function closeTestResources(): Promise<void> {
  if (currentQueue !== null) {
    await currentQueue.stop();
    currentQueue = null;
  }
  if (currentDatabase !== null) {
    await currentDatabase.close();
    currentDatabase = null;
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function truncateAll(): Promise<void> {
  const tables = [
    'audit_log_entries',
    'messages',
    'session_events',
    'sessions',
    'adrs',
    'obsidian_sync_states',
    'sync_runs',
    'service_heartbeats',
    'repositories',
    'projects',
    'workspaces',
    'users',
    'settings',
    'secret_items',
  ];
  const list = tables.map((name) => `public."${name}"`).join(', ');
  await testDatabase().db.execute(sql.raw(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`));

  const exists = await testDatabase().db.execute<{ present: boolean }>(
    sql`SELECT to_regclass('pgboss.job') IS NOT NULL AS present`,
  );
  if (exists.rows[0]?.present === true) {
    await testDatabase().db.execute(sql.raw('TRUNCATE TABLE pgboss.job'));
  }
}

// ------------------------------------------------------------------------- row factories

export async function seedOperator(): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.users)
    .values({ id, username: 'operator', passwordHash: 'not-a-credential' });
  return id;
}

export async function seedProject(name = 'Mission Control'): Promise<string> {
  const workspaceId = newId();
  const projectId = newId();
  const db = testDatabase().db;

  await db.insert(schema.workspaces).values({ id: workspaceId, name: 'Default' });
  await db.insert(schema.projects).values({ id: projectId, workspaceId, name });
  return projectId;
}

export async function seedSession(input: {
  readonly projectId: string;
  readonly userId: string;
  readonly state?: string;
  readonly title?: string | null;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.sessions)
    .values({
      id,
      projectId: input.projectId,
      userId: input.userId,
      sessionType: 'managed',
      state: input.state ?? 'completed',
      title: input.title ?? null,
      startedAt: new Date('2026-08-13T08:00:00.000Z'),
    });
  return id;
}

export async function seedMessage(input: {
  readonly sessionId: string;
  readonly ordinal: number;
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly toolFilePath?: string;
}): Promise<void> {
  await testDatabase()
    .db.insert(schema.messages)
    .values({
      id: newId(),
      sessionId: input.sessionId,
      ordinal: input.ordinal,
      role: input.role,
      content: input.content,
      ...(input.toolFilePath === undefined ? {} : { toolFilePath: input.toolFilePath }),
    });
}

export async function seedAdr(input: {
  readonly projectId: string;
  readonly title?: string;
  readonly sourceSessionId?: string;
}): Promise<string> {
  const row = await testDatabase().db.transaction((tx) =>
    insertAdr(tx, {
      projectId: input.projectId,
      title: input.title ?? 'Existing decision',
      ...(input.sourceSessionId === undefined ? {} : { sourceSessionId: input.sourceSessionId }),
    }),
  );
  return row.id;
}

/** Write the `integrations.obsidian.*` rows directly — the settings service is Backend-side. */
export async function setObsidianSettings(values: {
  readonly vaultPath?: string | null;
  readonly syncMode?: string;
  readonly conflictPolicy?: string;
  readonly intervalMinutes?: number;
}): Promise<void> {
  const db = testDatabase().db;
  const rows: { key: string; value: unknown; valueType: 'string' | 'number' }[] = [
    { key: 'obsidian_sync_mode', value: values.syncMode ?? 'two_way', valueType: 'string' },
    {
      key: 'obsidian_conflict_policy',
      value: values.conflictPolicy ?? 'newer_wins',
      valueType: 'string',
    },
    {
      key: 'obsidian_sync_interval_minutes',
      value: values.intervalMinutes ?? 0,
      valueType: 'number',
    },
  ];
  if (values.vaultPath !== null && values.vaultPath !== undefined) {
    rows.push({ key: 'obsidian_vault_path', value: values.vaultPath, valueType: 'string' });
  }

  for (const row of rows) {
    await db
      .insert(schema.settings)
      .values({ id: newId(), category: 'integrations', ...row })
      .onConflictDoNothing();
  }
}
