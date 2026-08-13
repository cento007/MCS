import { newId, type PgBossQueue, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedRepository,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  testWorkingDirectory,
  truncateAll,
} from '../../test/integration/harness.js';
import { createFakeRuntime, type FakeRuntime } from '../../test/support/fake-runtime.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { MessageService } from './messages.js';

/**
 * `/api/v1/sessions/*` end to end — TDS 04 §6, through the real Fastify app, the real state
 * machine and a real database. WS6 §11.2 makes this obligatory: "every WS2 Phase-1 endpoint has
 * integration coverage (happy + error envelope + auth)".
 */

let queue: PgBossQueue;
let runtime: FakeRuntime;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let projectId: string;
let userId: string;
let workingDirectory: string;

interface SessionBody {
  id: string;
  projectId: string;
  repositoryId: string | null;
  sessionType: string;
  state: string;
  title: string;
  notes: string | null;
  workingDirectory: string;
  runtime: { kind: string; runtimeSessionId: string | null };
  observation: { channel: string; degraded: boolean } | null;
  resumedFromSessionId: string | null;
  clonedFromSessionId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  archivedAt: string | null;
}

type InjectedResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function request(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createSession(
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: SessionBody }> {
  const response = await request('POST', '/api/v1/sessions', {
    projectId,
    workingDirectory,
    ...overrides,
  });
  return { status: response.statusCode, body: response.json<{ data: SessionBody }>().data };
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  runtime = createFakeRuntime();

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());
  workingDirectory = testWorkingDirectory();

  built = createTestApp({ queue, runtime, cookieSecure: false, maxConcurrentSessions: 2 });
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

describe('auth (TDS 04 §1.4 — authenticated by default)', () => {
  it('rejects every session route without a credential', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/sessions'],
      ['POST', '/api/v1/sessions'],
      ['GET', `/api/v1/sessions/${newId()}`],
      ['POST', `/api/v1/sessions/${newId()}/start`],
      ['GET', `/api/v1/sessions/${newId()}/messages`],
      ['GET', `/api/v1/sessions/${newId()}/files`],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('POST /sessions (§6.2)', () => {
  it('creates a managed Session in state created and emits session.created', async () => {
    const relayed: string[] = [];
    built.bus.subscribeAll((event) => relayed.push(event.type));

    const { status, body } = await createSession({ title: '  Nightly refactor  ', branch: 'DEV' });

    expect(status).toBe(201);
    expect(body.state).toBe('created');
    expect(body.sessionType).toBe('managed');
    expect(body.title).toBe('Nightly refactor');
    expect(body.runtime.runtimeSessionId).toBeNull();
    expect(body.observation).toBeNull();
    expect(relayed).toEqual(['session.created']);
  });

  it('normalizes a blank title to unset, serialized as the empty string (§6.1/§6.11.3)', async () => {
    const { body } = await createSession({ title: '   ' });

    expect(body.title).toBe('');
    const rows = await testDatabase()
      .db.select({ title: schema.sessions.title })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, body.id));
    expect(rows[0]?.title).toBeNull();
  });

  it('validates the body against the §16 schema', async () => {
    const response = await request('POST', '/api/v1/sessions', { projectId });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a relative or missing working directory (F8.1 path rules, §6.2)', async () => {
    const relative = await request('POST', '/api/v1/sessions', {
      projectId,
      workingDirectory: 'apps/backend',
    });
    expect(relative.statusCode).toBe(400);
    expect(relative.json<{ error: { details: { field: string } } }>().error.details.field).toBe(
      'workingDirectory',
    );

    const missing = await request('POST', '/api/v1/sessions', {
      projectId,
      workingDirectory: `${workingDirectory}-does-not-exist`,
    });
    expect(missing.statusCode).toBe(400);
  });

  it('rejects an unknown projectId', async () => {
    const response = await request('POST', '/api/v1/sessions', {
      projectId: newId(),
      workingDirectory,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { details: { field: string } } }>().error.details.field).toBe(
      'projectId',
    );
  });

  it('writes an audit row for the user action (TDS 03 §3.14)', async () => {
    const { body } = await createSession();

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, body.id));
    expect(rows.map((row) => row.action)).toContain('session.created');
    expect(rows[0]?.actorType).toBe('user');
    expect(rows[0]?.actorId).toBe(userId);
  });
});

