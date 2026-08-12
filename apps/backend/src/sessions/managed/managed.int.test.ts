import { type PgBossQueue, QUEUE_NAMES, schema } from '@mc/shared';
import { asc, eq, sql } from 'drizzle-orm';
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
  testWorkingDirectory,
  truncateAll,
} from '../../../test/integration/harness.js';
import { createFakeDeltaSink, type FakeDeltaSink } from '../../../test/support/managed-doubles.js';
import {
  createMockAgentRuntime,
  type MockAgentRuntime,
  type ScriptStep,
} from '../../../test/support/mock-agent-runtime.js';
import {
  happyMultiTurn,
  happySingleTurn,
  interruptedTurn,
  midStreamCrash,
  rateLimitStop,
  spawnFailure,
  toolUseTurn,
} from '../../../test/support/runtime-scripts.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

/**
 * The managed wrapper end to end — real Fastify app, real state machine, real
 * `MessageService`, real pg-boss, and the WS6 §5.2 mock runtime in place of `claude`.
 *
 * These are the tests that prove the *contract* rather than the class: what the database and the
 * API look like after a turn, after an interrupt, after a pause, and after a rate limit.
 */

let queue: PgBossQueue;
let agent: MockAgentRuntime;
let deltas: FakeDeltaSink;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let projectId: string;
let userId: string;
let workingDirectory: string;

async function request(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({
    method,
    url,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function startSession(script: readonly ScriptStep[]): Promise<string> {
  agent.script(script);
  const created = await request('POST', '/api/v1/sessions', { projectId, workingDirectory });
  const id = created.json<{ data: { id: string } }>().data.id;
  await request('POST', `/api/v1/sessions/${id}/start`);
  return id;
}

async function sessionRow(id: string) {
  const rows = await testDatabase()
    .db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.id, id));
  return rows[0];
}

async function messagesOf(id: string) {
  return testDatabase()
    .db.select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, id))
    .orderBy(asc(schema.messages.ordinal));
}

async function waitFor(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  agent = createMockAgentRuntime(happySingleTurn);
  deltas = createFakeDeltaSink();

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());
  workingDirectory = testWorkingDirectory();

  built = createTestApp({
    queue,
    agentRuntime: agent,
    cookieSecure: false,
    maxConcurrentSessions: 1,
  });
  app = built.app;
  // The slot-release listener and the launch consumer (`main.ts` does this at boot). Without it
  // a slot is held for the life of the process, so every capacity assertion below needs it.
  await built.sessions.registry.start();
  // `app.ts` attaches the hub here; re-attaching a recorder is how this tier observes the
  // ephemeral stream without standing up a browser socket (the hub's own relay is covered by
  // `ws/hub.test.ts`, and the controller's publish by `controller.test.ts`).
  built.sessions.managed?.deltas.attach(deltas);

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

describe('launch (F7 "system confirms spawn")', () => {
  it('records the runtime-native session id and the runtime facts on the Session row', async () => {
    const id = await startSession(happySingleTurn);

    const row = await sessionRow(id);
    expect(row?.state).toBe('running');
    expect(row?.runtimeSessionId).toBe('5f6c0b98-2a5b-4a1e-8c1a-7c9e8a1b2c3d');
    expect(row?.runtimeVersion).toBe('2.1.228');
    expect(row?.model).toBe('claude-sonnet-4-5');
    expect(row?.machine).not.toBeNull();
    // A first launch resumes nothing (F1.5): `resume` is for an in-place resume, a
    // resume-as-new, or a Clone.
    expect(agent.launches[0]?.resume).toBeNull();
    expect(agent.launches[0]?.fork).toBe(false);
    expect(agent.launches[0]?.workingDirectory).toBe(workingDirectory);
  });

  it('forks the parent conversation when the Session is a Clone (F1.5 forkSession)', async () => {
    const parent = await startSession(happySingleTurn);
    const cloned = await request('POST', `/api/v1/sessions/${parent}/clone`);
    const clone = cloned.json<{ data: { id: string } }>().data;

    await request('POST', `/api/v1/sessions/${parent}/pause`);
    await request('POST', `/api/v1/sessions/${clone.id}/start`);

    // Resume *and* fork: the clone continues the parent's runtime conversation on a branch.
    expect(agent.launches.at(-1)?.resume).toBe('5f6c0b98-2a5b-4a1e-8c1a-7c9e8a1b2c3d');
    expect(agent.launches.at(-1)?.fork).toBe(true);
  });

  it('fails the Session with 503 when the runtime cannot spawn (§6.3)', async () => {
    agent.script(spawnFailure);
    const created = await request('POST', '/api/v1/sessions', { projectId, workingDirectory });
    const id = created.json<{ data: { id: string } }>().data.id;

    const response = await request('POST', `/api/v1/sessions/${id}/start`);

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('RUNTIME_UNAVAILABLE');
    const row = await sessionRow(id);
    expect(row?.state).toBe('failed');
    expect(row?.failureReason).toBe('spawn_error');
  });
});

