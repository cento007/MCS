import { newId, type PgBossQueue, QUEUE_NAMES, readLocalDayWindow, schema } from '@mc/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  configureTelegram,
  eventsOfType,
  jobsOn,
  seedUser,
  setSetting,
  testDatabase,
  testQueue,
  truncateAll,
} from '../test/integration/harness.js';
import { DailyReportService } from './daily-report.js';

/**
 * The daily report against a real database (TDS 02 §2.2, PRD §9).
 *
 * The property that needs real PostgreSQL is the **day boundary**: `18:00` is a wall-clock time
 * in `general.timezone`, and every "did today's report already go out" decision is measured
 * from local midnight. A zone whose day boundary differs from UTC's is therefore not an edge
 * case here — it is the case.
 */

let queue: PgBossQueue;
let userId: string;

function service(now: () => Date): DailyReportService {
  return new DailyReportService({ db: testDatabase().db, queue, now });
}

/** `Pacific/Kiritimati` is UTC+14: its calendar day starts at 10:00 UTC the previous day. */
const KIRITIMATI = 'Pacific/Kiritimati';

async function reports(): Promise<(typeof schema.notifications.$inferSelect)[]> {
  const rows = await testDatabase().db.select().from(schema.notifications);
  return rows.filter((row) => row.type === 'daily_report');
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  userId = await seedUser();
  await configureTelegram();
  await setSetting('notifications', 'daily_report', { enabled: true, time: '18:00' });
});

describe('firing at the configured local time', () => {
  it('does not fire before the configured minute', async () => {
    await setSetting('general', 'timezone', 'UTC');

    const summary = await service(() => new Date('2026-08-13T17:59:00.000Z')).tick();

    expect(summary).toMatchObject({ ran: false, reason: 'not_due' });
    expect(await reports()).toHaveLength(0);
  });

  it('fires at the configured minute', async () => {
    await setSetting('general', 'timezone', 'UTC');

    const summary = await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();

    expect(summary).toMatchObject({ ran: true, reason: 'produced' });
    const rows = await reports();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe('Daily report — 2026-08-13');
  });

  /**
   * The timezone test the task asks for: in `Pacific/Kiritimati` (UTC+14), 18:00 local on the
   * 13th is 04:00 UTC on the *same* date only by coincidence of arithmetic — it is
   * `2026-08-13T04:00Z`, ten hours *before* UTC's 18:00, and the local calendar date is already
   * a day ahead of UTC's for most of the UTC day. A worker that used UTC would send this report
   * ten hours late and label it with the wrong date.
   */
  it('uses the instance timezone, not UTC, for a zone whose day boundary differs', async () => {
    await setSetting('general', 'timezone', KIRITIMATI);

    // 03:59 UTC on the 13th = 17:59 local on the 13th — not yet due.
    const early = await service(() => new Date('2026-08-13T03:59:00.000Z')).tick();
    expect(early.ran).toBe(false);

    // 04:00 UTC = 18:00 local. Due.
    const onTime = await service(() => new Date('2026-08-13T04:00:00.000Z')).tick();
    expect(onTime).toMatchObject({ ran: true, reason: 'produced' });

    const rows = await reports();
    expect(rows[0]?.title).toBe('Daily report — 2026-08-13');
    expect(rows[0]?.body).toContain(`(${KIRITIMATI})`);
    // Sanity: UTC's 18:00 on the 13th is already the *next* local day, so a UTC-based
    // implementation would have produced a report titled 2026-08-14 at that moment.
    const day = await readLocalDayWindow(
      testDatabase().db,
      KIRITIMATI,
      new Date('2026-08-13T18:00:00.000Z'),
    );
    expect(day.localDate).toBe('2026-08-14');
  });

  it('still fires when the worker was down at the configured minute', async () => {
    await setSetting('general', 'timezone', 'UTC');

    const summary = await service(() => new Date('2026-08-13T21:47:00.000Z')).tick();

    expect(summary.ran).toBe(true);
  });
});

describe('firing once', () => {
  it('does not produce a second report the same local day', async () => {
    await setSetting('general', 'timezone', 'UTC');

    await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();
    const second = await service(() => new Date('2026-08-13T18:05:00.000Z')).tick();

    expect(second).toMatchObject({ ran: false, reason: 'already_sent' });
    expect(await reports()).toHaveLength(1);
  });

  it('produces again the next local day', async () => {
    await setSetting('general', 'timezone', 'UTC');

    await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();
    await service(() => new Date('2026-08-14T18:00:00.000Z')).tick();

    expect(await reports()).toHaveLength(2);
  });
});