describe('GET /sessions (§6.2)', () => {
  it('returns newest first with the F5.3 list envelope', async () => {
    const first = await createSession();
    const second = await createSession();

    const response = await request('GET', '/api/v1/sessions');
    const body = response.json<{
      data: SessionBody[];
      meta: { nextCursor: null; limit: number };
    }>();

    expect(response.statusCode).toBe(200);
    expect(body.data.map((row) => row.id)).toEqual([second.body.id, first.body.id]);
    expect(body.meta).toEqual({ nextCursor: null, limit: 50 });
  });

  it('paginates with an opaque cursor', async () => {
    await createSession();
    await createSession();
    await createSession();

    const page = await request('GET', '/api/v1/sessions?limit=2');
    const first = page.json<{ data: SessionBody[]; meta: { nextCursor: string } }>();
    expect(first.data).toHaveLength(2);
    expect(first.meta.nextCursor).not.toBeNull();

    const next = await request(
      'GET',
      `/api/v1/sessions?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
    );
    const second = next.json<{ data: SessionBody[]; meta: { nextCursor: null } }>();
    expect(second.data).toHaveLength(1);
    expect(second.meta.nextCursor).toBeNull();
  });

  it('rejects an unparseable cursor with INVALID_CURSOR', async () => {
    const response = await request('GET', '/api/v1/sessions?cursor=%%%');
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_CURSOR');
  });

  it('filters on state, sessionType, projectId and repositoryId — and nothing else (N16)', async () => {
    const repositoryId = await seedRepository(projectId);
    const managed = await createSession({ repositoryId });
    const observed = await seedSession({ projectId, userId, sessionType: 'observed' });
    const other = await seedProject('Other');
    await seedSession({ projectId: other.projectId, userId });

    const byType = await request('GET', '/api/v1/sessions?sessionType=observed');
    expect(byType.json<{ data: SessionBody[] }>().data.map((row) => row.id)).toEqual([observed]);

    const byRepository = await request('GET', `/api/v1/sessions?repositoryId=${repositoryId}`);
    expect(byRepository.json<{ data: SessionBody[] }>().data.map((row) => row.id)).toEqual([
      managed.body.id,
    ]);

    const byProject = await request('GET', `/api/v1/sessions?projectId=${other.projectId}`);
    expect(byProject.json<{ data: SessionBody[] }>().data).toHaveLength(1);

    const byState = await request('GET', '/api/v1/sessions?state=created');
    expect(byState.json<{ data: SessionBody[] }>().data.length).toBeGreaterThan(0);

    // `?since=` is deliberately absent in V1 (§6.2, resolving WS7 N16): the Needs Attention
    // widget filters the first page client-side.
    //
    // It is now **rejected by name** rather than silently stripped. This assertion used to
    // read the other way round — "Fastify strips unknown query params, so the observable
    // contract is that the parameter has no effect" — which was a description of Ajv's
    // `removeAdditional: true`, not a contract anyone chose: a caller filtering to "sessions
    // since Tuesday" got every Session ever and a `200` saying that was the answer. See
    // `http/query-strictness.ts`.
    const rejected = await request('GET', '/api/v1/sessions?since=2026-08-12T00:00:00Z');
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { unknownParameters: ['since'] },
    });
  });
});

describe('GET / PATCH /sessions/{id} (§6.2, §6.11.4)', () => {
  it('fetches one Session and 404s for an unknown id', async () => {
    const { body } = await createSession();

    expect((await request('GET', `/api/v1/sessions/${body.id}`)).statusCode).toBe(200);

    const missing = await request('GET', `/api/v1/sessions/${newId()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json<{ error: { code: string; requestId: string } }>().error.code).toBe(
      'NOT_FOUND',
    );
  });

  it('overrides the title, and clearing it stores NULL', async () => {
    const { body } = await createSession({ title: 'Original' });

    const renamed = await request('PATCH', `/api/v1/sessions/${body.id}`, { title: 'Renamed' });
    expect(renamed.json<{ data: SessionBody }>().data.title).toBe('Renamed');

    const cleared = await request('PATCH', `/api/v1/sessions/${body.id}`, { title: null });
    expect(cleared.json<{ data: SessionBody }>().data.title).toBe('');
  });

  it('is legal in every state including archived — renaming is not a lifecycle action', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'archived' });

    const response = await request('PATCH', `/api/v1/sessions/${sessionId}`, {
      title: 'Renamed after archiving',
      notes: 'Kept for the post-mortem',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: SessionBody }>().data.title).toBe('Renamed after archiving');
    expect(response.json<{ data: SessionBody }>().data.state).toBe('archived');
  });

  it('emits no event and writes no timeline row for a rename (§6.11.6)', async () => {
    const { body } = await createSession();
    const relayed: string[] = [];
    built.bus.subscribeAll((event) => relayed.push(event.type));

    await request('PATCH', `/api/v1/sessions/${body.id}`, { title: 'Renamed' });

    expect(relayed).toEqual([]);
    const timeline = await testDatabase()
      .db.select()
      .from(schema.sessionEvents)
      .where(eq(schema.sessionEvents.sessionId, body.id));
    expect(timeline.map((row) => row.type)).toEqual(['session.created']);
  });
});

