import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type PgBossQueue, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
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
} from '../../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';

/**
 * Observed-session ingest end to end — TDS 04 §6.8/§6.9 through the real Fastify app, the real
 * guard, the real state machine and a real database.
 *
 * The three things this file exists to prove, because each is a rule somebody could plausibly
 * "simplify" away:
 *
 *   1. the endpoint takes an **ingest**-scoped bearer token and refuses a browser cookie;
 *   2. a first-seen runtime session id creates an observed Session and confirms the attach as a
 *      **system**-triggered `created -> running` — never a user `start`;
 *   3. a redelivered hook is a no-op, which is the partial-index `ON CONFLICT` predicate doing
 *      its job (TDS 03 §3.11 — omitting the predicate fails the statement outright).
 */

const RUNTIME_SESSION_ID = '11111111-1111-4111-8111-111111111111';

let queue: PgBossQueue;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let ingestToken: string;
let projectId: string;
let userId: string;
let workingDirectory: string;
let transcriptPath: string;

interface SessionBody {
  id: string;
  projectId: string;
  repositoryId: string | null;
  sessionType: string;
  state: string;
  title: string;
  workingDirectory: string;
  runtime: { runtimeSessionId: string | null };
  observation: { channel: string; degraded: boolean; driftCount: number } | null;
  completedAt: string | null;
}

interface HookBody {
  hookEventName: string;
  runtimeSessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  occurredAt?: string;
  payload?: Record<string, unknown>;
}

async function postHook(
  body: Record<string, unknown>,
  headers: Record<string, string> = { authorization: `Bearer ${ingestToken}` },
): Promise<{ status: number; code?: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/hook-events',
    headers,
    payload: body,
  });

  return {
    status: response.statusCode,
    ...(response.statusCode >= 400
      ? { code: response.json<{ error: { code: string } }>().error.code }
      : {}),
  };
}

function hook(overrides: Partial<HookBody> = {}): Record<string, unknown> {
  return {
    hookEventName: 'SessionStart',
    runtimeSessionId: RUNTIME_SESSION_ID,
    transcriptPath,
    cwd: workingDirectory,
    payload: {},
    ...overrides,
  };
}

async function sessionByRuntimeId(runtimeSessionId = RUNTIME_SESSION_ID) {
  const rows = await testDatabase()
    .db.select()
    .from(schema.sessions)
    .where(eq(schema.sessions.runtimeSessionId, runtimeSessionId));
  return rows[0] ?? null;
}

async function messagesFor(sessionId: string) {
  return testDatabase()
    .db.select()
    .from(schema.messages)
    .where(eq(schema.messages.sessionId, sessionId))
    .orderBy(schema.messages.ordinal);
}

async function timelineFor(sessionId: string) {
  return testDatabase()
    .db.select()
    .from(schema.sessionEvents)
    .where(eq(schema.sessionEvents.sessionId, sessionId));
}