describe('the operator’s settings', () => {
  it('produces nothing when the daily report is switched off', async () => {
    await setSetting('general', 'timezone', 'UTC');
    await setSetting('notifications', 'daily_report', { enabled: false, time: '18:00' });

    const summary = await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();

    expect(summary).toMatchObject({ ran: false, reason: 'disabled' });
    expect(await reports()).toHaveLength(0);
  });

  it('produces nothing when Telegram itself is off — matching what /schedule reports', async () => {
    await setSetting('general', 'timezone', 'UTC');
    await setSetting('integrations', 'telegram_enabled', false);

    const summary = await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();

    expect(summary).toMatchObject({ ran: false, reason: 'disabled' });
  });

  it('keeps rescheduling itself so a settings change is picked up', async () => {
    await setSetting('general', 'timezone', 'UTC');
    await setSetting('notifications', 'daily_report', { enabled: false, time: '18:00' });

    await service(() => new Date('2026-08-13T09:00:00.000Z')).tick();

    const ticks = await jobsOn(QUEUE_NAMES.NOTIFICATION_SCHEDULE);
    expect(ticks).toHaveLength(1);
  });

  it('does not start a second scheduler chain when primed twice', async () => {
    await setSetting('general', 'timezone', 'UTC');
    const at = new Date('2026-08-13T09:00:00.000Z');

    await service(() => at).tick();
    await service(() => at).tick();

    // Deterministic tick ids collapse into one job (`ON CONFLICT (name, id) DO NOTHING`).
    expect(await jobsOn(QUEUE_NAMES.NOTIFICATION_SCHEDULE)).toHaveLength(1);
  });
});

describe('the report itself', () => {
  it('writes the row and its delivery job in one transaction, and emits notification.created', async () => {
    await setSetting('general', 'timezone', 'UTC');

    const summary = await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();
    const id = summary.notificationId;
    expect(id).not.toBeNull();

    const rows = await reports();
    expect(rows[0]?.telegramStatus).toBe('pending');

    const jobs = await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data['notificationId']).toBe(id);

    const created = await eventsOfType('notification.created');
    expect(created).toHaveLength(1);
    expect(payloadOf(created[0])['notificationType']).toBe('daily_report');
    expect(created[0]?.['source']).toBe('telegram-worker');
  });

  it('counts the PRD §9 figures for the local day only', async () => {
    await setSetting('general', 'timezone', 'UTC');

    const { workspaceId, projectId } = await seedProject();
    const repositoryId = await seedRepository(projectId);

    // Inside the day.
    await seedSession(projectId, userId, new Date('2026-08-13T09:00:00.000Z'), 'completed');
    await seedSession(projectId, userId, new Date('2026-08-13T11:00:00.000Z'), 'failed');
    // Outside it — yesterday.
    await seedSession(projectId, userId, new Date('2026-08-12T09:00:00.000Z'), 'completed');

    await testDatabase()
      .db.insert(schema.pullRequests)
      .values({
        id: newId(),
        repositoryId,
        number: 12,
        title: 'Add the telegram worker',
        state: 'open',
        openedAt: new Date('2026-08-13T10:00:00.000Z'),
      });

    await testDatabase()
      .db.insert(schema.adrs)
      .values({
        id: newId(),
        projectId,
        adrNumber: 1,
        title: 'Defer, do not suppress',
        createdAt: new Date('2026-08-13T12:00:00.000Z'),
      });

    expect(workspaceId).toBeTruthy();

    await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();

    const body = (await reports())[0]?.body ?? '';
    expect(body).toContain('Projects active: 1');
    expect(body).toContain('Sessions: 2 started · 1 completed · 1 failed');
    expect(body).toContain('Pull requests: 1 opened · 0 merged');
    expect(body).toContain('ADRs: 1');
  });

  it('says a quiet day was quiet rather than looking broken', async () => {
    await setSetting('general', 'timezone', 'UTC');

    await service(() => new Date('2026-08-13T18:00:00.000Z')).tick();

    expect((await reports())[0]?.body).toContain('No activity recorded for this day.');
  });
});

// ------------------------------------------------------------------------------- factories

async function seedProject(): Promise<{ workspaceId: string; projectId: string }> {
  const workspaceId = newId();
  const projectId = newId();
  const db = testDatabase().db;

  await db.insert(schema.workspaces).values({ id: workspaceId, name: 'Default' });
  await db.insert(schema.projects).values({ id: projectId, workspaceId, name: 'Mission Control' });

  return { workspaceId, projectId };
}

async function seedRepository(projectId: string): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.repositories)
    .values({ id, projectId, name: 'mcs', localPath: `/tmp/${id}` });
  return id;
}

async function seedSession(
  projectId: string,
  ownerId: string,
  startedAt: Date,
  state: string,
): Promise<string> {
  const id = newId();
  await testDatabase().db.insert(schema.sessions).values({
    id,
    projectId,
    userId: ownerId,
    sessionType: 'managed',
    state,
    startedAt,
    completedAt: startedAt,
  });
  return id;
}

/** The `payload` of an F6 envelope read back off the queue, with the absence made explicit. */
function payloadOf(event: Record<string, unknown> | undefined): Record<string, unknown> {
  if (event === undefined) throw new Error('expected an event, found none');
  const payload = event['payload'];
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`event carried no payload object: ${JSON.stringify(event)}`);
  }
  return payload as Record<string, unknown>;
}
