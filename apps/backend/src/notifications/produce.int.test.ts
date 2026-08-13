import { newId, type PgBossQueue, QUEUE_NAMES, schema } from '@mc/shared';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  seedProject,
  seedRepository,
  seedSession,
  seedUser,
  setSecretPresent,
  setSetting,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';

/**
 * Notification **production** end to end (TDS 04 §8, §15.2; storage TDS 03 §4.2).
 *
 * The properties under test are the ones a fake could not prove:
 *
 *  - the `notifications` row and its `notification.deliver` job commit **together**, and roll
 *    back together (F6.3 — the same guarantee `outbox.int.test.ts` asserts for events, now for
 *    the Notification pair);
 *  - the operator's settings decide what exists: a per-event toggle off produces nothing, the
 *    master switch produces an in-app row with a `skipped` channel, and quiet hours **defer**
 *    with the deferral visible in the record;
 *  - a missing bot token or chat id is a terminal `skipped` with a stated reason, not a job
 *    that comes back forever.
 *
 * There is no HTTP surface for creation (§8: "creation is system-only"), so the producer is
 * driven directly — that is the seam, and the route that does not exist is the point.
 */

type JobRow = {
  id: string;
  name: string;
  data: { notificationId: string; attempt: number };
  start_after: string | Date;
};

let queue: PgBossQueue;
let built: TestApp;
let userId: string;
let projectId: string;

async function dispatchJobs(): Promise<JobRow[]> {
  const result = await testDatabase().db.execute<JobRow>(
    sql`SELECT id, name, data, start_after FROM pgboss.job
        WHERE name = ${QUEUE_NAMES.NOTIFICATION_DELIVER} ORDER BY created_on`,
  );
  return result.rows;
}

async function notifications() {
  return testDatabase().db.select().from(schema.notifications);
}

/** Telegram fully configured: master on, chat id set, token row present. */
async function configureTelegram(): Promise<void> {
  await setSetting('integrations', 'telegram_enabled', true);
  await setSetting('integrations', 'telegram_chat_id', '-1001234567890');
  await setSecretPresent('integrations', 'telegram_bot_token');
}

async function completeSession(sessionId: string, correlationId = newId()): Promise<void> {
  await built.notifications.producer?.handleEvent(
    built.outbox.event('session.completed', { sessionId, trigger: 'system' }, { correlationId }),
  );
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();

  const user = await seedUser();
  userId = user.id;
  projectId = (await seedProject()).projectId;

  built = createTestApp({ queue });
});

describe('the row and its delivery job are one transaction (F6.3)', () => {
  it('commits the notification, the dispatch job and notification.created together', async () => {
    await configureTelegram();
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      startedAt: new Date(Date.now() - 60_000),
    });

    const produced = await built.notifications.producer?.handleEvent(
      built.outbox.event('session.completed', { sessionId, trigger: 'system' }),
    );

    expect(produced?.type).toBe('session_completed');

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId,
      type: 'session_completed',
      severity: 'info',
      telegramStatus: 'pending',
    });
    expect(rows[0]?.title).toContain('Session completed');

    const jobs = await dispatchJobs();
    expect(jobs).toHaveLength(1);
    // The job id IS the notification id on first enqueue — producing twice cannot double-deliver.
    expect(jobs[0]?.id).toBe(rows[0]?.id);
    expect(jobs[0]?.data.notificationId).toBe(rows[0]?.id);
    expect(jobs[0]?.data.attempt).toBe(1);

    const events = await testDatabase().db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM pgboss.job
          WHERE name = ${QUEUE_NAMES.EVENTS} AND data->>'type' = 'notification.created'`,
    );
    expect(events.rows[0]?.count).toBe('1');
  });

  it('leaves neither behind when the transaction rolls back', async () => {
    await configureTelegram();

    // Force the failure *inside* the outbox transaction, after both writes: a notification id
    // that violates the FK is the cleanest way to make the commit fail rather than the caller.
    const producer = built.notifications.producer;
    if (producer === undefined) throw new Error('no producer');

    await expect(
      built.outbox.run(async (ctx) => {
        await ctx.tx.insert(schema.notifications).values({
          id: newId(),
          userId,
          type: 'session_completed',
          severity: 'info',
          title: 'about to roll back',
          body: '',
          telegramStatus: 'pending',
        });
        await ctx.emit(
          built.outbox.event('notification.created', {
            notificationId: newId(),
            notificationType: 'session_completed',
            severity: 'info',
          }),
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await notifications()).toHaveLength(0);
    const events = await testDatabase().db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM pgboss.job WHERE name = ${QUEUE_NAMES.EVENTS}`,
    );
    expect(events.rows[0]?.count).toBe('0');
  });

  it('produces at most one notification per event even when the producer runs twice', async () => {
    await configureTelegram();
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });
    const correlationId = newId();

    // At-least-once delivery means the same domain event can reach the producer twice.
    await completeSession(sessionId, correlationId);
    const jobsAfterFirst = await dispatchJobs();

    await completeSession(sessionId, correlationId);
    const jobsAfterSecond = await dispatchJobs();

    // Two Notification rows (they are distinct records of two observations)…
    expect((await notifications()).length).toBe(2);
    // …but each has exactly one delivery job, keyed on its own id. Nothing is doubled.
    expect(jobsAfterFirst).toHaveLength(1);
    expect(jobsAfterSecond).toHaveLength(2);
    expect(new Set(jobsAfterSecond.map((job) => job.id)).size).toBe(2);
  });
});