describe('lifecycle sub-actions (§6.3)', () => {
  it('start returns meta.launch and moves the Session to running', async () => {
    const { body } = await createSession();

    const response = await request('POST', `/api/v1/sessions/${body.id}/start`);
    const payload = response.json<{ data: SessionBody; meta: { launch: string } }>();

    expect(response.statusCode).toBe(200);
    expect(payload.meta.launch).toBe('started');
    expect(payload.data.state).toBe('running');
    expect(payload.data.startedAt).not.toBeNull();
    expect(payload.data.runtime.runtimeSessionId).not.toBeNull();
  });

  it('start on a Session that is not `created` is INVALID_STATE_TRANSITION', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'paused' });

    const response = await request('POST', `/api/v1/sessions/${sessionId}/start`);

    expect(response.statusCode).toBe(409);
    const error = response.json<{ error: { code: string; details: { from: string } } }>().error;
    expect(error.code).toBe('INVALID_STATE_TRANSITION');
    expect(error.details.from).toBe('paused');
  });

  it('pause disposes the runtime and records running -> paused', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);

    const response = await request('POST', `/api/v1/sessions/${body.id}/pause`);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: SessionBody }>().data.state).toBe('paused');
    // Cold pause: no process survives it (WS1 §5.1).
    expect(runtime.disposals).toContainEqual({ sessionId: body.id, reason: 'paused' });
  });

  it('end completes the Session and archive follows', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);

    const ended = await request('POST', `/api/v1/sessions/${body.id}/end`);
    expect(ended.json<{ data: SessionBody }>().data.state).toBe('completed');
    expect(ended.json<{ data: SessionBody }>().data.completedAt).not.toBeNull();

    const archived = await request('POST', `/api/v1/sessions/${body.id}/archive`);
    expect(archived.json<{ data: SessionBody }>().data.state).toBe('archived');
    expect(archived.json<{ data: SessionBody }>().data.archivedAt).not.toBeNull();

    // `archived` is terminal.
    expect((await request('POST', `/api/v1/sessions/${body.id}/archive`)).statusCode).toBe(409);
  });

  it('reports a spawn failure as 503 with the Session left failed', async () => {
    runtime.failNextLaunch();
    const { body } = await createSession();

    const response = await request('POST', `/api/v1/sessions/${body.id}/start`);

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('RUNTIME_UNAVAILABLE');
    const after = await request('GET', `/api/v1/sessions/${body.id}`);
    expect(after.json<{ data: SessionBody }>().data.state).toBe('failed');
  });

  it('never 409s on capacity — it queues (§6.2.1)', async () => {
    built.sessions.registry.setMaxConcurrentSessions(1);
    const first = await createSession();
    const second = await createSession();

    await request('POST', `/api/v1/sessions/${first.body.id}/start`);
    const response = await request('POST', `/api/v1/sessions/${second.body.id}/start`);
    const payload = response.json<{ data: SessionBody; meta: { launch: string } }>();

    expect(response.statusCode).toBe(200);
    expect(payload.meta.launch).toBe('queued');
    expect(payload.data.state).toBe('created');
  });
});

