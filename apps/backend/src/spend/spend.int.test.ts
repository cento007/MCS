import { newId, type PgBossQueue, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedUser,
  setSetting,
  type TestApp,
  testDatabase,
  testQueue,
  testWorkingDirectory,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { readSpendAggregate } from './aggregate.js';
import type { SpendResource } from './index.js';

/**
 * `GET /api/v1/spend` end to end (TDS 04 §7.8).
 *
 * The hard part of this endpoint is not the sum, it is **which day the sum belongs to**. A
 * Backend running UTC while the operator is in `Europe/Amsterdam` would roll "today" at 01:00
 * or 02:00 local, so the Dashboard would read `$0.00` for the first two hours of every
 * evening's work. These tests therefore lean on zones whose local midnight is nowhere near
 * `00:00Z`, and pin the DST arithmetic at fixed instants.
 */

let queue: PgBossQueue;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let projectId: string;
let userId: string;

async function readSpend(): Promise<SpendResource> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/spend',
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });

  expect(response.statusCode).toBe(200);
  return response.json<{ data: SpendResource }>().data;
}

/** A Session row with a chosen `started_at` and cost — the only two columns this endpoint reads. */
async function seedCostedSession(input: {
  startedAt: Date | null;
  costUsd: number | null;
  state?: string;
  sessionType?: 'managed' | 'observed';
  createdAt?: Date;
  completedAt?: Date;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.sessions)
    .values({
      id,
      projectId,
      userId,
      sessionType: input.sessionType ?? 'managed',
      state: input.state ?? 'completed',
      workingDir: testWorkingDirectory(),
      ...(input.startedAt === null ? {} : { startedAt: input.startedAt }),
      ...(input.costUsd === null ? {} : { totalCostUsd: input.costUsd.toFixed(6) }),
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
    });
  return id;
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
    const response = await app.inject({ method: 'GET', url: '/api/v1/spend' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('returns `{ data }` with no `meta` — a fixed read model, not a list (§1.2)', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/spend',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(Object.keys(response.json<Record<string, unknown>>())).toEqual(['data']);
  });

  it('reports zero — not an empty body — when nothing has run', async () => {
    const spend = await readSpend();

    expect(spend.day.totalCostUsd).toBe(0);
    expect(spend.day.sessionCount).toBe(0);
    expect(spend.month.totalCostUsd).toBe(0);
    expect(spend.dayStatus).toBe('no_budget');
  });
});