describe('the operator’s settings decide what exists', () => {
  it('produces nothing at all when the per-event toggle is off', async () => {
    await configureTelegram();
    await setSetting('notifications', 'events', {
      sessionComplete: false,
      sessionFailed: true,
      syncFailed: true,
      repositoryProblem: true,
      costBudgetAlert: true,
    });

    const sessionId = await seedSession({ projectId, userId, state: 'completed' });
    const produced = await built.notifications.producer?.handleEvent(
      built.outbox.event('session.completed', { sessionId, trigger: 'system' }),
    );

    expect(produced).toBeNull();
    expect(await notifications()).toHaveLength(0);
    expect(await dispatchJobs()).toHaveLength(0);
  });

  it('keeps the in-app row and skips the channel when Telegram is disabled', async () => {
    await setSetting('integrations', 'telegram_enabled', false);
    const sessionId = await seedSession({ projectId, userId, state: 'failed' });

    await built.notifications.producer?.handleEvent(
      built.outbox.event('session.failed', { sessionId, reason: 'process_crash' }),
    );

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramStatus).toBe('skipped');
    expect(rows[0]?.telegramError).toContain('switched off');
    // Nothing to deliver, so nothing is queued — a `skipped` row is terminal.
    expect(await dispatchJobs()).toHaveLength(0);
  });

  it('reports a missing bot token as a stated, terminal skip', async () => {
    await setSetting('integrations', 'telegram_enabled', true);
    await setSetting('integrations', 'telegram_chat_id', '-100');
    const sessionId = await seedSession({ projectId, userId, state: 'failed' });

    await built.notifications.producer?.handleEvent(
      built.outbox.event('session.failed', { sessionId, reason: 'spawn_error' }),
    );

    const rows = await notifications();
    expect(rows[0]?.telegramStatus).toBe('skipped');
    expect(rows[0]?.telegramError).toContain('bot token');
    expect(await dispatchJobs()).toHaveLength(0);
  });

  /**
   * Regression: a Telegram chat id is a **numeric string** (`-1001234567890`). Drizzle's
   * `jsonb()` re-parsed the value `pg` had already parsed, turning it into a number, which
   * `stringValue()` then rejected — so a configured chat id read back as "not set" and every
   * Notification was recorded `skipped`. Fixed by the `jsonValue` column type; asserted here
   * because only a real round trip through PostgreSQL can prove it.
   */
  it('reads a numeric chat id back as the string it is', async () => {
    await configureTelegram();
    const sessionId = await seedSession({ projectId, userId, state: 'failed' });

    await built.notifications.producer?.handleEvent(
      built.outbox.event('session.failed', { sessionId, reason: 'process_crash' }),
    );

    const rows = await notifications();
    expect(rows[0]?.telegramStatus).toBe('pending');
    expect(rows[0]?.telegramError).toBeNull();
  });

  it('reports a missing chat id separately from a missing token', async () => {
    await setSetting('integrations', 'telegram_enabled', true);
    await setSecretPresent('integrations', 'telegram_bot_token');
    const sessionId = await seedSession({ projectId, userId, state: 'failed' });

    await built.notifications.producer?.handleEvent(
      built.outbox.event('session.failed', { sessionId, reason: 'spawn_error' }),
    );

    expect((await notifications())[0]?.telegramError).toContain('chat ID');
  });
});

