import type { FastifyInstance } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedUser,
  type TestApp,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import type { RouteQueryPolicy } from './query-strictness.js';

/**
 * **Every** API route rejects an unknown query parameter — walked from the real route table,
 * not from a list maintained here.
 *
 * The unit tier proves the same routes are all `strict` by inspecting their policies; this tier
 * proves the policy is actually enforced on the wire, through the real auth guard and the real
 * error handler. It fails for a route added tomorrow that opts out of the guard, and it fails
 * if the `preValidation` hook is dropped — neither of which any per-route test would notice.
 *
 * Read-only by construction: `GET` routes only. A POST or DELETE walked blindly would perform
 * the action it names, and the guard is a lifecycle-stage property, not a per-verb one — a hook
 * that runs for `GET /api/v1/sessions` runs for `POST /api/v1/sessions` too.
 */

let built: TestApp;
let app: FastifyInstance;
let cookie: string;

const BOGUS = 'definitelyNotAParameter';

/** A syntactically valid id for any `:param` segment. What it names does not matter: the guard
 *  runs at `preValidation`, before the handler can look anything up — which is itself part of
 *  the contract, since a rejected filter must not depend on the row existing. */
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

beforeAll(async () => {
  await truncateAll();

  const user = await seedUser();
  built = createTestApp({ cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);

  await app.ready();
});

describe('query-parameter strictness across the whole API surface', () => {
  it('registers a policy for every route, and none of them opted out', () => {
    const api = app.queryParameterPolicies.filter((route) => route.url.startsWith('/api/'));

    expect(api.length).toBeGreaterThan(30);
    expect(api.filter((route) => route.mode !== 'strict')).toEqual([]);
  });

  it('rejects an unknown parameter on every GET route by name', async () => {
    const routes: readonly RouteQueryPolicy[] = app.queryParameterPolicies.filter(
      (route) =>
        route.method === 'GET' &&
        route.url.startsWith('/api/') &&
        // `/api/v1/ws` is a WebSocket upgrade; injecting a plain GET exercises the plugin's
        // own non-upgrade path rather than this guard. Its policy is asserted above with the
        // rest, and `ws/upgrade.test.ts` owns its request lifecycle.
        route.url !== '/api/v1/ws',
    );

    expect(routes.length).toBeGreaterThan(15);

    const wrong: string[] = [];
    for (const route of routes) {
      const response = await app.inject({
        method: 'GET',
        url: `${concretePath(route.url)}?${BOGUS}=1`,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });

      const body = response.json<ErrorBody>();
      const details = body.error?.details as { unknownParameters?: string[] } | null | undefined;

      if (response.statusCode !== 400 || !details?.unknownParameters?.includes(BOGUS)) {
        wrong.push(`${route.url} -> ${String(response.statusCode)} ${response.body.slice(0, 200)}`);
      }
    }

    expect(wrong).toEqual([]);
  });

  it('is the filters that matter: the audit log and the Session list no longer fail open', async () => {
    // The two examples the defect was found on. Both used to answer 200 with everything.
    for (const url of ['/api/v1/audit-log-entries?actor=me', '/api/v1/sessions?stat=running']) {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      });

      expect(response.statusCode, url).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('still accepts every parameter a route does declare', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log-entries?limit=5&actorType=user&action=auth.login',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('rejects before authorization is spent, but after authentication', async () => {
    // No cookie: 401 wins, so an anonymous caller cannot enumerate parameters.
    const anonymous = await app.inject({ method: 'GET', url: `/api/v1/sessions?${BOGUS}=1` });
    expect(anonymous.statusCode).toBe(401);

    // With a cookie: the guard answers before the handler reads a row.
    const authenticated = await app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${PLACEHOLDER}?${BOGUS}=1`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    // The Session does not exist; the answer is still 400, not 404.
    expect(authenticated.statusCode).toBe(400);
  });
});