describe('period semantics — the instance timezone, never UTC-by-accident', () => {
  it('cuts the day at local midnight in general.timezone, not at 00:00Z', async () => {
    // UTC+14, no DST: local midnight is 10:00Z the previous day. Nothing about this boundary
    // can be reached by accident from a server running UTC.
    await setSetting('general', 'timezone', 'Pacific/Kiritimati');

    const spend = await readSpend();

    expect(spend.timezone).toBe('Pacific/Kiritimati');
    const start = new Date(spend.day.periodStart);
    const end = new Date(spend.day.periodEnd);
    expect(start.getUTCHours()).toBe(10);
    expect(start.getUTCMinutes()).toBe(0);
    expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('echoes the bounds as UTC instants so no client recomputes a boundary', async () => {
    await setSetting('general', 'timezone', 'Asia/Tokyo');

    const spend = await readSpend();

    expect(spend.day.periodStart).toMatch(/Z$/);
    expect(spend.day.periodEnd).toMatch(/Z$/);
    // UTC+9 -> local midnight is 15:00Z.
    expect(new Date(spend.day.periodStart).getUTCHours()).toBe(15);
  });

  it('falls back to UTC — and says UTC — when the zone is unset or unparseable', async () => {
    const unset = await readSpend();
    expect(unset.timezone).toBe('UTC');
    expect(new Date(unset.day.periodStart).getUTCHours()).toBe(0);

    await setSetting('general', 'timezone', 'Mars/Olympus');
    const nonsense = await readSpend();
    expect(nonsense.timezone).toBe('UTC');
    expect(new Date(nonsense.day.periodStart).getUTCHours()).toBe(0);
  });

  it('buckets a session on the correct side of a local midnight that is not UTC midnight', async () => {
    await setSetting('general', 'timezone', 'Pacific/Kiritimati');
    const bounds = await readSpend();
    const dayStart = new Date(bounds.day.periodStart).getTime();
    const dayEnd = new Date(bounds.day.periodEnd).getTime();

    // One minute before local midnight: yesterday's money, even though it is the same UTC day.
    await seedCostedSession({ startedAt: new Date(dayStart - 60_000), costUsd: 5 });
    // One minute after: today's.
    await seedCostedSession({ startedAt: new Date(dayStart + 60_000), costUsd: 2 });
    // The last minute of the local day is still today (periodEnd is exclusive).
    await seedCostedSession({ startedAt: new Date(dayEnd - 60_000), costUsd: 1 });
    // Exactly periodEnd is tomorrow.
    await seedCostedSession({ startedAt: new Date(dayEnd), costUsd: 9 });

    const spend = await readSpend();

    expect(spend.day.totalCostUsd).toBe(3);
    expect(spend.day.sessionCount).toBe(2);
  });

  it('includes the exact periodStart instant and excludes the exact periodEnd instant', async () => {
    const bounds = await readSpend();

    await seedCostedSession({ startedAt: new Date(bounds.day.periodStart), costUsd: 0.5 });
    await seedCostedSession({ startedAt: new Date(bounds.day.periodEnd), costUsd: 0.5 });

    expect((await readSpend()).day.totalCostUsd).toBe(0.5);
  });
});

describe('DST correctness — the bounds are computed on the local timestamp', () => {
  /**
   * These run the aggregate directly at a fixed instant. The endpoint always uses SQL `now()`
   * (§7.8); the seam exists because a 25-hour day happens on one specific Sunday a year, and
   * asserting it beats asserting that the SQL was typed correctly.
   */
  const HOUR = 60 * 60 * 1000;

  it('yields a 25-hour day when the clocks go back (America/New_York, 2026-11-01)', async () => {
    const aggregate = await readSpendAggregate(testDatabase().db, 'America/New_York', {
      at: new Date('2026-11-01T12:00:00.000Z'),
    });

    // EDT (UTC-4) local midnight -> 04:00Z; EST (UTC-5) next midnight -> 05:00Z.
    expect(aggregate.day.periodStart.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(aggregate.day.periodEnd.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(aggregate.day.periodEnd.getTime() - aggregate.day.periodStart.getTime()).toBe(25 * HOUR);
  });

  it('yields a 23-hour day when the clocks go forward (America/New_York, 2026-03-08)', async () => {
    const aggregate = await readSpendAggregate(testDatabase().db, 'America/New_York', {
      at: new Date('2026-03-08T12:00:00.000Z'),
    });

    expect(aggregate.day.periodStart.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(aggregate.day.periodEnd.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(aggregate.day.periodEnd.getTime() - aggregate.day.periodStart.getTime()).toBe(23 * HOUR);
  });

  it('carries the same correction into the month bounds', async () => {
    const aggregate = await readSpendAggregate(testDatabase().db, 'America/New_York', {
      at: new Date('2026-11-15T12:00:00.000Z'),
    });

    expect(aggregate.month.periodStart.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(aggregate.month.periodEnd.toISOString()).toBe('2026-12-01T05:00:00.000Z');
    // 30 calendar days across one fall-back transition is 721 hours, not 720.
    expect(aggregate.month.periodEnd.getTime() - aggregate.month.periodStart.getTime()).toBe(
      721 * HOUR,
    );
  });

  it('buckets a session inside the repeated hour on the day it actually started', async () => {
    // 01:30 EDT on the fall-back Sunday — an hour that occurs twice in local time.
    await seedCostedSession({ startedAt: new Date('2026-11-01T05:30:00.000Z'), costUsd: 1.25 });

    const aggregate = await readSpendAggregate(testDatabase().db, 'America/New_York', {
      at: new Date('2026-11-01T12:00:00.000Z'),
    });

    expect(aggregate.day.totalCostUsd).toBe(1.25);
    expect(aggregate.day.sessionCount).toBe(1);
  });
});

describe('attribution — cost lands on the day the Session started (§7.8)', () => {
  it('buckets on started_at, not created_at', async () => {
    const bounds = await readSpend();
    const dayStart = new Date(bounds.day.periodStart).getTime();

    // Created yesterday, started today: today's money.
    await seedCostedSession({
      createdAt: new Date(dayStart - 6 * 60 * 60 * 1000),
      startedAt: new Date(dayStart + 60_000),
      costUsd: 3,
    });
    // Created today, started yesterday: yesterday's money.
    await seedCostedSession({
      createdAt: new Date(dayStart + 60_000),
      startedAt: new Date(dayStart - 60_000),
      costUsd: 7,
    });

    expect((await readSpend()).day.totalCostUsd).toBe(3);
  });

  it('buckets on started_at, not completed_at — a long session counts from the start', async () => {
    const bounds = await readSpend();
    const dayStart = new Date(bounds.day.periodStart).getTime();

    // Started before local midnight, finished after it: the whole cost stays on the start day,
    // so the widget cannot read $0.00 while a session burns the budget overnight.
    await seedCostedSession({
      startedAt: new Date(dayStart - 30 * 60_000),
      completedAt: new Date(dayStart + 30 * 60_000),
      costUsd: 4.5,
    });

    const spend = await readSpend();
    expect(spend.day.totalCostUsd).toBe(0);
  });

  it('counts every state, failed and archived included', async () => {
    const bounds = await readSpend();
    const startedAt = new Date(new Date(bounds.day.periodStart).getTime() + 60_000);

    await seedCostedSession({ startedAt, costUsd: 1, state: 'completed' });
    await seedCostedSession({ startedAt, costUsd: 2, state: 'failed' });
    await seedCostedSession({ startedAt, costUsd: 4, state: 'archived' });
    await seedCostedSession({ startedAt, costUsd: 8, state: 'running' });

    const spend = await readSpend();
    expect(spend.day.totalCostUsd).toBe(15);
    expect(spend.day.sessionCount).toBe(4);
  });

  it('ignores a Session that never started — nothing ran, so nothing was spent', async () => {
    await seedCostedSession({ startedAt: null, costUsd: 99, state: 'created' });

    const spend = await readSpend();
    expect(spend.day.totalCostUsd).toBe(0);
    expect(spend.month.sessionCount).toBe(0);
  });

  it('lets observed Sessions contribute 0 without counting them (WS5 footnote)', async () => {
    const bounds = await readSpend();
    const startedAt = new Date(new Date(bounds.day.periodStart).getTime() + 60_000);

    await seedCostedSession({ startedAt, costUsd: 2.5 });
    await seedCostedSession({
      startedAt,
      costUsd: null,
      sessionType: 'observed',
      state: 'running',
    });

    const spend = await readSpend();
    expect(spend.day.totalCostUsd).toBe(2.5);
    // Only the Session that actually produced a number is counted.
    expect(spend.day.sessionCount).toBe(1);
  });

  it('reads the same rows for the month, day included', async () => {
    const bounds = await readSpend();
    const dayStart = new Date(bounds.day.periodStart).getTime();
    const monthStart = new Date(bounds.month.periodStart).getTime();

    await seedCostedSession({ startedAt: new Date(dayStart + 60_000), costUsd: 1 });
    if (monthStart < dayStart) {
      await seedCostedSession({ startedAt: new Date(monthStart + 60_000), costUsd: 2 });
      const spend = await readSpend();
      expect(spend.day.totalCostUsd).toBe(1);
      expect(spend.month.totalCostUsd).toBe(3);
    } else {
      // The test is running on the first of the month: day and month share a start.
      const spend = await readSpend();
      expect(spend.month.totalCostUsd).toBe(spend.day.totalCostUsd);
    }
  });

  it('sums numeric exactly — money is numeric(12,6), never float', async () => {
    const bounds = await readSpend();
    const startedAt = new Date(new Date(bounds.day.periodStart).getTime() + 60_000);

    await seedCostedSession({ startedAt, costUsd: 0.1 });
    await seedCostedSession({ startedAt, costUsd: 0.2 });

    expect((await readSpend()).day.totalCostUsd).toBe(0.3);
  });
});

describe('budget and dayStatus', () => {
  async function spendToday(amount: number): Promise<void> {
    const bounds = await readSpend();
    await seedCostedSession({
      startedAt: new Date(new Date(bounds.day.periodStart).getTime() + 60_000),
      costUsd: amount,
    });
  }

  it('reports no_budget and still returns the numbers when no budget is configured', async () => {
    await spendToday(3.42);

    const spend = await readSpend();
    expect(spend.budget.dailyUsd).toBeNull();
    expect(spend.dayStatus).toBe('no_budget');
    expect(spend.day.totalCostUsd).toBe(3.42);
  });

  it('reads the budget from the one JSONB row (§7.6 rule 1) and crosses ok -> alert -> over', async () => {
    await setSetting('integrations', 'claude_code_cost_budget', {
      dailyUsd: 10,
      perSessionUsd: 2,
      alertThresholdPercent: 80,
    });

    await spendToday(3.42);
    let spend = await readSpend();
    expect(spend.budget).toEqual({
      dailyUsd: 10,
      perSessionUsd: 2,
      alertThresholdPercent: 80,
      alertsEnabled: true,
    });
    expect(spend.dayStatus).toBe('ok');

    await spendToday(5);
    spend = await readSpend();
    expect(spend.day.totalCostUsd).toBe(8.42);
    expect(spend.dayStatus).toBe('alert');

    await spendToday(2);
    spend = await readSpend();
    expect(spend.dayStatus).toBe('over');
  });

  it('reports alertsEnabled from notifications.events.costBudgetAlert, and still returns spend', async () => {
    await setSetting('notifications', 'events', { costBudgetAlert: false });
    await setSetting('integrations', 'claude_code_cost_budget', { dailyUsd: 10 });
    await spendToday(1);

    const spend = await readSpend();
    expect(spend.budget.alertsEnabled).toBe(false);
    expect(spend.day.totalCostUsd).toBe(1);
  });
});

describe('no caching (§7.8)', () => {
  it('reflects a Session that just completed, on the very next read', async () => {
    const first = await readSpend();
    expect(first.day.totalCostUsd).toBe(0);

    await seedCostedSession({
      startedAt: new Date(new Date(first.day.periodStart).getTime() + 60_000),
      costUsd: 0.75,
    });

    // No TTL sits between a completed Session and the number the operator is watching.
    expect((await readSpend()).day.totalCostUsd).toBe(0.75);
  });

  it('reflects a budget change immediately', async () => {
    await setSetting('integrations', 'claude_code_cost_budget', { dailyUsd: 10 });
    expect((await readSpend()).budget.dailyUsd).toBe(10);

    await testDatabase()
      .db.update(schema.settings)
      .set({ value: { dailyUsd: 25 } })
      .where(eq(schema.settings.key, 'claude_code_cost_budget'));

    expect((await readSpend()).budget.dailyUsd).toBe(25);
  });
});
