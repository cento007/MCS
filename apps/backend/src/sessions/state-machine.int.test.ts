import {
  type EventEnvelope,
  type PgBossQueue,
  QUEUE_NAMES,
  SESSION_STATES,
  type SessionState,
  schema,
} from '@mc/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  seedOperatorRow,
  seedProject,
  seedSession,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { createEventBus, type EventBus, Outbox } from '../events/index.js';
import type { ApiError } from '../http/errors.js';
import { SessionStateMachine } from './state-machine.js';

/**
 * The F7 state machine against a real database (TDS 07 §11.2: "every F7 transition (legal and
 * illegal) unit-tested" — the table itself is covered without a database in
 * `packages/shared/src/entities/session-state.test.ts`; what needs one is everything the
 * machine does *around* the table: the row lock, the `SET state`, the timeline row, the two
 * envelopes, and the lifecycle timestamps).
 */

/** The F7 table, restated independently of the implementation. */
const LEGAL: readonly (readonly [SessionState, SessionState])[] = [
  ['created', 'running'],
  ['created', 'failed'],
  ['running', 'paused'],
  ['running', 'completed'],
  ['running', 'failed'],
  ['paused', 'running'],
  ['paused', 'completed'],
  ['paused', 'failed'],
  ['completed', 'archived'],
  ['failed', 'archived'],
];

const ALL_PAIRS = SESSION_STATES.flatMap((from) => SESSION_STATES.map((to) => [from, to] as const));
const ILLEGAL = ALL_PAIRS.filter(([from, to]) => !LEGAL.some(([f, t]) => f === from && t === to));

let queue: PgBossQueue;
let bus: EventBus;
let outbox: Outbox;
let machine: SessionStateMachine;
let projectId: string;
let userId: string;
let relayed: EventEnvelope[];

async function enqueuedEvents(sessionId: string): Promise<EventEnvelope[]> {
  const result = await testDatabase().db.execute<{ data: EventEnvelope }>(
    sql`SELECT data FROM pgboss.job WHERE name = ${QUEUE_NAMES.EVENTS} ORDER BY created_on, id`,
  );
  return result.rows
    .map((row) => row.data)
    .filter((event) => event.payload['sessionId'] === sessionId);
}

async function timeline(sessionId: string) {
  return testDatabase()
    .db.select()
    .from(schema.sessionEvents)
    .where(eq(schema.sessionEvents.sessionId, sessionId))
    .orderBy(asc(schema.sessionEvents.id));
}

async function sessionRow(id: string) {
  const rows = await testDatabase()
    .db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id));
  return rows[0];
}

function apiError(error: unknown): ApiError {
  return error as ApiError;
}

/** Await a call that must reject and hand back the `ApiError` it rejected with. */
async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    return apiError(error);
  }
  throw new Error('expected the call to reject');
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  bus = createEventBus();
  relayed = [];
  bus.subscribeAll((event) => relayed.push(event));
  outbox = new Outbox({ db: testDatabase().db, queue, bus });
  machine = new SessionStateMachine({ outbox });
  userId = await seedOperatorRow();
  ({ projectId } = await seedProject());
});

describe('every legal F7 transition', () => {
  for (const [from, to] of LEGAL) {
    it(`applies ${from} -> ${to}`, async () => {
      const sessionId = await seedSession({ projectId, userId, state: from });

      const result = await machine.transition({
        sessionId,
        to,
        trigger: 'system',
        action: 'system',
        ...(to === 'failed' ? { reason: 'process_crash' } : {}),
      });

      expect(result.from).toBe(from);
      expect(result.to).toBe(to);
      expect((await sessionRow(sessionId))?.state).toBe(to);
    });
  }
});

describe('illegal transitions are rejected with INVALID_STATE_TRANSITION', () => {
  it('covers all 26 ordered pairs the F7 table omits, including self-transitions', async () => {
    expect(ILLEGAL).toHaveLength(26);

    for (const [from, to] of ILLEGAL) {
      const sessionId = await seedSession({ projectId, userId, state: from });

      const error = await rejection(
        machine.transition({ sessionId, to, trigger: 'user', action: 'system' }),
      );

      expect(error.code, `${from} -> ${to} should have been rejected`).toBe(
        'INVALID_STATE_TRANSITION',
      );
      expect(error.statusCode).toBe(409);
      expect(error.details).toMatchObject({ from, to });
      // Rejected means nothing happened: no state change, no timeline row, no event.
      expect((await sessionRow(sessionId))?.state).toBe(from);
      expect(await timeline(sessionId)).toHaveLength(0);
      expect(await enqueuedEvents(sessionId)).toHaveLength(0);
    }
  });

  it('reports the action that was refused so the client can name it', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'archived' });

    await expect(
      machine.transition({ sessionId, to: 'running', trigger: 'user', action: 'start' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });

    const error = await rejection(
      machine.transition({ sessionId, to: 'running', trigger: 'user', action: 'start' }),
    );
    expect(error.details).toMatchObject({ from: 'archived', action: 'start' });
  });

  it('404s for a Session that does not exist', async () => {
    const error = await rejection(
      machine.transition({
        sessionId: '018f6b2e-0000-7abc-8def-0123456789ab',
        to: 'running',
        trigger: 'user',
        action: 'start',
      }),
    );

    expect(error.code).toBe('NOT_FOUND');
  });
});

