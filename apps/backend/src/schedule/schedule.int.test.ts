import type { PgBossQueue } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedNotification,
  seedProject,
  seedRepository,
  seedSyncRun,
  seedUser,
  setSecretPresent,
  setSetting,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import type { ScheduleEntry, ScheduleKind } from './index.js';

/**
 * `GET /api/v1/schedule` end to end (TDS 04 §7.7 / arbitration A1).
 *
 * The property under test is honesty: every value is **derived at read time and never
 * persisted**, and an unset source setting produces `enabled: false` + `nextRunAt: null` rather
 * than an invented time. A1 chose this model precisely so no Task entity would be smuggled in,
 * so the absence of any write path is part of the contract.
 */

let queue: PgBossQueue;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let projectId: string;
let userId: string;

async function readSchedule(): Promise<readonly ScheduleEntry[]> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/schedule',
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });

  expect(response.statusCode).toBe(200);
  return response.json<{ data: ScheduleEntry[] }>().data;
}

async function entryOf(kind: ScheduleKind): Promise<ScheduleEntry> {
  const entry = (await readSchedule()).find((row) => row.kind === kind);
  if (entry === undefined) throw new Error(`No schedule row for ${kind}`);
  return entry;
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());

  built = createTestApp({ queue, cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

afterEach(async () => {
  await built?.sessions.registry.stop();
  await built?.app.close();
});

describe('contract shape and auth', () => {
  it('rejects the read without a credential', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/schedule' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('returns the four kinds with no `meta` — fixed cardinality, no pagination', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/schedule',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(Object.keys(response.json<Record<string, unknown>>())).toEqual(['data']);
    const rows = response.json<{ data: ScheduleEntry[] }>().data;
    expect(rows.map((row) => row.kind)).toEqual([
      'obsidian_sync',
      'github_poll',
      'daily_report',
      'memory_retention',
    ]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'enabled',
        'kind',
        'label',
        'lastRunAt',
        'nextRunAt',
      ]);
      expect(typeof row.label).toBe('string');
    }
  });

  it('is read-only — there is no POST or PATCH on this path', async () => {
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: '/api/v1/schedule',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });
      expect(response.statusCode).toBe(404);
    }
  });

  it('persists nothing — reading the schedule creates no rows anywhere', async () => {
    const before = await testDatabase().db.execute<{ tables: number }>(
      "SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'",
    );

    await readSchedule();
    await readSchedule();

    const after = await testDatabase().db.execute<{ tables: number }>(
      "SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(after.rows[0]?.tables).toBe(before.rows[0]?.tables);
  });
});

describe('unconfigured instance — every row is returned, disabled and honest', () => {
  it('returns all four rows with enabled: false and nextRunAt: null', async () => {
    const rows = await readSchedule();

    for (const row of rows) {
      expect(row.enabled).toBe(false);
      expect(row.nextRunAt).toBeNull();
    }
  });

  it('invents no interval when the setting rows do not exist', async () => {
    // A vault path with no interval row is "not configured", not "every 15 minutes".
    await setSetting('integrations', 'obsidian_vault_path', 'D:\\Vaults\\Engineering');

    const entry = await entryOf('obsidian_sync');
    expect(entry.enabled).toBe(false);
    expect(entry.nextRunAt).toBeNull();
  });
});