describe('observed sessions refuse actions their type cannot take (§6.3, WS1 §5.2)', () => {
  it('OPERATION_NOT_SUPPORTED for start, pause, resume and interrupt', async () => {
    const created = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'created',
    });
    const running = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'running',
    });
    const paused = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'paused',
    });

    for (const [sessionId, action] of [
      [created, 'start'],
      [running, 'pause'],
      [paused, 'resume'],
      [running, 'interrupt'],
    ] as const) {
      const response = await request('POST', `/api/v1/sessions/${sessionId}/${action}`);
      expect(response.statusCode, action).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code, action).toBe(
        'OPERATION_NOT_SUPPORTED',
      );
    }
  });

  it('allows end (stop observing) and archive', async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'running',
    });

    const ended = await request('POST', `/api/v1/sessions/${sessionId}/end`);
    expect(ended.statusCode).toBe(200);
    expect(ended.json<{ data: SessionBody }>().data.state).toBe('completed');

    expect((await request('POST', `/api/v1/sessions/${sessionId}/archive`)).statusCode).toBe(200);
  });

  it('exposes the observation read model for an observed Session (§6.9)', async () => {
    const sessionId = await seedSession({ projectId, userId, sessionType: 'observed' });
    await testDatabase().db.insert(schema.transcriptTailStates).values({
      id: newId(),
      sessionId,
      transcriptPath: '/tmp/session.jsonl',
      degraded: true,
      driftCount: 7,
      lastError: 'unknown line type',
    });

    const response = await request('GET', `/api/v1/sessions/${sessionId}`);
    const observation = response.json<{ data: SessionBody }>().data.observation;

    expect(observation).toMatchObject({ channel: 'hooks_only', degraded: true });
  });
});

