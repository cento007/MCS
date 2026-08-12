import { type PgBossQueue, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../../test/integration/harness.js';
import {
  createMockAgentRuntime,
  type MockAgentRuntime,
} from '../../../test/support/mock-agent-runtime.js';
import { happySingleTurn } from '../../../test/support/runtime-scripts.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import { BACKEND_RESTART_REASON, recoverManagedSessions } from './recovery.js';

/**
 * Restart recovery (TDS 02 §4.4) and the recovery path it exists to enable (§6.3 resume-as-new
 * from `failed`) — WS6 §5.2.1's matrix, against a real database.
 *
 * The two halves are one story and are tested as one: marking orphans `failed` is only useful
 * because Resume can carry the conversation into a new Session, and Resume from `failed` is only
 * reachable because recovery put it there.
 */

let queue: PgBossQueue;
let agent: MockAgentRuntime;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let projectId: string;
let userId: string;

async function request(
  method: 'GET' | 'POST',
  url: string,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({ method, url, headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
}

async function stateOf(id: string): Promise<string | undefined> {
  const rows = await testDatabase()
    .db.select({ state: schema.sessions.state, reason: schema.sessions.failureReason })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id));
  return rows[0]?.state;
}

async function reasonOf(id: string): Promise<string | null | undefined> {
  const rows = await testDatabase()
    .db.select({ reason: schema.sessions.failureReason })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id));
  return rows[0]?.reason;
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  agent = createMockAgentRuntime(happySingleTurn);

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());

  built = createTestApp({ queue, agentRuntime: agent, cookieSecure: false });
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

describe('recoverManagedSessions (WS1 §4.4)', () => {
  it('fails managed Sessions left running by a crash, with reason backend_restart', async () => {
    const orphan = await seedSession({
      projectId,
      userId,
      state: 'running',
      runtimeSessionId: 'runtime-orphan-1',
    });

    const report = await recoverManagedSessions({
      db: testDatabase().db,
      stateMachine: built.sessions.stateMachine,
    });

    expect(report.orphaned).toEqual([orphan]);
    expect(report.failed).toEqual([orphan]);
    expect(await stateOf(orphan)).toBe('failed');
    expect(await reasonOf(orphan)).toBe(BACKEND_RESTART_REASON);

    // F7: the transition is recorded on the timeline as a system action, with the reason.
    const events = await testDatabase()
      .db.select()
      .from(schema.sessionEvents)
      .where(eq(schema.sessionEvents.sessionId, orphan));
    const transition = events.find((event) => event.type === 'session.state_changed');
    expect(transition?.trigger).toBe('system');
    expect(transition?.fromState).toBe('running');
    expect(transition?.toState).toBe('failed');
    expect(transition?.payload?.['reason']).toBe(BACKEND_RESTART_REASON);
    expect(events.some((event) => event.type === 'session.failed')).toBe(false);
  });

  it('never invokes the runtime — recovery does not respawn', async () => {
    await seedSession({ projectId, userId, state: 'running' });

    await recoverManagedSessions({
      db: testDatabase().db,
      stateMachine: built.sessions.stateMachine,
    });

    expect(agent.launches).toEqual([]);
  });

  it('leaves paused Sessions untouched — cold pause is durable by design (§5.1)', async () => {
    const paused = await seedSession({
      projectId,
      userId,
      state: 'paused',
      runtimeSessionId: 'runtime-paused-1',
    });

    await recoverManagedSessions({
      db: testDatabase().db,
      stateMachine: built.sessions.stateMachine,
    });

    expect(await stateOf(paused)).toBe('paused');

    // …and it is still resumable in place, on the same row, by runtime-native id.
    const resumed = await request('POST', `/api/v1/sessions/${paused}/resume`);
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json<{ data: { id: string; state: string } }>().data).toMatchObject({
      id: paused,
      state: 'running',
    });
    expect(agent.launches[0]?.resume).toBe('runtime-paused-1');
  });

  it('leaves every other state alone, including observed sessions that are running', async () => {
    const created = await seedSession({ projectId, userId, state: 'created' });
    const completed = await seedSession({ projectId, userId, state: 'completed' });
    const failed = await seedSession({ projectId, userId, state: 'failed' });
    const observed = await seedSession({
      projectId,
      userId,
      state: 'running',
      sessionType: 'observed',
      runtimeSessionId: 'external-1',
    });

    const report = await recoverManagedSessions({
      db: testDatabase().db,
      stateMachine: built.sessions.stateMachine,
    });

    expect(report.orphaned).toEqual([]);
    expect(await stateOf(created)).toBe('created');
    expect(await stateOf(completed)).toBe('completed');
    expect(await stateOf(failed)).toBe('failed');
    // Mission Control does not own that process; it may well still be running (§5.2).
    expect(await stateOf(observed)).toBe('running');
  });

  it('keeps going when one Session cannot be transitioned', async () => {
    const orphan = await seedSession({ projectId, userId, state: 'running' });
    const errors: string[] = [];

    // A Session the state machine will refuse: deleted between the scan and the transition is
    // the real-world shape of this, and NOT_FOUND is what it raises.
    const report = await recoverManagedSessions({
      db: testDatabase().db,
      stateMachine: {
        transition: async (registerRequest) => {
          errors.push(registerRequest.sessionId);
          throw new Error('gone');
        },
      },
      onError: (_error, sessionId) => errors.push(`error:${sessionId}`),
    });

    expect(report.orphaned).toEqual([orphan]);
    expect(report.failed).toEqual([]);
    expect(errors).toEqual([orphan, `error:${orphan}`]);
  });
});

describe('resume-as-new from failed (§6.3, corrected 2026-08-12)', () => {
  it('creates a NEW linked Session that resumes the failed one’s runtime conversation', async () => {
    // Exactly the state restart recovery leaves behind.
    const failed = await seedSession({
      projectId,
      userId,
      state: 'running',
      runtimeSessionId: 'runtime-orphan-2',
    });
    await recoverManagedSessions({
      db: testDatabase().db,
      stateMachine: built.sessions.stateMachine,
    });
    expect(await stateOf(failed)).toBe('failed');

    const response = await request('POST', `/api/v1/sessions/${failed}/resume`);

    // 201 and a new record: F7 states never move backward, so recovery cannot un-fail a Session
    // — it can only carry its conversation forward.
    expect(response.statusCode).toBe(201);
    const created = response.json<{
      data: { id: string; state: string; resumedFromSessionId: string | null };
    }>().data;
    expect(created.id).not.toBe(failed);
    expect(created.state).toBe('created');
    expect(created.resumedFromSessionId).toBe(failed);

    // The failed Session is untouched — the record of what happened survives.
    expect(await stateOf(failed)).toBe('failed');
    expect(await reasonOf(failed)).toBe(BACKEND_RESTART_REASON);

    // And starting the new Session resumes the runtime-native conversation of the old one,
    // which is the whole reason resume-from-failed had to be legal (WS1 §4.4).
    await request('POST', `/api/v1/sessions/${created.id}/start`);
    expect(agent.launches).toHaveLength(1);
    expect(agent.launches[0]?.resume).toBe('runtime-orphan-2');
    expect(agent.launches[0]?.fork).toBe(false);
  });

  it('still refuses resume from created or running', async () => {
    for (const state of ['created', 'running'] as const) {
      const id = await seedSession({ projectId, userId, state });
      const response = await request('POST', `/api/v1/sessions/${id}/resume`);
      expect(response.statusCode, state).toBe(409);
    }
  });
});