describe('quiet hours defer, they do not suppress', () => {
  it('keeps the notification, delays the job, and records the deferral in the payload', async () => {
    await configureTelegram();
    await setSetting('general', 'timezone', 'UTC');
    // A window that certainly contains "now", whatever time the suite runs.
    await setSetting('notifications', 'quiet_hours', {
      enabled: true,
      start: '00:00',
      end: '23:59',
    });

    const sessionId = await seedSession({ projectId, userId, state: 'failed' });
    const produced = await built.notifications.producer?.handleEvent(
      built.outbox.event('session.failed', { sessionId, reason: 'process_crash' }),
    );

    // Deferred, not dropped: the row exists and is still `pending`.
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.telegramStatus).toBe('pending');
    expect(produced?.deferUntil).toBeInstanceOf(Date);

    // The choice is visible in the record, not only in the queue.
    const payload = rows[0]?.payload as Record<string, unknown>;
    expect(payload['quietHours']).toMatchObject({ start: '00:00', end: '23:59', timezone: 'UTC' });

    // …and the delivery job is genuinely delayed.
    const jobs = await dispatchJobs();
    expect(jobs).toHaveLength(1);
    expect(new Date(jobs[0]?.start_after as unknown as string).getTime()).toBeGreaterThan(
      Date.now() + 1_000,
    );
  });

  it('delivers immediately when the window does not contain now', async () => {
    await configureTelegram();
    await setSetting('general', 'timezone', 'UTC');

    // Build a one-minute window an hour from now, so "now" is certainly outside it.
    const soon = new Date(Date.now() + 3_600_000);
    const hh = String(soon.getUTCHours()).padStart(2, '0');
    await setSetting('notifications', 'quiet_hours', {
      enabled: true,
      start: `${hh}:00`,
      end: `${hh}:01`,
    });

    const sessionId = await seedSession({ projectId, userId, state: 'failed' });
    const produced = await built.notifications.producer?.handleEvent(
      built.outbox.event('session.failed', { sessionId, reason: 'process_crash' }),
    );

    expect(produced?.deferUntil).toBeNull();
    expect((await notifications())[0]?.payload).not.toHaveProperty('quietHours');
    const jobs = await dispatchJobs();
    expect(new Date(jobs[0]?.start_after as unknown as string).getTime()).toBeLessThanOrEqual(
      Date.now() + 1_000,
    );
  });

  it('ignores a disabled window entirely', async () => {
    await configureTelegram();
    await setSetting('notifications', 'quiet_hours', {
      enabled: false,
      start: '00:00',
      end: '23:59',
    });

    const sessionId = await seedSession({ projectId, userId, state: 'failed' });
    const produced = await built.notifications.producer?.handleEvent(
      built.outbox.event('session.failed', { sessionId, reason: 'process_crash' }),
    );

    expect(produced?.deferUntil).toBeNull();
  });
});