describe('resume — one path, two operations (§6.3)', () => {
  it('resumes in place from paused: same row, 200, meta.launch', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);
    await request('POST', `/api/v1/sessions/${body.id}/pause`);

    const response = await request('POST', `/api/v1/sessions/${body.id}/resume`);
    const payload = response.json<{ data: SessionBody; meta: { launch: string } }>();

    expect(response.statusCode).toBe(200);
    expect(payload.meta.launch).toBe('started');
    expect(payload.data.id).toBe(body.id);
    expect(payload.data.state).toBe('running');
    // Lineage is untouched by an in-place resume (TDS 03 §3.9).
    expect(payload.data.resumedFromSessionId).toBeNull();
  });

  it('creates a NEW Session from completed: 201, linked by resumedFromSessionId', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);
    await request('POST', `/api/v1/sessions/${body.id}/end`);

    const response = await request('POST', `/api/v1/sessions/${body.id}/resume`);
    const resumed = response.json<{ data: SessionBody }>().data;

    expect(response.statusCode).toBe(201);
    expect(resumed.id).not.toBe(body.id);
    expect(resumed.state).toBe('created');
    expect(resumed.resumedFromSessionId).toBe(body.id);
    expect(resumed.clonedFromSessionId).toBeNull();
    // The runtime issues a fresh native id for the resumed conversation (TDS 03 §3.9).
    expect(resumed.runtime.runtimeSessionId).toBeNull();
    // States never move backward: the parent is untouched.
    const parent = await request('GET', `/api/v1/sessions/${body.id}`);
    expect(parent.json<{ data: SessionBody }>().data.state).toBe('completed');
  });

  it('creates a NEW Session from archived too', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'archived' });

    const response = await request('POST', `/api/v1/sessions/${sessionId}/resume`);

    expect(response.statusCode).toBe(201);
    expect(response.json<{ data: SessionBody }>().data.resumedFromSessionId).toBe(sessionId);
  });

  it('resumes the parent runtime session when the new Session starts', async () => {
    const parent = await seedSession({
      projectId,
      userId,
      state: 'completed',
      runtimeSessionId: 'parent-runtime-id',
    });

    const created = (await request('POST', `/api/v1/sessions/${parent}/resume`)).json<{
      data: SessionBody;
    }>().data;
    await request('POST', `/api/v1/sessions/${created.id}/start`);

    expect(runtime.launches.at(-1)?.resumeFromRuntimeSessionId).toBe('parent-runtime-id');
    expect(runtime.launches.at(-1)?.fork).toBe(false);
  });

  // §6.3's "Legal from" for resume-as-new is `completed`, `failed`, `archived` (the `failed` row
  // was added 2026-08-12); `created` and `running` remain the only illegal sources — a Session
  // that has not run yet has nothing to resume, and one that is running is already there.
  it('rejects resume from created or running', async () => {
    for (const state of ['created', 'running'] as const) {
      const sessionId = await seedSession({ projectId, userId, state });
      const response = await request('POST', `/api/v1/sessions/${sessionId}/resume`);

      expect(response.statusCode, state).toBe(409);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        'INVALID_STATE_TRANSITION',
      );
    }
  });
});

describe('clone (§6.3)', () => {
  it('creates a new Session in created, linked by clonedFromSessionId', async () => {
    const source = await seedSession({
      projectId,
      userId,
      state: 'running',
      runtimeSessionId: 'source-runtime-id',
    });

    const response = await request('POST', `/api/v1/sessions/${source}/clone`, {
      title: 'Fork of the refactor',
    });
    const cloned = response.json<{ data: SessionBody }>().data;

    expect(response.statusCode).toBe(201);
    expect(cloned.state).toBe('created');
    expect(cloned.clonedFromSessionId).toBe(source);
    expect(cloned.resumedFromSessionId).toBeNull();
    expect(cloned.title).toBe('Fork of the refactor');
  });

  it('asks the runtime to fork at start (F1.5 forkSession)', async () => {
    const source = await seedSession({
      projectId,
      userId,
      state: 'completed',
      runtimeSessionId: 'source-runtime-id',
    });
    const cloned = (await request('POST', `/api/v1/sessions/${source}/clone`)).json<{
      data: SessionBody;
    }>().data;

    await request('POST', `/api/v1/sessions/${cloned.id}/start`);

    expect(runtime.launches.at(-1)?.fork).toBe(true);
    expect(runtime.launches.at(-1)?.resumeFromRuntimeSessionId).toBe('source-runtime-id');
  });

  it('refuses to clone an archived Session', async () => {
    const source = await seedSession({
      projectId,
      userId,
      state: 'archived',
      runtimeSessionId: 'source-runtime-id',
    });

    const response = await request('POST', `/api/v1/sessions/${source}/clone`);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('refuses to clone a Session that has never had a runtime session', async () => {
    const { body } = await createSession();

    const response = await request('POST', `/api/v1/sessions/${body.id}/clone`);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
  });
});

describe('interrupt (§6.3.1) — no state transition', () => {
  it('stops the turn, leaves the Session running and emits no session.state_changed', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);
    runtime.setTurnInFlight(body.id, true);
    runtime.setInterruptMessageId('018f6b2e-7777-7abc-8def-0123456789ab');

    const relayed: string[] = [];
    built.bus.subscribeAll((event) => relayed.push(event.type));

    const response = await request('POST', `/api/v1/sessions/${body.id}/interrupt`);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { sessionId: string; messageId: string } }>().data).toEqual({
      sessionId: body.id,
      messageId: '018f6b2e-7777-7abc-8def-0123456789ab',
    });
    expect(relayed).toEqual([]);

    const after = await request('GET', `/api/v1/sessions/${body.id}`);
    expect(after.json<{ data: SessionBody }>().data.state).toBe('running');
  });

  it('reports a null messageId when the turn produced no persisted content', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);
    runtime.setTurnInFlight(body.id, true);

    const response = await request('POST', `/api/v1/sessions/${body.id}/interrupt`);
    expect(response.json<{ data: { messageId: string | null } }>().data.messageId).toBeNull();
  });

  it('SESSION_NOT_RUNNING when the Session is not running', async () => {
    const { body } = await createSession();

    const response = await request('POST', `/api/v1/sessions/${body.id}/interrupt`);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('SESSION_NOT_RUNNING');
  });

  it('NO_TURN_IN_FLIGHT when nothing is streaming', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);

    const response = await request('POST', `/api/v1/sessions/${body.id}/interrupt`);
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NO_TURN_IN_FLIGHT');
  });
});