describe('obsidian_sync (§7.7 table)', () => {
  beforeEach(async () => {
    await setSetting('integrations', 'obsidian_vault_path', 'D:\\Vaults\\Engineering');
    await setSetting('integrations', 'obsidian_sync_mode', 'two_way');
    await setSetting('integrations', 'obsidian_sync_interval_minutes', 15);
  });

  it('is enabled with vault + mode + interval, and schedules from now when nothing has run', async () => {
    const before = Date.now();
    const entry = await entryOf('obsidian_sync');

    expect(entry.enabled).toBe(true);
    expect(entry.lastRunAt).toBeNull();
    const next = new Date(entry.nextRunAt as string).getTime();
    expect(next).toBeGreaterThanOrEqual(before + 15 * 60_000 - 5_000);
    expect(next).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 5_000);
  });

  it('schedules from the newest completed SyncRun once one exists', async () => {
    const completedAt = new Date('2026-08-12T09:00:00.000Z');
    await seedSyncRun({ completedAt: new Date('2026-08-12T08:00:00.000Z') });
    await seedSyncRun({ completedAt });

    const entry = await entryOf('obsidian_sync');

    expect(entry.lastRunAt).toBe(completedAt.toISOString());
    // Overdue by design: the endpoint reports the schedule, not the queue, and does not clamp.
    expect(entry.nextRunAt).toBe(new Date(completedAt.getTime() + 15 * 60_000).toISOString());
  });

  it('reports a run still in flight as "no completed run yet" rather than guessing', async () => {
    await seedSyncRun({ state: 'running', completedAt: null });

    const entry = await entryOf('obsidian_sync');
    expect(entry.lastRunAt).toBeNull();
    expect(entry.enabled).toBe(true);
  });

  it('is disabled while sync mode is paused', async () => {
    await testDatabase().db.execute(
      "UPDATE settings SET value = '\"paused\"' WHERE key = 'obsidian_sync_mode'",
    );

    const entry = await entryOf('obsidian_sync');
    expect(entry.enabled).toBe(false);
    expect(entry.nextRunAt).toBeNull();
  });

  it('is disabled at interval 0 — manual only', async () => {
    await testDatabase().db.execute(
      "UPDATE settings SET value = '0' WHERE key = 'obsidian_sync_interval_minutes'",
    );

    expect((await entryOf('obsidian_sync')).enabled).toBe(false);
  });
});