describe('prompts (§6.4)', () => {
  it('answers 202, persists the user Message pending, then flips it to complete', async () => {
    const id = await startSession(happyMultiTurn);

    const response = await request('POST', `/api/v1/sessions/${id}/prompts`, {
      content: 'Refactor the queue consumer, please',
    });

    expect(response.statusCode).toBe(202);
    const messageId = response.json<{ data: { messageId: string } }>().data.messageId;

    await waitFor(async () => (await messagesOf(id)).length >= 2, 'assistant message');
    const messages = await messagesOf(id);

    const user = messages.find((message) => message.id === messageId);
    expect(user?.role).toBe('user');
    // The runtime took it, so the pending prompt is complete (§6.4).
    expect(user?.status).toBe('complete');
    expect(user?.ordinal).toBe(0);

    const assistant = messages.find((message) => message.role === 'assistant');
    expect(assistant?.content).toBe('Refactoring the queue consumer');
    expect(assistant?.status).toBe('complete');
    expect(assistant?.runtimeMessageId).toBe('uuid-assistant-1');
    // Conversation order is the per-session ordinal and nothing else (A5).
    expect(assistant?.ordinal).toBe(1);

    // A13: the Session was named from the first user Message, in that same transaction.
    expect((await sessionRow(id))?.title).toBe('Refactor the queue consumer, please');
    // The ephemeral stream reached the relay the hub is attached to.
    expect(deltas.text()).toBe('Refactoring the queue consumer');
  });

  it('accumulates cost and usage from the result onto the Session (F1.5)', async () => {
    const id = await startSession(happyMultiTurn);

    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'first' });
    await waitFor(async () => (await sessionRow(id))?.totalCostUsd !== null, 'first result');
    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'second' });
    await waitFor(async () => (await sessionRow(id))?.numTurns === 2, 'second result');

    const row = await sessionRow(id);
    // The running total, read rather than summed.
    expect(Number(row?.totalCostUsd)).toBeCloseTo(0.031, 6);
    expect(row?.usage?.input_tokens).toBe(2400);
    expect(row?.numTurns).toBe(2);

    // …and the API projection of it (§6.1).
    const fetched = await request('GET', `/api/v1/sessions/${id}`);
    const body = fetched.json<{
      data: { costUsd: number; tokenUsage: { input: number; cacheRead: number } };
    }>().data;
    expect(body.costUsd).toBeCloseTo(0.031, 6);
    expect(body.tokenUsage.input).toBe(2400);
    expect(body.tokenUsage.cacheRead).toBe(1600);
  });

  it('persists a tool Message per call and per result, with the §6.10.2 file path', async () => {
    const id = await startSession(toolUseTurn);

    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'read it' });
    await waitFor(
      async () => (await messagesOf(id)).filter((message) => message.role === 'tool').length === 2,
      'tool messages',
    );

    const tools = (await messagesOf(id)).filter((message) => message.role === 'tool');
    expect(tools[0]?.toolName).toBe('Read');
    expect(tools[0]?.toolFilePath).toBe('/repo/src/queue.ts');
    expect(tools[1]?.content).toBe('export const queue = 1;');

    // The Files read model is built from exactly that column (§6.10.2).
    const files = await request('GET', `/api/v1/sessions/${id}/files`);
    const model = files.json<{ data: { files: { path: string; toolTouchCount: number }[] } }>()
      .data;
    expect(model.files).toHaveLength(1);
    expect(model.files[0]?.toolTouchCount).toBe(1);
  });

  it('rejects a prompt to a session that is not running (§6.4)', async () => {
    const id = await seedSession({ projectId, userId, state: 'created' });

    const response = await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'hi' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('SESSION_NOT_RUNNING');
  });

  it('rejects a prompt to an observed session (§6.4)', async () => {
    const id = await seedSession({
      projectId,
      userId,
      state: 'running',
      sessionType: 'observed',
    });

    const response = await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'hi' });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('OPERATION_NOT_SUPPORTED');
  });

  it('rejects a prompt beyond the 256 KiB ceiling with 413', async () => {
    const id = await startSession(happySingleTurn);

    const response = await request('POST', `/api/v1/sessions/${id}/prompts`, {
      content: 'x'.repeat(256 * 1024 + 64),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('interrupt (§6.3.1)', () => {
  it('stops the turn, retains the partial Message, and changes no state', async () => {
    const id = await startSession(interruptedTurn);
    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'Start the refactor' });
    await waitFor(async () => deltas.deltas.length === 2, 'deltas');

    const eventsBefore = await stateChangeCount(id);
    const response = await request('POST', `/api/v1/sessions/${id}/interrupt`);

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: { sessionId: string; messageId: string | null } }>().data;
    expect(body.sessionId).toBe(id);

    const partial = (await messagesOf(id)).find((message) => message.id === body.messageId);
    expect(partial?.role).toBe('assistant');
    expect(partial?.status).toBe('interrupted');
    expect(partial?.content).toBe('Starting the refactor');

    // The two things §6.3.1 insists on.
    expect((await sessionRow(id))?.state).toBe('running');
    expect(await stateChangeCount(id)).toBe(eventsBefore);
  });

  it('refuses with NO_TURN_IN_FLIGHT when nothing is streaming', async () => {
    const id = await startSession(happySingleTurn);

    const response = await request('POST', `/api/v1/sessions/${id}/interrupt`);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NO_TURN_IN_FLIGHT');
  });
});

describe('cold pause and in-place resume (TDS 02 §5.1)', () => {
  it('releases the concurrency slot on pause and re-attaches on the same row at resume', async () => {
    const id = await startSession(happySingleTurn);
    expect(built.sessions.registry.slotsInUse).toBe(1);

    const paused = await request('POST', `/api/v1/sessions/${id}/pause`);
    expect(paused.statusCode).toBe(200);

    // The point of cold pause: a paused Session holds no capacity (§4.3/§5.1).
    await waitFor(async () => built.sessions.registry.slotsInUse === 0, 'slot release');
    expect(agent.sessions[0]?.closes).toBeGreaterThanOrEqual(1);

    const resumed = await request('POST', `/api/v1/sessions/${id}/resume`);

    expect(resumed.statusCode).toBe(200);
    const body = resumed.json<{ data: { id: string; state: string } }>().data;
    // Same record, same id — F7's "resume creates a new Session" applies to completed/archived.
    expect(body.id).toBe(id);
    expect(body.state).toBe('running');
    // …and it re-attaches by runtime-native id rather than starting a fresh conversation.
    expect(agent.launches).toHaveLength(2);
    expect(agent.launches[1]?.resume).toBe('5f6c0b98-2a5b-4a1e-8c1a-7c9e8a1b2c3d');
  });

  it('keeps the accumulated cost across a pause, because a resumed query restarts its own', async () => {
    const id = await startSession(happyMultiTurn);
    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'first' });
    await waitFor(async () => (await sessionRow(id))?.totalCostUsd !== null, 'first result');

    await request('POST', `/api/v1/sessions/${id}/pause`);
    await request('POST', `/api/v1/sessions/${id}/resume`);
    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'after resume' });
    await waitFor(
      async () => Number((await sessionRow(id))?.totalCostUsd) > 0.0125,
      'post-resume result',
    );

    // 0.0125 before the pause + 0.0125 from the resumed query's own first result.
    expect(Number((await sessionRow(id))?.totalCostUsd)).toBeCloseTo(0.025, 6);
  });
});