describe('observed sessions — actions the type cannot take (WS1 §5.2)', () => {
  for (const action of ['start', 'pause', 'resume'] as const) {
    it(`refuses '${action}' with OPERATION_NOT_SUPPORTED`, async () => {
      const from: SessionState =
        action === 'pause' ? 'running' : action === 'resume' ? 'paused' : 'created';
      const sessionId = await seedSession({
        projectId,
        userId,
        sessionType: 'observed',
        state: from,
      });

      const error = await rejection(
        machine.transition({
          sessionId,
          to: action === 'pause' ? 'paused' : 'running',
          trigger: 'user',
          action,
        }),
      );

      expect(error.code).toBe('OPERATION_NOT_SUPPORTED');
      expect(error.statusCode).toBe(409);
      expect(error.details).toMatchObject({ action, sessionType: 'observed' });
      expect((await sessionRow(sessionId))?.state).toBe(from);
    });
  }

  it("allows 'end' — for an observed Session that means stop observing", async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'running',
    });

    const result = await machine.transition({
      sessionId,
      to: 'completed',
      trigger: 'user',
      action: 'end',
    });

    expect(result.to).toBe('completed');
  });

  it("allows 'archive' — identical to a managed Session", async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'completed',
    });

    await expect(
      machine.transition({ sessionId, to: 'archived', trigger: 'user', action: 'archive' }),
    ).resolves.toMatchObject({ to: 'archived' });
  });

  it('allows the system to confirm an attach — created -> running with trigger system', async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'created',
    });

    await expect(
      machine.transition({ sessionId, to: 'running', trigger: 'system', action: 'system' }),
    ).resolves.toMatchObject({ to: 'running' });
  });
});

describe('one transition is one transaction (TDS 03 §5)', () => {
  it('writes the timeline row with timestamp and trigger', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });
    const at = new Date('2026-08-12T14:03:22.000Z');

    await machine.transition({
      sessionId,
      to: 'paused',
      trigger: 'user',
      action: 'pause',
      at,
    });

    const rows = await timeline(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'session.state_changed',
      fromState: 'running',
      toState: 'paused',
      trigger: 'user',
      correlationId: sessionId,
    });
    expect(rows[0]?.occurredAt.toISOString()).toBe(at.toISOString());
  });

  it('emits session.state_changed plus the specific event, sharing one correlationId', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await machine.transition({
      sessionId,
      to: 'completed',
      trigger: 'user',
      action: 'end',
    });

    const events = await enqueuedEvents(sessionId);
    expect(events.map((event) => event.type)).toEqual([
      'session.state_changed',
      'session.completed',
    ]);
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1);
    expect(events[0]?.payload).toMatchObject({
      fromState: 'running',
      toState: 'completed',
      trigger: 'user',
    });
    expect(events[1]?.payload).toMatchObject({ trigger: 'user' });
  });

  it('names the right specific event for every legal transition', async () => {
    const expected: Record<string, string> = {
      'created->running': 'session.started',
      'paused->running': 'session.resumed',
      'running->paused': 'session.paused',
      'running->completed': 'session.completed',
      'paused->completed': 'session.completed',
      'created->failed': 'session.failed',
      'running->failed': 'session.failed',
      'paused->failed': 'session.failed',
      'completed->archived': 'session.archived',
      'failed->archived': 'session.archived',
    };

    for (const [from, to] of LEGAL) {
      await truncateAll();
      userId = await seedOperatorRow();
      ({ projectId } = await seedProject());
      const sessionId = await seedSession({ projectId, userId, state: from });

      await machine.transition({ sessionId, to, trigger: 'system', action: 'system' });

      const events = await enqueuedEvents(sessionId);
      expect(events.map((event) => event.type)).toEqual([
        'session.state_changed',
        expected[`${from}->${to}`],
      ]);
    }
  });

  it('reports a null resumedFromSessionId on the in-place paused -> running resume', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'paused' });

    await machine.transition({ sessionId, to: 'running', trigger: 'user', action: 'resume' });

    const resumed = (await enqueuedEvents(sessionId)).find(
      (event) => event.type === 'session.resumed',
    );
    expect(resumed?.payload['resumedFromSessionId']).toBeNull();
  });

  it('relays both envelopes in-process after the commit', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    await machine.transition({ sessionId, to: 'running', trigger: 'user', action: 'start' });

    expect(relayed.map((event) => event.type)).toEqual([
      'session.state_changed',
      'session.started',
    ]);
  });
});