describe('github_poll (§7.7 table)', () => {
  it('needs both a PAT and an interval', async () => {
    await setSetting('integrations', 'github_sync_interval_minutes', 30);
    expect((await entryOf('github_poll')).enabled).toBe(false);

    await setSecretPresent('integrations', 'github_token');
    expect((await entryOf('github_poll')).enabled).toBe(true);
  });

  it('reports the newest repository sync as lastRunAt and schedules from it', async () => {
    await setSetting('integrations', 'github_sync_interval_minutes', 30);
    await setSecretPresent('integrations', 'github_token');

    const older = new Date('2026-08-12T08:00:00.000Z');
    const newest = new Date('2026-08-12T10:30:00.000Z');
    await seedRepository(projectId, { lastSyncedAt: older });
    await seedRepository(projectId, { lastSyncedAt: newest });

    const entry = await entryOf('github_poll');

    expect(entry.lastRunAt).toBe(newest.toISOString());
    expect(entry.nextRunAt).toBe(new Date(newest.getTime() + 30 * 60_000).toISOString());
  });

  it('schedules from now when no repository has ever synced', async () => {
    await setSetting('integrations', 'github_sync_interval_minutes', 30);
    await setSecretPresent('integrations', 'github_token');
    await seedRepository(projectId);

    const entry = await entryOf('github_poll');

    expect(entry.lastRunAt).toBeNull();
    expect(new Date(entry.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('daily_report (§7.7 table)', () => {
  it('needs Telegram enabled as well as the report toggle', async () => {
    await setSetting('notifications', 'daily_report', { enabled: true, time: '18:00' });
    expect((await entryOf('daily_report')).enabled).toBe(false);

    await setSetting('integrations', 'telegram_enabled', true);
    expect((await entryOf('daily_report')).enabled).toBe(true);
  });

  it('computes the next occurrence of the configured time in general.timezone', async () => {
    await setSetting('general', 'timezone', 'Asia/Tokyo');
    await setSetting('notifications', 'daily_report', { enabled: true, time: '18:00' });
    await setSetting('integrations', 'telegram_enabled', true);

    const entry = await entryOf('daily_report');
    const next = new Date(entry.nextRunAt as string);

    // 18:00 in UTC+9 is 09:00Z — a boundary a UTC-only implementation cannot produce.
    expect(next.getUTCHours()).toBe(9);
    expect(next.getUTCMinutes()).toBe(0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });

  it('rolls to tomorrow once today’s delivery time has passed', async () => {
    // Midnight local is behind "now" for all but one minute of the day; the next occurrence
    // must therefore be in the future, never in the past.
    await setSetting('general', 'timezone', 'UTC');
    await setSetting('notifications', 'daily_report', { enabled: true, time: '00:00' });
    await setSetting('integrations', 'telegram_enabled', true);

    const entry = await entryOf('daily_report');
    const next = new Date(entry.nextRunAt as string);

    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  it('reports the newest daily_report Notification as lastRunAt', async () => {
    await setSetting('notifications', 'daily_report', { enabled: true, time: '18:00' });
    await setSetting('integrations', 'telegram_enabled', true);

    const createdAt = new Date('2026-08-11T16:00:00.000Z');
    await seedNotification({ userId, type: 'daily_report', createdAt });
    await seedNotification({ userId, type: 'session_completed' });

    expect((await entryOf('daily_report')).lastRunAt).toBe(createdAt.toISOString());
  });

  it('still reports lastRunAt when the row is disabled — history is not hidden', async () => {
    const createdAt = new Date('2026-08-11T16:00:00.000Z');
    await seedNotification({ userId, type: 'daily_report', createdAt });

    const entry = await entryOf('daily_report');
    expect(entry.enabled).toBe(false);
    expect(entry.nextRunAt).toBeNull();
    expect(entry.lastRunAt).toBe(createdAt.toISOString());
  });

  it('falls back to UTC rather than failing when the stored zone is unusable', async () => {
    await setSetting('general', 'timezone', 'Mars/Olympus');
    await setSetting('notifications', 'daily_report', { enabled: true, time: '18:00' });
    await setSetting('integrations', 'telegram_enabled', true);

    const entry = await entryOf('daily_report');
    expect(new Date(entry.nextRunAt as string).getUTCHours()).toBe(18);
  });
});

/**
 * The Phase 3 sweep — a chain that deletes an operator's memory on a timer, and was the only one
 * of the four self-rescheduling jobs this endpoint did not report.
 */
describe('memory_retention (Phase 3)', () => {
  it('is disabled while every tier keeps everything — the chain does not even run', async () => {
    const entry = await entryOf('memory_retention');

    expect(entry.enabled).toBe(false);
    expect(entry.nextRunAt).toBeNull();
    expect(entry.label).toBe('Memory retention sweep');
  });

  it('turns on the moment a tier is given a retention window', async () => {
    await setSetting('memory', 'retention_days', { session: 30, project: 0, global: 0 });

    expect((await entryOf('memory_retention')).enabled).toBe(true);
  });

  it('reports the tick the scheduler actually queued, not an interval it recomputed', async () => {
    await setSetting('memory', 'retention_days', { session: 30, project: 0, global: 0 });

    // Priming is what a real Backend does at boot and after `PUT /settings/memory`. The row must
    // then name *that* job's due time — the sweep's interval is a constant, not a setting, so a
    // recomputed answer would only agree with the queue by luck.
    await built.memory.retention.prime();

    const entry = await entryOf('memory_retention');
    expect(entry.nextRunAt).not.toBeNull();

    const queued = await testDatabase().db.execute<{ start_after: string }>(
      "SELECT min(start_after)::text AS start_after FROM pgboss.job WHERE name = 'memory.retention' AND state IN ('created','retry')",
    );
    expect(Date.parse(entry.nextRunAt as string)).toBe(
      Date.parse(queued.rows[0]?.start_after as string),
    );
  });

  it('says "never run" rather than inventing a last sweep', async () => {
    await setSetting('memory', 'retention_days', { session: 30, project: 0, global: 0 });
    await built.memory.retention.prime();

    // Nothing has swept yet, and no artifact records one — a sweep that deletes nothing writes
    // nothing. `null` is the honest answer and the widget renders it as "never run".
    expect((await entryOf('memory_retention')).lastRunAt).toBeNull();
  });
});

describe('derived, never stored', () => {
  it('changes the answer the moment a setting changes, with no worker involved', async () => {
    await setSetting('integrations', 'obsidian_vault_path', 'D:\\Vaults\\Engineering');
    await setSetting('integrations', 'obsidian_sync_interval_minutes', 15);

    const before = await entryOf('obsidian_sync');
    expect(before.enabled).toBe(true);

    await testDatabase().db.execute(
      "UPDATE settings SET value = '0' WHERE key = 'obsidian_sync_interval_minutes'",
    );

    const after = await entryOf('obsidian_sync');
    expect(after.enabled).toBe(false);
    expect(after.nextRunAt).toBeNull();
  });
});