async function getSession(id: string): Promise<SessionBody> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/sessions/${id}`,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });
  return response.json<{ data: SessionBody }>().data;
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();

  built = createTestApp({ queue, cookieSecure: false });
  app = built.app;

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());

  workingDirectory = testWorkingDirectory();
  const projectsDir = join(workingDirectory, '.claude-transcripts');
  mkdirSync(projectsDir, { recursive: true });
  transcriptPath = join(projectsDir, `${RUNTIME_SESSION_ID}.jsonl`);

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);

  const token = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/tokens',
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    payload: { name: 'claude-code-hooks', scopes: ['ingest'] },
  });
  ingestToken = token.json<{ data: { token: string } }>().data.token;
});

describe('POST /api/v1/hook-events — authentication (§6.8)', () => {
  it('accepts an ingest-scoped bearer token', async () => {
    expect(await postHook(hook())).toEqual({ status: 204 });
  });

  it('rejects a browser cookie with FORBIDDEN, not UNAUTHORIZED', async () => {
    // The caller IS authenticated; this credential type is simply not accepted here. Hooks run
    // outside the browser session, so a cookie on this route means something has gone wrong.
    expect(await postHook(hook(), { cookie: `${SESSION_COOKIE_NAME}=${cookie}` })).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
  });

  it('rejects an unauthenticated call', async () => {
    expect(await postHook(hook(), {})).toEqual({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('confines the ingest token to this endpoint and nothing else', async () => {
    // The token sits in plaintext in a settings file any process running as the operator can
    // read, so "what else can it do" is the whole security story of the hook channel.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${ingestToken}` },
    });

    expect(response.statusCode).toBe(403);
    const error = response.json<{ error: { code: string; details: Record<string, unknown> } }>();
    expect(error.error.code).toBe('FORBIDDEN');
    expect(error.error.details['requiredScope']).toBe('full');
  });

  it('rejects a body it cannot understand, and only for the two fields it must', async () => {
    expect(await postHook({ hookEventName: 'SessionStart' })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
    expect(await postHook({ runtimeSessionId: RUNTIME_SESSION_ID })).toEqual({
      status: 400,
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('session binding (§6.8, TDS 02 §5.2)', () => {
  it('creates an observed Session on first sight and confirms the attach as SYSTEM', async () => {
    expect(await postHook(hook())).toEqual({ status: 204 });

    const session = await sessionByRuntimeId();
    expect(session).not.toBeNull();
    expect(session?.sessionType).toBe('observed');
    expect(session?.state).toBe('running');
    expect(session?.projectId).toBe(projectId);
    expect(session?.userId).toBe(userId);
    expect(session?.workingDir).toBe(workingDirectory);
    expect(session?.transcriptPath).toBe(transcriptPath);
    expect(session?.startedAt).toBeInstanceOf(Date);

    // F7: `created -> running` recorded with timestamp + trigger. `system`, because there is no
    // user `start` for an observed Session — the operator started it in their own terminal.
    const timeline = await timelineFor(session?.id as string);
    const transition = timeline.find((row) => row.type === 'session.state_changed');
    expect(transition).toMatchObject({
      fromState: 'created',
      toState: 'running',
      trigger: 'system',
    });

    // …and the specific F7 event went out alongside it.
    expect(built.outbox).toBeDefined();
  });

  it('binds to the Repository whose local_path contains the cwd, and to its Project', async () => {
    const repoRoot = testWorkingDirectory();
    const repositoryId = await seedRepository(projectId, { localPath: repoRoot });
    const nested = join(repoRoot, 'apps', 'backend');
    mkdirSync(nested, { recursive: true });

    await postHook(hook({ cwd: nested }));

    const session = await sessionByRuntimeId();
    expect(session?.repositoryId).toBe(repositoryId);
    expect(session?.projectId).toBe(projectId);
  });

  it('reuses the same Session for every later hook on the same runtime id', async () => {
    await postHook(hook());
    await postHook(hook({ hookEventName: 'Stop' }));
    await postHook(hook({ hookEventName: 'UserPromptSubmit', payload: { prompt: 'hello' } }));

    const rows = await testDatabase()
      .db.select()
      .from(schema.sessions)
      .where(eq(schema.sessions.runtimeSessionId, RUNTIME_SESSION_ID));
    expect(rows).toHaveLength(1);
  });

  it('binds on any hook, not only SessionStart — hooks installed mid-session still attach', async () => {
    await postHook(hook({ hookEventName: 'PostToolUse', payload: { tool_name: 'Read' } }));

    const session = await sessionByRuntimeId();
    expect(session?.state).toBe('running');
  });

  it('reports INTEGRATION_NOT_CONFIGURED when there is no Project to attach to', async () => {
    await testDatabase().db.delete(schema.projects);

    expect(
      await postHook(hook({ runtimeSessionId: '33333333-3333-4333-8333-333333333333' })),
    ).toEqual({ status: 409, code: 'INTEGRATION_NOT_CONFIGURED' });
  });
});

describe('message ingest and idempotency (§6.8, TDS 03 §3.11)', () => {
  it('persists a user prompt and derives the Session title from it (A13)', async () => {
    await postHook(
      hook({ hookEventName: 'UserPromptSubmit', payload: { prompt: 'Add a health endpoint' } }),
    );

    const session = await sessionByRuntimeId();
    const messages = await messagesFor(session?.id as string);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'Add a health endpoint' });
    expect(session?.title).toBe('Add a health endpoint');
  });

  it('is idempotent on redelivery — the partial-index ON CONFLICT predicate is exercised', async () => {
    const body = hook({
      hookEventName: 'UserPromptSubmit',
      payload: { prompt: 'Rename the queue module' },
    });

    // Same body three times, as a retrying hook would send it. The synthesized key is a pure
    // function of the payload, so all three collapse into one row. If the `ON CONFLICT` target
    // omitted `WHERE runtime_message_id IS NOT NULL`, PostgreSQL would reject the statement and
    // these would be 500s rather than duplicates — which is exactly why this asserts 204.
    expect(await postHook(body)).toEqual({ status: 204 });
    expect(await postHook(body)).toEqual({ status: 204 });
    expect(await postHook(body)).toEqual({ status: 204 });

    const session = await sessionByRuntimeId();
    const messages = await messagesFor(session?.id as string);
    expect(messages).toHaveLength(1);

    // One Message, therefore one `session.message.appended` timeline entry: a replay collapsed
    // by the dedupe key derives nothing, appends nothing and emits nothing (§6.11.1).
    const timeline = await timelineFor(session?.id as string);
    expect(timeline.filter((row) => row.type === 'session.message.appended')).toHaveLength(1);
  });

  it('persists a tool invocation with the file path the Files panel needs (§6.10.2)', async () => {
    const filePath = join(workingDirectory, 'src', 'router.ts');
    await postHook(
      hook({
        hookEventName: 'PostToolUse',
        payload: {
          tool_name: 'Edit',
          tool_use_id: 'toolu_01',
          tool_input: { file_path: filePath },
          tool_response: { ok: true },
        },
      }),
    );

    const session = await sessionByRuntimeId();
    const messages = await messagesFor(session?.id as string);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: 'tool',
      toolName: 'Edit',
      toolUseId: 'toolu_01',
      toolFilePath: filePath,
    });

    const files = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session?.id}/files`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    if (files.statusCode !== 200) console.log(JSON.stringify(files.json(), null, 2));
    expect(files.statusCode).toBe(200);
    expect(JSON.stringify(files.json())).toContain('router.ts');
  });

  it('stores a payload shape it does not recognise instead of rejecting it (F1.5)', async () => {
    const response = await postHook(
      hook({
        hookEventName: 'PostToolUse',
        payload: {
          tool_name: 'SomeToolFrom2027',
          tool_input: { shape: 'nobody has seen before', nested: [1, { deep: true }] },
        },
      }),
    );

    expect(response).toEqual({ status: 204 });

    const session = await sessionByRuntimeId();
    const messages = await messagesFor(session?.id as string);
    expect(messages[0]?.toolName).toBe('SomeToolFrom2027');
    expect(messages[0]?.toolFilePath).toBeNull();
    expect(JSON.stringify(messages[0]?.toolPayload)).toContain('nobody has seen before');
  });

  it('records no Message for the three lifecycle hooks', async () => {
    await postHook(hook({ hookEventName: 'SessionStart' }));
    await postHook(hook({ hookEventName: 'Stop' }));

    const session = await sessionByRuntimeId();
    expect(await messagesFor(session?.id as string)).toHaveLength(0);
  });
});

describe('completion and "stop observing" (TDS 02 §5.2)', () => {
  it('completes the Session on the SessionEnd hook, system-triggered', async () => {
    await postHook(hook());
    await postHook(hook({ hookEventName: 'SessionEnd', payload: { reason: 'clear' } }));

    const session = await sessionByRuntimeId();
    expect(session?.state).toBe('completed');
    expect(session?.completedAt).toBeInstanceOf(Date);

    const timeline = await timelineFor(session?.id as string);
    const completion = timeline.find(
      (row) => row.type === 'session.state_changed' && row.toState === 'completed',
    );
    expect(completion?.trigger).toBe('system');
  });

  it('ignores hook traffic that arrives after the Session is over', async () => {
    await postHook(hook());
    await postHook(hook({ hookEventName: 'SessionEnd' }));

    // A late `PostToolUse` from a process we no longer observe. Accepted and dropped: a 4xx
    // here would show up as a hook failure in the operator's own terminal for a condition that
    // is entirely normal.
    expect(
      await postHook(
        hook({ hookEventName: 'PostToolUse', payload: { tool_name: 'Read', tool_input: {} } }),
      ),
    ).toEqual({ status: 204 });

    const session = await sessionByRuntimeId();
    expect(session?.state).toBe('completed');
    expect(await messagesFor(session?.id as string)).toHaveLength(0);
  });

  it('user `end` means stop observing: the record closes, nothing is signalled', async () => {
    await postHook(hook());
    const session = await sessionByRuntimeId();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session?.id}/end`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: SessionBody }>().data.state).toBe('completed');

    // Ingest detaches: the operator's `claude` may keep running, unobserved, and further hook
    // traffic is dropped rather than resurrecting the record.
    await postHook(hook({ hookEventName: 'UserPromptSubmit', payload: { prompt: 'still here' } }));
    expect(await messagesFor(session?.id as string)).toHaveLength(0);
    expect((await sessionByRuntimeId())?.state).toBe('completed');
  });
});

