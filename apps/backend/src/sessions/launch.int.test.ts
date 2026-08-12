import { type EventEnvelope, type PgBossQueue, QUEUE_NAMES, schema } from '@mc/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  seedOperatorRow,
  seedProject,
  seedSession,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { createFakeRuntime, type FakeRuntime } from '../../test/support/fake-runtime.js';

/**
 * Launch at capacity — TDS 04 §6.2.1 / arbitration A2 / WS1 §4.3, and the WS6 §7.1 durable
 * `session.launch` test list.
 *
 * The rule under test is a contract, not an optimization: **saturation is never an error.**
 * `start` and `resume` succeed whenever the F7 transition is otherwise legal; the response says
 * whether the launch happened now or was deferred. There is no 409 for capacity, and while a
 * launch is queued the Session does not move and emits no `session.state_changed`.
 */

let queue: PgBossQueue;
let runtime: FakeRuntime;
let app: TestApp;
let projectId: string;
let userId: string;

async function launchJobs(): Promise<{ id: string; data: { sessionId: string } }[]> {
  const result = await testDatabase().db.execute<{ id: string; data: { sessionId: string } }>(
    sql`SELECT id, data FROM pgboss.job
        WHERE name = ${QUEUE_NAMES.SESSION_LAUNCH}
        ORDER BY created_on, id`,
  );
  return result.rows;
}

async function stateOf(sessionId: string): Promise<string | undefined> {
  const rows = await testDatabase()
    .db.select({ state: schema.sessions.state })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId));
  return rows[0]?.state;
}