describe('lifecycle columns', () => {
  it('sets started_at once and does not rewrite it on an in-place resume', async () => {
    const startedAt = new Date('2026-08-12T10:00:00.000Z');
    const sessionId = await seedSession({ projectId, userId, state: 'paused', startedAt });

    await machine.transition({ sessionId, to: 'running', trigger: 'user', action: 'resume' });

    expect((await sessionRow(sessionId))?.startedAt?.toISOString()).toBe(startedAt.toISOString());
  });

  it('sets started_at on the first launch', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'created' });
    const at = new Date('2026-08-12T14:00:00.000Z');

    await machine.transition({ sessionId, to: 'running', trigger: 'user', action: 'start', at });

    expect((await sessionRow(sessionId))?.startedAt?.toISOString()).toBe(at.toISOString());
  });

  it('sets completed_at on completed AND on failed (TDS 03 §3.9)', async () => {
    const completed = await seedSession({ projectId, userId, state: 'running' });
    const failed = await seedSession({ projectId, userId, state: 'running' });

    await machine.transition({
      sessionId: completed,
      to: 'completed',
      trigger: 'user',
      action: 'end',
    });
    await machine.transition({
      sessionId: failed,
      to: 'failed',
      trigger: 'system',
      action: 'system',
      reason: 'process_crash',
    });

    expect((await sessionRow(completed))?.completedAt).not.toBeNull();
    expect((await sessionRow(failed))?.completedAt).not.toBeNull();
  });

  it('records the failure reason on the row, in the event and on the timeline', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    await machine.transition({
      sessionId,
      to: 'failed',
      trigger: 'system',
      action: 'system',
      reason: 'backend_restart',
    });

    expect((await sessionRow(sessionId))?.failureReason).toBe('backend_restart');
    const failedEvent = (await enqueuedEvents(sessionId)).find(
      (event) => event.type === 'session.failed',
    );
    expect(failedEvent?.payload['reason']).toBe('backend_restart');
    expect((await timeline(sessionId))[0]?.payload).toMatchObject({ reason: 'backend_restart' });
  });

  it('sets archived_at on the terminal transition', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'failed' });

    await machine.transition({ sessionId, to: 'archived', trigger: 'user', action: 'archive' });

    expect((await sessionRow(sessionId))?.archivedAt).not.toBeNull();
  });

  it('writes the runtime facts captured at spawn with the created -> running transition', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    await machine.transition({
      sessionId,
      to: 'running',
      trigger: 'user',
      action: 'start',
      runtime: {
        runtimeSessionId: '2f1a09b7-c001-4d31-9e44-2f1a09b7c001',
        runtimeVersion: '2.0.14',
        model: 'claude-sonnet-4-5',
        machine: 'workstation',
        environment: 'windows-dev',
      },
    });

    const row = await sessionRow(sessionId);
    expect(row?.runtimeSessionId).toBe('2f1a09b7-c001-4d31-9e44-2f1a09b7c001');
    expect(row?.runtimeVersion).toBe('2.0.14');
    expect(row?.machine).toBe('workstation');
  });
});

describe('concurrency', () => {
  it('serializes two simultaneous identical transitions — exactly one wins', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    // Two operators (or two tabs) both press Pause. Without `SELECT … FOR UPDATE` both would
    // read `running`, both would pass the F7 check, and both would write a transition —
    // leaving two timeline rows describing the same event and a doubled event stream.
    const outcomes = await Promise.allSettled([
      machine.transition({ sessionId, to: 'paused', trigger: 'user', action: 'pause' }),
      machine.transition({ sessionId, to: 'paused', trigger: 'user', action: 'pause' }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(apiError((rejected[0] as PromiseRejectedResult).reason).code).toBe(
      'INVALID_STATE_TRANSITION',
    );
    expect(await timeline(sessionId)).toHaveLength(1);
    expect(await enqueuedEvents(sessionId)).toHaveLength(2);
  });

  it('serializes a legal follow-on transition rather than losing it', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'running' });

    // Pause and End raced: the loser of the lock re-reads the *committed* state and finds
    // `paused -> completed` still legal, so both apply, in order, with two timeline rows.
    // That is the correct outcome — serialization, not rejection for its own sake.
    const outcomes = await Promise.allSettled([
      machine.transition({ sessionId, to: 'paused', trigger: 'user', action: 'pause' }),
      machine.transition({ sessionId, to: 'completed', trigger: 'user', action: 'end' }),
    ]);

    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);
    expect((await sessionRow(sessionId))?.state).toBe('completed');
    expect(await timeline(sessionId)).toHaveLength(2);
  });
});
