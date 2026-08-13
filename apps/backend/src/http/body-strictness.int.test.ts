import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedRepository,
  seedSession,
  seedUser,
  type TestApp,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';

/**
 * **Every** API route rejects an unknown body field — walked from the real route table, not
 * from a list maintained here.
 *
 * The unit tier proves the policies are all `strict` by inspecting them; this tier proves the
 * policy is enforced on the wire, through the real auth guard, the real Ajv instance and the
 * real error handler. It fails for a route added tomorrow that opts out, and it fails if the
 * `preValidation` hook is dropped — neither of which any per-route test would notice.
 *
 * The walk is safe *because* the guard works: an unknown field is rejected at `preValidation`,
 * so no handler runs and no action is performed. If the guard ever stops working the walk
 * starts reaching handlers, which is exactly the failure this test should make loud.
 */

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;
let projectId: string;
let repositoryId: string;
let sessionId: string;

const BOGUS = 'definitelyNotAField';

/** A syntactically valid id for any `:param` segment. The guard runs before any lookup. */
const PLACEHOLDER = '018f6b2e-1111-7abc-8def-0123456789ab';

function concretePath(url: string): string {
  return url
    .split('/')
    .map((segment) => (segment.startsWith(':') ? PLACEHOLDER : segment))
    .join('/');
}

interface ErrorBody {
  readonly error: { code: string; message: string; details: unknown; requestId: string };
}

type InjectedResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function send(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

beforeAll(async () => {
  await truncateAll();

  const user = await seedUser();
  userId = user.id;
  built = createTestApp({ cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);

  const seeded = await seedProject();
  projectId = seeded.projectId;
  repositoryId = await seedRepository(projectId);
  sessionId = await seedSession({ projectId, userId, title: 'Original title' });

  await app.ready();
});

describe('body strictness across the whole API surface', () => {
  it('registers a policy for every route, and only the two documented opt-outs', () => {
    const api = app.bodyFieldPolicies.filter((route) => route.url.startsWith('/api/'));
    const openedUp = api
      .filter((route) => route.mode !== 'strict' || route.openPaths.length > 0)
      .map((route) => `${route.method} ${route.url}`);

    expect(api.length).toBeGreaterThan(30);
    expect(openedUp.sort()).toEqual([
      // F1.5: Claude Code owns this body and adds fields between versions.
      'POST /api/v1/hook-events',
      // Only ever answers 404 for the category; the body is beside the point.
      'PUT /api/v1/settings/:category',
    ]);
  });

  it('rejects an unknown field on every strict route by name', async () => {
    const routes = app.bodyFieldPolicies.filter(
      (route) =>
        route.mode === 'strict' &&
        route.url.startsWith('/api/') &&
        route.method !== 'GET' &&
        route.method !== 'HEAD' &&
        // A WebSocket upgrade, not a JSON endpoint (`ws/upgrade.test.ts` owns its lifecycle).
        route.url !== '/api/v1/ws',
    );

    expect(routes.length).toBeGreaterThan(20);

    const wrong: string[] = [];
    for (const route of routes) {
      const response = await app.inject({
        method: route.method as 'POST',
        url: concretePath(route.url),
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
        payload: { [BOGUS]: 'x' },
      });

      const details = response.json<ErrorBody>().error?.details as
        | { unknownFields?: string[] }
        | null
        | undefined;

      if (response.statusCode !== 400 || !details?.unknownFields?.includes(BOGUS)) {
        wrong.push(
          `${route.method} ${route.url} -> ${String(response.statusCode)} ${response.body.slice(0, 200)}`,
        );
      }
    }

    expect(wrong).toEqual([]);
  });

  it('is the instructions that matter: the four confirmed cases no longer succeed silently', async () => {
    // Every one of these answered 2xx before the guard, with the field discarded.
    const typoedTitle = await send('PATCH', `/api/v1/sessions/${sessionId}`, { titel: 'renamed' });
    expect(typoedTitle.statusCode).toBe(400);
    expect(typoedTitle.json<ErrorBody>().error.details).toEqual({
      unknownFields: ['titel'],
      allowedFields: ['agentId', 'notes', 'projectId', 'title'],
    });

    const typoedBranch = await send('PATCH', `/api/v1/repositories/${repositoryId}`, {
      defaultBrach: 'develop',
    });
    expect(typoedBranch.statusCode).toBe(400);

    const typoedRepository = await send('POST', '/api/v1/sessions', {
      projectId,
      workingDirectory: process.cwd(),
      repositoryid: repositoryId,
    });
    expect(typoedRepository.statusCode).toBe(400);

    const typoedMode = await send('POST', '/api/v1/projects', {
      name: 'Typo',
      workflowmode: 'assisted',
    });
    expect(typoedMode.statusCode).toBe(400);

    // …and the resources are untouched: the rejection happened before any write.
    const session = await send('GET', `/api/v1/sessions/${sessionId}`);
    expect(session.json<{ data: { title: string } }>().data.title).toBe('Original title');

    const projects = await send('GET', '/api/v1/projects');
    expect(projects.json<{ data: { name: string }[] }>().data.map((row) => row.name)).not.toContain(
      'Typo',
    );
  });

  it('rejects a nested unknown field, which a settings write would have read as a reset', async () => {
    // `enabl` used to be stripped, after which `normalize` read `enabled` as absent and wrote
    // the registry DEFAULT back — a silent change to a setting the operator was editing.
    const response = await send('PUT', '/api/v1/settings/notifications', {
      dailyReport: { enabl: true, time: '09:00' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details).toEqual({
      unknownFields: ['dailyReport.enabl'],
      allowedFields: ['dailyReport.enabled', 'dailyReport.time'],
    });
  });

  it('leaves the documented opt-out permissive — F1.5 version drift stays acceptable', async () => {
    // A hook body from a Claude Code version that added a field we have never seen. It must not
    // become a 400 in the operator's terminal. (401/403 here: the ingest route refuses cookie
    // auth, which is a different guard and proves this one did not fire first.)
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/hook-events',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: {
        hook_event_name: 'PostToolUse',
        session_id: PLACEHOLDER,
        somethingClaudeAddedLastWeek: { nested: true },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorBody>().error.code).toBe('FORBIDDEN');
  });

  it('still accepts every field a route does declare', async () => {
    const response = await send('PATCH', `/api/v1/sessions/${sessionId}`, {
      title: 'Renamed properly',
      notes: 'still fine',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { title: string } }>().data.title).toBe('Renamed properly');
  });

  it('rejects after authentication, never before it', async () => {
    const anonymous = await app.inject({
      method: 'PATCH',
      url: `/api/v1/sessions/${sessionId}`,
      payload: { [BOGUS]: 1 },
    });

    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });
});