async function waitForState(sessionId: string, state: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await stateOf(sessionId)) === state) return;
    if (Date.now() > deadline) {
      throw new Error(
        `session ${sessionId} never reached ${state} (is ${await stateOf(sessionId)})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function relayedFor(sessionId: string, events: EventEnvelope[]): EventEnvelope[] {
  return events.filter((event) => event.payload['sessionId'] === sessionId);
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  runtime = createFakeRuntime();
  userId = await seedOperatorRow();
  ({ projectId } = await seedProject());
});

afterEach(async () => {
  await app?.sessions.registry.stop();
  await app?.app.close();
});

describe('below capacity', () => {
  it('starts immediately and reports launch: started', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 2 });
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    const result = await app.sessions.registry.launch({
      session: (await sessionRow(sessionId)) as never,
      action: 'start',
      requestedBy: userId,
    });

    expect(result).toBe('started');
    expect(await stateOf(sessionId)).toBe('running');
    expect(runtime.launches).toHaveLength(1);
    expect(await launchJobs()).toHaveLength(0);
  });

  it('records the runtime-native session id the runtime issued', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    await app.sessions.registry.launch({
      session: (await sessionRow(sessionId)) as never,
      action: 'start',
      requestedBy: userId,
    });

    const rows = await testDatabase()
      .db.select({ runtimeSessionId: schema.sessions.runtimeSessionId })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    expect(rows[0]?.runtimeSessionId).not.toBeNull();
  });

  it('moves the Session to failed and raises RUNTIME_UNAVAILABLE when the spawn fails', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    runtime.failNextLaunch();
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    await expect(
      app.sessions.registry.launch({
        session: (await sessionRow(sessionId)) as never,
        action: 'start',
        requestedBy: userId,
      }),
    ).rejects.toMatchObject({ code: 'RUNTIME_UNAVAILABLE', statusCode: 503 });

    expect(await stateOf(sessionId)).toBe('failed');
    const rows = await testDatabase()
      .db.select({ failureReason: schema.sessions.failureReason })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId));
    expect(rows[0]?.failureReason).toBe('spawn_error');
    // The failed launch must give its slot back, or the pool leaks one per failure.
    expect(app.sessions.registry.slotsInUse).toBe(0);
  });
});

describe('at capacity — queued, never rejected (§6.2.1)', () => {
  it('enqueues a durable job and leaves the Session where it was', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    const relayed: EventEnvelope[] = [];
    app.bus.subscribeAll((event) => relayed.push(event));

    const occupier = await seedSession({ projectId, userId, state: 'created' });
    const waiting = await seedSession({ projectId, userId, state: 'created' });

    await app.sessions.registry.launch({
      session: (await sessionRow(occupier)) as never,
      action: 'start',
      requestedBy: userId,
    });

    const result = await app.sessions.registry.launch({
      session: (await sessionRow(waiting)) as never,
      action: 'start',
      requestedBy: userId,
    });

    expect(result).toBe('queued');
    // The Session stays in its pre-launch state and no state change is announced.
    expect(await stateOf(waiting)).toBe('created');
    expect(relayedFor(waiting, relayed)).toHaveLength(0);
    expect(runtime.launches).toHaveLength(1);

    const jobs = await launchJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data.sessionId).toBe(waiting);
  });

  it('queues an in-place resume the same way, leaving the Session paused', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });

    const occupier = await seedSession({ projectId, userId, state: 'created' });
    await app.sessions.registry.launch({
      session: (await sessionRow(occupier)) as never,
      action: 'start',
      requestedBy: userId,
    });

    const paused = await seedSession({
      projectId,
      userId,
      state: 'paused',
      runtimeSessionId: 'runtime-1',
    });
    const result = await app.sessions.registry.launch({
      session: (await sessionRow(paused)) as never,
      action: 'resume',
      requestedBy: userId,
    });

    expect(result).toBe('queued');
    expect(await stateOf(paused)).toBe('paused');
    expect((await launchJobs())[0]?.data).toMatchObject({
      sessionId: paused,
      fromState: 'paused',
      action: 'resume',
    });
  });

  it('services the queued launch when a slot frees, and the F7 events fire then', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    await app.sessions.registry.start();

    const occupier = await seedSession({ projectId, userId, state: 'created' });
    const waiting = await seedSession({ projectId, userId, state: 'created' });

    await app.sessions.registry.launch({
      session: (await sessionRow(occupier)) as never,
      action: 'start',
      requestedBy: userId,
    });
    await app.sessions.registry.launch({
      session: (await sessionRow(waiting)) as never,
      action: 'start',
      requestedBy: userId,
    });

    const relayed: EventEnvelope[] = [];
    app.bus.subscribeAll((event) => relayed.push(event));

    // Cold pause frees the slot — the operationally useful meaning of pause under a
    // max-concurrent budget (WS1 §5.1).
    await app.sessions.stateMachine.transition({
      sessionId: occupier,
      to: 'paused',
      trigger: 'user',
      action: 'pause',
    });

    await waitForState(waiting, 'running');

    const types = relayedFor(waiting, relayed).map((event) => event.type);
    expect(types).toEqual(['session.state_changed', 'session.started']);
  });

  it('services queued launches in enqueue order', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    await app.sessions.registry.start();

    const occupier = await seedSession({ projectId, userId, state: 'created' });
    await app.sessions.registry.launch({
      session: (await sessionRow(occupier)) as never,
      action: 'start',
      requestedBy: userId,
    });

    const queued: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const sessionId = await seedSession({ projectId, userId, state: 'created' });
      queued.push(sessionId);
      await app.sessions.registry.launch({
        session: (await sessionRow(sessionId)) as never,
        action: 'start',
        requestedBy: userId,
      });
    }

    expect((await launchJobs()).map((job) => job.data.sessionId)).toEqual(queued);

    // Free one slot at a time and watch them go in order.
    await app.sessions.stateMachine.transition({
      sessionId: occupier,
      to: 'completed',
      trigger: 'user',
      action: 'end',
    });
    await waitForState(queued[0] as string, 'running');
    expect(await stateOf(queued[1] as string)).toBe('created');

    await app.sessions.stateMachine.transition({
      sessionId: queued[0] as string,
      to: 'completed',
      trigger: 'user',
      action: 'end',
    });
    await waitForState(queued[1] as string, 'running');

    await app.sessions.stateMachine.transition({
      sessionId: queued[1] as string,
      to: 'completed',
      trigger: 'user',
      action: 'end',
    });
    await waitForState(queued[2] as string, 'running');
  });

  it('survives a Backend restart — the job outlives the process that enqueued it', async () => {
    const first = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });

    const occupier = await seedSession({ projectId, userId, state: 'created' });
    const waiting = await seedSession({ projectId, userId, state: 'created' });

    await first.sessions.registry.launch({
      session: (await sessionRow(occupier)) as never,
      action: 'start',
      requestedBy: userId,
    });
    await first.sessions.registry.launch({
      session: (await sessionRow(waiting)) as never,
      action: 'start',
      requestedBy: userId,
    });

    await first.sessions.registry.stop();
    await first.app.close();

    expect(await launchJobs()).toHaveLength(1);

    // A fresh Backend with an empty slot pool: the durable job is picked up and serviced.
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    await app.sessions.registry.start();

    await waitForState(waiting, 'running');
  });
});

describe('shutdown', () => {
  it('stops promptly with a launch parked on a slot that will never free', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    await app.sessions.registry.start();

    const occupier = await seedSession({ projectId, userId, state: 'created' });
    const waiting = await seedSession({ projectId, userId, state: 'created' });

    await app.sessions.registry.launch({
      session: (await sessionRow(occupier)) as never,
      action: 'start',
      requestedBy: userId,
    });
    await app.sessions.registry.launch({
      session: (await sessionRow(waiting)) as never,
      action: 'start',
      requestedBy: userId,
    });

    // Let the consumer pick the job up and park on the semaphore.
    await waitForJobState(waiting, 'active');

    // pg-boss's `offWork` waits for the in-flight handler, so without the shutdown abort this
    // would hang on a consumer behaving exactly as designed.
    const stopped = await Promise.race([
      app.sessions.registry.stop().then(() => 'stopped' as const),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 10_000)),
    ]);

    expect(stopped).toBe('stopped');
    // The launch was not consumed: it is queued again for the next boot.
    expect(await stateOf(waiting)).toBe('created');
  });
});

describe('idempotent consumption of a launch job (F6.3)', () => {
  it('no-ops when the Session has already moved on', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });

    const sessionId = await seedSession({ projectId, userId, state: 'created' });
    await app.sessions.registry.launch({
      session: (await sessionRow(sessionId)) as never,
      action: 'start',
      requestedBy: userId,
    });
    expect(await stateOf(sessionId)).toBe('running');
    const launchesAfterStart = runtime.launches.length;

    // A stale job for a Session that is already `running`: enqueued by hand, exactly as a
    // redelivery after a mid-flight crash would look.
    await enqueueStaleLaunch(sessionId);
    await app.sessions.registry.start();

    await waitForJobsDrained();
    expect(runtime.launches).toHaveLength(launchesAfterStart);
    expect(await stateOf(sessionId)).toBe('running');
  });

  it('no-ops for a Session that no longer exists', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    await enqueueStaleLaunch('018f6b2e-0000-7abc-8def-0123456789ab');
    await app.sessions.registry.start();

    await waitForJobsDrained();
    expect(runtime.launches).toHaveLength(0);
  });

  it('does not retry a queued launch whose spawn failed — the Session is already failed', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });
    await app.sessions.registry.start();

    const occupier = await seedSession({ projectId, userId, state: 'created' });
    const waiting = await seedSession({ projectId, userId, state: 'created' });

    await app.sessions.registry.launch({
      session: (await sessionRow(occupier)) as never,
      action: 'start',
      requestedBy: userId,
    });
    await app.sessions.registry.launch({
      session: (await sessionRow(waiting)) as never,
      action: 'start',
      requestedBy: userId,
    });

    runtime.failAllLaunches(true);
    await app.sessions.stateMachine.transition({
      sessionId: occupier,
      to: 'paused',
      trigger: 'user',
      action: 'pause',
    });

    // §6.2.1: for a queued launch the failure arrives as an event, not as an HTTP response.
    await waitForState(waiting, 'failed');
    await waitForJobsDrained();
    expect(app.sessions.registry.slotsInUse).toBe(0);
  });
});

describe('maxConcurrentSessions is live-editable (WS1 §4.3)', () => {
  it('growing the limit lets a new launch through without touching running Sessions', async () => {
    app = createTestApp({ queue, runtime, maxConcurrentSessions: 1 });

    const first = await seedSession({ projectId, userId, state: 'created' });
    const second = await seedSession({ projectId, userId, state: 'created' });

    await app.sessions.registry.launch({
      session: (await sessionRow(first)) as never,
      action: 'start',
      requestedBy: userId,
    });
    expect(
      await app.sessions.registry.launch({
        session: (await sessionRow(second)) as never,
        action: 'start',
        requestedBy: userId,
      }),
    ).toBe('queued');

    app.sessions.registry.setMaxConcurrentSessions(2);

    const third = await seedSession({ projectId, userId, state: 'created' });
    expect(
      await app.sessions.registry.launch({
        session: (await sessionRow(third)) as never,
        action: 'start',
        requestedBy: userId,
      }),
    ).toBe('started');
    expect(await stateOf(first)).toBe('running');
  });
});

async function sessionRow(id: string) {
  const rows = await testDatabase()
    .db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id));
  return rows[0];
}

/** Enqueue a `session.launch` job by hand — the shape a redelivery presents to the consumer. */
async function enqueueStaleLaunch(sessionId: string): Promise<void> {
  const { createJob } = await import('@mc/shared');
  await testDatabase().db.transaction(async (tx) => {
    await queue.enqueueJob(
      tx,
      QUEUE_NAMES.SESSION_LAUNCH,
      createJob({
        sessionId,
        fromState: 'created',
        action: 'start',
        requestedAt: new Date().toISOString(),
        requestedBy: userId,
      }),
    );
  });
}

/** Wait until the queued launch for `sessionId` reaches a given pg-boss job state. */
async function waitForJobState(
  sessionId: string,
  state: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await testDatabase().db.execute<{ state: string }>(
      sql`SELECT state FROM pgboss.job
          WHERE name = ${QUEUE_NAMES.SESSION_LAUNCH} AND data->>'sessionId' = ${sessionId}`,
    );
    if (rows.rows.some((row) => row.state === state)) return;
    if (Date.now() > deadline) throw new Error(`launch job never reached ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitForJobsDrained(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = await testDatabase().db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM pgboss.job
          WHERE name = ${QUEUE_NAMES.SESSION_LAUNCH} AND state < 'completed'`,
    );
    if (remaining.rows[0]?.count === '0') return;
    if (Date.now() > deadline) throw new Error('launch jobs never drained');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