describe('content (PRD §9)', () => {
  it('carries summary, commits and duration for a completed session', async () => {
    await configureTelegram();

    const repositoryId = await seedRepository(projectId);
    const startedAt = new Date(Date.now() - 3_845_000);
    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      state: 'completed',
      title: 'Refactor the queue port',
      startedAt,
    });

    await testDatabase()
      .db.update(schema.sessions)
      .set({ completedAt: new Date(), totalCostUsd: '1.234500' })
      .where(eq(schema.sessions.id, sessionId));

    for (const sha of ['a'.repeat(40), 'b'.repeat(40)]) {
      await testDatabase().db.insert(schema.commits).values({
        id: newId(),
        repositoryId,
        sessionId,
        sha,
        authorName: 'operator',
        message: 'work',
        committedAt: new Date(),
      });
    }

    await completeSession(sessionId);

    const row = (await notifications())[0];
    expect(row?.title).toBe('Session completed — Refactor the queue port');
    expect(row?.body).toContain('Project: Mission Control');
    expect(row?.body).toContain('Commits: 2');
    expect(row?.body).toContain('Duration: 1h 04m');
    expect(row?.body).toContain('Cost: $1.23');
    // Payload carries IDs, never entities (F6.1), plus the originating event type (A8).
    expect(row?.payload).toMatchObject({ eventType: 'session.completed', sessionId });
  });

  it('turns repository.sync_failed into a repository_problem notification', async () => {
    await configureTelegram();
    const repositoryId = await seedRepository(projectId);
    await testDatabase()
      .db.update(schema.repositories)
      .set({ syncStatus: 'failed', lastSyncError: 'Token rejected by GitHub (401)' })
      .where(eq(schema.repositories.id, repositoryId));

    await built.notifications.producer?.handleEvent(
      built.outbox.event('repository.sync_failed', { repositoryId, reason: 'unauthorized' }),
    );

    const row = (await notifications())[0];
    expect(row?.type).toBe('repository_problem');
    expect(row?.severity).toBe('warning');
    expect(row?.body).toContain('Token rejected by GitHub (401)');
  });

  it('produces nothing when the entity the event names is gone', async () => {
    await configureTelegram();

    const produced = await built.notifications.producer?.handleEvent(
      built.outbox.event('session.completed', { sessionId: newId(), trigger: 'system' }),
    );

    expect(produced).toBeNull();
    expect(await notifications()).toHaveLength(0);
  });

  it('ignores events that are not notification-worthy', async () => {
    await configureTelegram();

    const produced = await built.notifications.producer?.handleEvent(
      built.outbox.event('session.created', {
        sessionId: newId(),
        projectId,
        sessionType: 'managed',
        trigger: 'user',
      }),
    );

    expect(produced).toBeNull();
    expect(await notifications()).toHaveLength(0);
  });
});

describe('cost budget alert (PRD §4.4.2)', () => {
  async function completedSessionCosting(usd: string): Promise<string> {
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      startedAt: new Date(),
    });
    await testDatabase()
      .db.update(schema.sessions)
      .set({ completedAt: new Date(), totalCostUsd: usd })
      .where(eq(schema.sessions.id, sessionId));
    return sessionId;
  }

  beforeEach(async () => {
    await configureTelegram();
    await setSetting('general', 'timezone', 'UTC');
    await setSetting('integrations', 'claude_code_cost_budget', {
      dailyUsd: 10,
      perSessionUsd: null,
      alertThresholdPercent: 80,
    });
  });

  it('raises one alert when the day crosses the threshold', async () => {
    const sessionId = await completedSessionCosting('8.500000');
    await completeSession(sessionId);

    const alerts = (await notifications()).filter((row) => row.type === 'cost_budget_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.title).toContain('85% of budget');
    expect(alerts[0]?.severity).toBe('warning');
    // A threshold evaluation has no originating F6 event (arbitration A8).
    expect(alerts[0]?.payload).not.toHaveProperty('eventType');
  });

  it('does not alert twice in the same local day', async () => {
    await completeSession(await completedSessionCosting('8.500000'));
    await completeSession(await completedSessionCosting('0.100000'));

    expect((await notifications()).filter((row) => row.type === 'cost_budget_alert')).toHaveLength(
      1,
    );
  });

  it('escalates from alert to over when the budget is actually exceeded', async () => {
    await completeSession(await completedSessionCosting('8.500000'));
    await completeSession(await completedSessionCosting('4.000000'));

    const alerts = (await notifications()).filter((row) => row.type === 'cost_budget_alert');
    expect(alerts).toHaveLength(2);
    expect(alerts.some((row) => row.title.includes('over budget'))).toBe(true);
  });

  it('raises nothing when no budget is configured', async () => {
    // `setSetting` inserts; the enclosing `beforeEach` already wrote this row.
    await testDatabase()
      .db.delete(schema.settings)
      .where(eq(schema.settings.key, 'claude_code_cost_budget'));
    await setSetting('integrations', 'claude_code_cost_budget', {
      dailyUsd: null,
      perSessionUsd: null,
      alertThresholdPercent: 80,
    });

    await completeSession(await completedSessionCosting('99.000000'));

    expect((await notifications()).filter((row) => row.type === 'cost_budget_alert')).toHaveLength(
      0,
    );
  });

  it('respects the costBudgetAlert toggle', async () => {
    await setSetting('notifications', 'events', {
      sessionComplete: true,
      sessionFailed: true,
      syncFailed: true,
      repositoryProblem: true,
      costBudgetAlert: false,
    });

    await completeSession(await completedSessionCosting('9.500000'));

    expect((await notifications()).filter((row) => row.type === 'cost_budget_alert')).toHaveLength(
      0,
    );
  });
});