describe('failure and backoff', () => {
  it('fails the Session when the stream dies mid-turn', async () => {
    const id = await startSession(midStreamCrash);

    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'go' });
    await waitFor(async () => (await sessionRow(id))?.state === 'failed', 'crash transition');

    const row = await sessionRow(id);
    expect(row?.failureReason).toBe('process_crash');
    // The slot follows the state change out of `running` (§4.3).
    await waitFor(async () => built.sessions.registry.slotsInUse === 0, 'slot release');
  });

  it('backs a rate-limited turn off as a delayed job and leaves the Session running', async () => {
    const id = await startSession(rateLimitStop);
    const before = await stateChangeCount(id);

    await request('POST', `/api/v1/sessions/${id}/prompts`, { content: 'expensive work' });
    await waitFor(async () => (await retryJobs()).length === 1, 'retry job');

    const [job] = await retryJobs();
    expect(job?.name).toBe(QUEUE_NAMES.SESSION_PROMPT_RETRY);
    expect(job?.data.sessionId).toBe(id);
    expect(job?.data.content).toBe('expensive work');
    expect(job?.data.attempt).toBe(1);
    // Delayed, not immediate — that is what "backoff" means durably (§4.3).
    expect(job?.delayed).toBe(true);

    // WS1 §4.3, asserted as bluntly as it is written: the turn failed, the session did not.
    expect((await sessionRow(id))?.state).toBe('running');
    expect(await stateChangeCount(id)).toBe(before);
    // Cost accrued before the limit is still recorded.
    expect(Number((await sessionRow(id))?.totalCostUsd)).toBeCloseTo(0.004, 6);
  });
});

async function stateChangeCount(sessionId: string): Promise<number> {
  const rows = await testDatabase()
    .db.select({ type: schema.sessionEvents.type })
    .from(schema.sessionEvents)
    .where(eq(schema.sessionEvents.sessionId, sessionId));
  return rows.filter((row) => row.type === 'session.state_changed').length;
}

async function retryJobs(): Promise<
  {
    name: string;
    data: { sessionId: string; content: string; attempt: number };
    delayed: boolean;
  }[]
> {
  const result = await testDatabase().db.execute<{
    name: string;
    data: { sessionId: string; content: string; attempt: number };
    delayed: boolean;
  }>(sql`SELECT name, data, start_after > now() AS delayed
         FROM pgboss.job WHERE name = ${QUEUE_NAMES.SESSION_PROMPT_RETRY}`);
  return result.rows;
}