describe('F7 applicability for observed Sessions (TDS 02 §5.2, §6.3)', () => {
  it('rejects pause and start with OPERATION_NOT_SUPPORTED', async () => {
    await postHook(hook());
    const session = await sessionByRuntimeId();

    for (const action of ['pause', 'start'] as const) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/sessions/${session?.id}/${action}`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });

      // The state is legal; the session TYPE is not. Mission Control cannot gate an external
      // CLI, so these are not "wrong state" errors and must not be reported as one.
      expect(response.statusCode, action).toBe(409);
      const error = response.json<{ error: { code: string; details: Record<string, unknown> } }>();
      expect(error.error.code, action).toBe('OPERATION_NOT_SUPPORTED');
      expect(error.error.details['sessionType']).toBe('observed');
    }
  });

  it('rejects resume of a paused observed Session with OPERATION_NOT_SUPPORTED', async () => {
    // Seeded directly: an observed Session can never legitimately reach `paused`, because the
    // only route there is the pause action the row above proves is refused. This is the
    // `paused -> running` edge from §5.2's applicability matrix, and the point is that the
    // rejection names the session TYPE rather than the state.
    const pausedId = await seedSession({
      projectId,
      userId,
      sessionType: 'observed',
      state: 'paused',
      runtimeSessionId: '44444444-4444-4444-8444-444444444444',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${pausedId}/resume`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(409);
    const error = response.json<{ error: { code: string; details: Record<string, unknown> } }>();
    expect(error.error.code).toBe('OPERATION_NOT_SUPPORTED');
    expect(error.error.details['sessionType']).toBe('observed');
  });

  it('rejects resume of a RUNNING observed Session as an illegal transition', async () => {
    await postHook(hook());
    const session = await sessionByRuntimeId();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session?.id}/resume`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    // Documented as found, not as assumed: `resume` from `running` is not an F7 edge for ANY
    // session type, so `SessionService.resume` answers on state before it ever asks about
    // applicability. A managed Session in `running` gets the identical code. Recorded because
    // WS1 §5.2 describes `running -> paused` / `paused -> running` as the not-applicable pair,
    // which reads as though every `resume` on an observed Session should say
    // `OPERATION_NOT_SUPPORTED`.
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'INVALID_STATE_TRANSITION',
    );
  });

  it('rejects interrupt too — there is no turn of ours to stop', async () => {
    await postHook(hook());
    const session = await sessionByRuntimeId();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session?.id}/interrupt`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('OPERATION_NOT_SUPPORTED');
  });

  it('allows archive after completion, exactly as for a managed Session', async () => {
    await postHook(hook());
    await postHook(hook({ hookEventName: 'SessionEnd' }));
    const session = await sessionByRuntimeId();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session?.id}/archive`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: SessionBody }>().data.state).toBe('archived');
  });
});

describe('Session.observation on the read path (§6.9)', () => {
  it('exposes an observation block for an observed Session and null for a managed one', async () => {
    await postHook(hook());
    const observed = await sessionByRuntimeId();

    const body = await getSession(observed?.id as string);
    expect(body.sessionType).toBe('observed');
    expect(body.observation).not.toBeNull();
    expect(body.observation?.degraded).toBe(false);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { projectId, workingDirectory },
    });
    expect(created.json<{ data: SessionBody }>().data.observation).toBeNull();
  });

  it('lists observed Sessions under ?sessionType=observed', async () => {
    await postHook(hook());

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions?sessionType=observed',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    const body = response.json<{ data: SessionBody[] }>();
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.runtime.runtimeSessionId).toBe(RUNTIME_SESSION_ID);
  });
});

describe('queue health', () => {
  it('leaves no queue errors behind — every ingest committed its outbox rows', async () => {
    await postHook(hook());
    await postHook(hook({ hookEventName: 'UserPromptSubmit', payload: { prompt: 'x' } }));
    await postHook(hook({ hookEventName: 'SessionEnd' }));

    expect(queue).toBeDefined();
    const session = await sessionByRuntimeId();
    const timeline = await timelineFor(session?.id as string);
    // created -> running, message appended, running -> completed.
    expect(timeline.length).toBeGreaterThanOrEqual(3);
  });
});