describe('nested reads', () => {
  it('lists messages in ordinal order with an ordinal-keyed cursor (§6.6)', async () => {
    const { body } = await createSession();
    const messages = new MessageService({ outbox: built.outbox });

    for (const content of ['first', 'second', 'third']) {
      await messages.append({ sessionId: body.id, role: 'user', content });
    }

    const page = await request('GET', `/api/v1/sessions/${body.id}/messages?limit=2`);
    const first = page.json<{
      data: { ordinal: number; content: { type: string; text: string }[] }[];
      meta: { nextCursor: string };
    }>();

    expect(first.data.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(first.data[0]?.content).toEqual([{ type: 'text', text: 'first' }]);

    const next = await request(
      'GET',
      `/api/v1/sessions/${body.id}/messages?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor)}`,
    );
    expect(next.json<{ data: { ordinal: number }[] }>().data.map((row) => row.ordinal)).toEqual([
      2,
    ]);
  });

  it('filters messages by role and status', async () => {
    const { body } = await createSession();
    const messages = new MessageService({ outbox: built.outbox });

    await messages.append({
      sessionId: body.id,
      role: 'user',
      content: 'prompt',
      status: 'pending',
    });
    await messages.append({ sessionId: body.id, role: 'assistant', content: 'reply' });

    const byRole = await request('GET', `/api/v1/sessions/${body.id}/messages?role=assistant`);
    expect(byRole.json<{ data: { role: string }[] }>().data.map((row) => row.role)).toEqual([
      'assistant',
    ]);

    const byStatus = await request('GET', `/api/v1/sessions/${body.id}/messages?status=pending`);
    expect(byStatus.json<{ data: { status: string }[] }>().data.map((row) => row.status)).toEqual([
      'pending',
    ]);
  });

  it('reads the timeline from session_events with the §6.7 kind projection', async () => {
    const { body } = await createSession();
    await request('POST', `/api/v1/sessions/${body.id}/start`);
    await request('POST', `/api/v1/sessions/${body.id}/pause`);

    const response = await request('GET', `/api/v1/sessions/${body.id}/timeline`);
    const entries = response.json<{
      data: { type: string; kind: string; trigger: string; fromState?: string }[];
    }>().data;

    expect(entries.map((entry) => entry.type)).toEqual([
      'session.created',
      'session.state_changed',
      'session.state_changed',
    ]);
    expect(entries[1]).toMatchObject({
      kind: 'state_changed',
      trigger: 'user',
      toState: 'running',
    });
    expect(entries[2]).toMatchObject({ kind: 'state_changed', fromState: 'running' });
  });

  it('lists the Session commits newest first, without files[] (§6.10.1)', async () => {
    const repositoryId = await seedRepository(projectId);
    const sessionId = await seedSession({ projectId, userId, repositoryId });

    await testDatabase()
      .db.insert(schema.commits)
      .values([
        {
          id: newId(),
          repositoryId,
          sessionId,
          sha: 'a'.repeat(40),
          authorName: 'operator',
          message: 'older',
          committedAt: new Date('2026-08-11T10:00:00.000Z'),
          files: [{ path: 'src/app.ts', status: 'modified', additions: 4, deletions: 1 }],
        },
        {
          id: newId(),
          repositoryId,
          sessionId,
          sha: 'b'.repeat(40),
          authorName: 'operator',
          message: 'newer',
          committedAt: new Date('2026-08-12T10:00:00.000Z'),
          files: [],
        },
      ]);

    const response = await request('GET', `/api/v1/sessions/${sessionId}/commits`);
    const commits = response.json<{
      data: { message: string; filesChanged: number; additions: number }[];
    }>().data;

    expect(commits.map((commit) => commit.message)).toEqual(['newer', 'older']);
    expect(commits[1]).toMatchObject({ filesChanged: 1, additions: 4, deletions: 1 });
    expect(commits[0]).not.toHaveProperty('files');
  });

  it('returns the Files read model with no meta and honest completeness (§6.10.2)', async () => {
    const repositoryId = await seedRepository(projectId, { localPath: workingDirectory });
    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      workingDir: workingDirectory,
    });

    await testDatabase()
      .db.insert(schema.commits)
      .values({
        id: newId(),
        repositoryId,
        sessionId,
        sha: 'c'.repeat(40),
        authorName: 'operator',
        message: 'change',
        committedAt: new Date('2026-08-12T10:00:00.000Z'),
        files: [{ path: 'src/app.ts', status: 'modified', additions: 4, deletions: 1 }],
      });

    const messages = new MessageService({ outbox: built.outbox });
    await messages.append({
      sessionId,
      role: 'tool',
      content: '',
      toolName: 'Read',
      toolFilePath: `${workingDirectory}${process.platform === 'win32' ? '\\' : '/'}src${process.platform === 'win32' ? '\\' : '/'}app.ts`,
    });

    const response = await request('GET', `/api/v1/sessions/${sessionId}/files`);
    const data = response.json<{
      data: {
        root: string;
        files: { path: string; touchCount: number; sources: string[] }[];
        totalFiles: number;
        truncated: boolean;
        completeness: string;
        completenessReason: string | null;
      };
      meta?: unknown;
    }>();

    expect(data.meta).toBeUndefined();
    expect(data.data.root).toBe(workingDirectory);
    // Both sources collapse onto one root-relative path: the whole point of §6.10.2.
    expect(data.data.files).toHaveLength(1);
    expect(data.data.files[0]).toMatchObject({
      path: 'src/app.ts',
      touchCount: 2,
      sources: ['tool', 'commit'],
    });
    expect(data.data.totalFiles).toBe(1);
    expect(data.data.truncated).toBe(false);
    expect(data.data.completeness).toBe('complete');
    expect(data.data.completenessReason).toBeNull();
  });

  it('reports partial completeness for a degraded observed Session (§6.10.2)', async () => {
    const sessionId = await seedSession({ projectId, userId, sessionType: 'observed' });
    await testDatabase().db.insert(schema.transcriptTailStates).values({
      id: newId(),
      sessionId,
      transcriptPath: '/tmp/session.jsonl',
      degraded: true,
      driftCount: 12,
    });

    const response = await request('GET', `/api/v1/sessions/${sessionId}/files`);
    const data = response.json<{ data: { completeness: string; completenessReason: string } }>();

    expect(data.data.completeness).toBe('partial');
    expect(data.data.completenessReason).toBe('observation_degraded');
  });

  it('404s every nested read for an unknown Session', async () => {
    const unknown = newId();
    for (const suffix of ['messages', 'timeline', 'commits', 'files']) {
      const response = await request('GET', `/api/v1/sessions/${unknown}/${suffix}`);
      expect(response.statusCode, suffix).toBe(404);
    }
  });
});
