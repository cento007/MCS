import { schema } from '@mc/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  type SeededUser,
  seedUser,
  setSecuritySetting,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from './cookie.js';
import { FixedWindowRateLimiter, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS } from './rate-limit.js';

/**
 * `/api/v1/auth/*` against a real, migrated PostgreSQL (TDS 07 §3.1) — the contract in
 * TDS 04 §3 and the guard in §1.4, exercised end to end through `app.inject()`.
 */

interface AuditRow {
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  requestId: string | null;
}

async function auditRows(): Promise<AuditRow[]> {
  return testDatabase()
    .db.select({
      actorType: schema.auditLogEntries.actorType,
      actorId: schema.auditLogEntries.actorId,
      action: schema.auditLogEntries.action,
      entityType: schema.auditLogEntries.entityType,
      entityId: schema.auditLogEntries.entityId,
      before: schema.auditLogEntries.before,
      after: schema.auditLogEntries.after,
      requestId: schema.auditLogEntries.requestId,
    })
    .from(schema.auditLogEntries)
    .orderBy(desc(schema.auditLogEntries.createdAt));
}

/**
 * Only the rows this request produced. `seedUser` goes through the real first-run bootstrap,
 * which correctly writes a `user.created` row with `actorType: 'system'` — filtering here
 * keeps that fact visible in the assertions below instead of hiding it in a fixture.
 */
async function authAuditRows(): Promise<AuditRow[]> {
  return (await auditRows()).filter((row) => row.action.startsWith('auth.'));
}

/** A mutable clock, so expiry is tested by moving time rather than by sleeping. */
let clock = new Date();
let limiter: FixedWindowRateLimiter;
let app: FastifyInstance;
let user: SeededUser;

async function login(
  credentials: { username: string; password: string } = user,
): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: credentials,
  });
}

async function loginCookie(): Promise<string> {
  const response = await login();
  expect(response.statusCode).toBe(200);
  return cookieValueFrom(response.headers['set-cookie'], SESSION_COOKIE_NAME);
}

beforeEach(async () => {
  await truncateAll();
  clock = new Date();
  limiter = new FixedWindowRateLimiter({
    limit: LOGIN_RATE_LIMIT,
    windowMs: LOGIN_RATE_WINDOW_MS,
    now: () => clock.getTime(),
  });
  ({ app } = createTestApp({ now: () => clock, loginRateLimiter: limiter, cookieSecure: false }));
  user = await seedUser();
});

describe('POST /api/v1/auth/login', () => {
  it('returns the §3.1 body and sets an HTTP-only SameSite=Lax cookie', async () => {
    const response = await login();

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      data: { user: { id: string; username: string }; expiresAt: string };
    }>();
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data.user).toEqual({ id: user.id, username: user.username });
    expect(body.data.expiresAt).toMatch(/Z$/);

    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    // D10: V1 is loopback HTTP, so Secure must be off here — driven by config, not hardcoded.
    expect(setCookie).not.toContain('Secure');
  });

  it('persists an auth_sessions row holding only the SHA-256 hash of the cookie value', async () => {
    const cookie = await loginCookie();

    const rows = await testDatabase().db.select().from(schema.authSessions);

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.userId).toBe(user.id);
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The cookie value itself is nowhere in the database.
    expect(row?.tokenHash).not.toBe(cookie);
    expect(JSON.stringify(row)).not.toContain(cookie);
  });

  it('rejects a wrong password with INVALID_CREDENTIALS and no cookie', async () => {
    const response = await login({ username: user.username, password: 'wrong-password' });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await testDatabase().db.select().from(schema.authSessions)).toHaveLength(0);
  });

  it('gives an unknown username the identical response to a wrong password', async () => {
    const unknown = await login({ username: 'nobody', password: user.password });
    const wrong = await login({ username: user.username, password: 'wrong-password' });

    expect(unknown.statusCode).toBe(wrong.statusCode);
    expect(unknown.json<{ error: { code: string; message: string } }>().error.code).toBe(
      wrong.json<{ error: { code: string; message: string } }>().error.code,
    );
    expect(unknown.json<{ error: { message: string } }>().error.message).toBe(
      wrong.json<{ error: { message: string } }>().error.message,
    );
  });

  it('matches the username case-insensitively (ux_users_username_lower)', async () => {
    const response = await login({
      username: user.username.toUpperCase(),
      password: user.password,
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a malformed body with VALIDATION_FAILED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: user.username },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('throttles at 10/min/IP with RATE_LIMITED (TDS 04 §3.1)', async () => {
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT; attempt += 1) {
      const response = await login({ username: user.username, password: 'wrong-password' });
      expect(response.statusCode).toBe(401);
    }

    const throttled = await login();
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json<{ error: { code: string } }>().error.code).toBe('RATE_LIMITED');
    expect(throttled.headers['retry-after']).toBeDefined();
  });
});

describe('the guard (TDS 04 §1.4)', () => {
  it('rejects an unauthenticated request to every non-public route', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/auth/me'],
      ['POST', '/api/v1/auth/logout'],
      ['GET', '/api/v1/auth/tokens'],
      ['POST', '/api/v1/auth/tokens'],
    ] as const) {
      const response = await app.inject({ method, url, payload: {} });

      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('leaves the login route and the liveness probe public', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await login()).statusCode).toBe(200);
  });

  it('rejects a garbage cookie, an unknown-scheme Authorization header, and a bearer that is not a token', async () => {
    const cases = [
      { headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-token` } },
      { headers: { authorization: 'Basic dXNlcjpwYXNz' } },
      { headers: { authorization: 'Bearer mct_nope' } },
      { headers: { authorization: 'Bearer' } },
    ];

    for (const options of cases) {
      const response = await app.inject({ method: 'GET', url: '/api/v1/auth/me', ...options });
      expect(response.statusCode, JSON.stringify(options)).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('accepts a valid session cookie', async () => {
    const cookie = await loginCookie();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: { authMethod: string } }>().data.authMethod).toBe('cookie');
  });
});

describe('GET /api/v1/auth/me', () => {
  it('reports the user, the auth method and the session expiry', async () => {
    const cookie = await loginCookie();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    const body = response.json<{
      data: {
        user: { id: string; username: string };
        authMethod: string;
        session: { expiresAt: string } | null;
      };
    }>();

    expect(body.data.user).toEqual({ id: user.id, username: user.username });
    expect(body.data.authMethod).toBe('cookie');
    expect(body.data.session?.expiresAt).toMatch(/Z$/);
  });
});

describe('session expiry (idle timeout, TDS 04 §1.4)', () => {
  it('honours security.sessionTimeoutMinutes when issuing the session', async () => {
    await setSecuritySetting('session_timeout_minutes', 30);

    const response = await login();
    const expiresAt = new Date(response.json<{ data: { expiresAt: string } }>().data.expiresAt);

    expect(expiresAt.getTime() - clock.getTime()).toBe(30 * 60_000);
    expect(String(response.headers['set-cookie'])).toContain(`Max-Age=${30 * 60}`);
  });

  it('rejects the cookie once the session has expired, and drops the row', async () => {
    await setSecuritySetting('session_timeout_minutes', 30);
    const cookie = await loginCookie();

    clock = new Date(clock.getTime() + 31 * 60_000);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    expect(await testDatabase().db.select().from(schema.authSessions)).toHaveLength(0);
  });

  it('slides the expiry forward on activity — it is an idle timeout, not a hard one', async () => {
    await setSecuritySetting('session_timeout_minutes', 30);
    const cookie = await loginCookie();

    const [before] = await testDatabase().db.select().from(schema.authSessions);
    clock = new Date(clock.getTime() + 20 * 60_000);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(response.statusCode).toBe(200);

    const [after] = await testDatabase().db.select().from(schema.authSessions);
    expect(after?.expiresAt.getTime()).toBeGreaterThan(before?.expiresAt.getTime() ?? 0);
    expect(after?.lastSeenAt?.getTime()).toBe(clock.getTime());
  });
});

describe('POST /api/v1/auth/logout', () => {
  it('returns 204, clears the cookie and invalidates the server-side session', async () => {
    const cookie = await loginCookie();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(String(response.headers['set-cookie'])).toContain('Max-Age=0');
    expect(await testDatabase().db.select().from(schema.authSessions)).toHaveLength(0);

    const replay = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(replay.statusCode).toBe(401);
  });
});

describe('POST /api/v1/auth/password', () => {
  const newPassword = 'a new and sufficiently long passphrase';

  it('changes the password and invalidates every OTHER session', async () => {
    const keptCookie = await loginCookie();
    const otherCookie = await loginCookie();
    expect(await testDatabase().db.select().from(schema.authSessions)).toHaveLength(2);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${keptCookie}` },
      payload: { currentPassword: user.password, newPassword },
    });

    expect(response.statusCode).toBe(204);

    const still = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${keptCookie}` },
    });
    expect(still.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${otherCookie}` },
    });
    expect(revoked.statusCode).toBe(401);

    limiter.reset();
    expect((await login({ username: user.username, password: newPassword })).statusCode).toBe(200);
    expect((await login({ username: user.username, password: user.password })).statusCode).toBe(
      401,
    );
  });

  it('rejects a wrong current password with INVALID_CREDENTIALS and changes nothing', async () => {
    const cookie = await loginCookie();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { currentPassword: 'not the password', newPassword },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_CREDENTIALS');

    limiter.reset();
    expect((await login()).statusCode).toBe(200);
  });

  it('enforces the 12-character minimum with VALIDATION_FAILED', async () => {
    const cookie = await loginCookie();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { currentPassword: user.password, newPassword: 'too-short' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('audit log (PRD §10, TDS 04 §12)', () => {
  it('records auth.login with actorType user and the request id', async () => {
    const response = await login();
    const requestId = String(response.headers['x-request-id']);

    const rows = await authAuditRows();
    expect(rows).toHaveLength(1);

    const entry = rows[0];
    expect(entry?.action).toBe('auth.login');
    expect(entry?.actorType).toBe('user');
    expect(entry?.actorId).toBe(user.id);
    expect(entry?.entityType).toBe('users');
    expect(entry?.entityId).toBe(user.id);
    expect(entry?.requestId).toBe(requestId);
    expect(entry?.after?.['authMethod']).toBe('cookie');
  });

  it('records auth.login_failed for a wrong password and for an unknown username', async () => {
    await login({ username: user.username, password: 'wrong-password' });
    await login({ username: 'nobody', password: 'wrong-password' });

    const rows = await authAuditRows();
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(['auth.login_failed', 'auth.login_failed']);

    const unknownUser = rows.find((row) => row.after?.['reason'] === 'unknown_user');
    const wrongPassword = rows.find((row) => row.after?.['reason'] === 'invalid_password');

    expect(unknownUser?.actorId).toBeNull();
    expect(wrongPassword?.actorId).toBe(user.id);
    // The attempted password never reaches an audit row.
    expect(JSON.stringify(rows)).not.toContain('wrong-password');
    expect(JSON.stringify(rows)).not.toContain(user.password);
  });

  it('records auth.logout and auth.password_changed', async () => {
    const cookie = await loginCookie();

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { currentPassword: user.password, newPassword: 'another long passphrase here' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    const actions = (await authAuditRows()).map((row) => row.action);
    expect(actions).toContain('auth.password_changed');
    expect(actions).toContain('auth.logout');
  });

  it('never invents a "token" actor type (TDS 04 §12)', async () => {
    await login();
    await login({ username: user.username, password: 'wrong-password' });

    // Every auth event is the single local User acting…
    expect([...new Set((await authAuditRows()).map((row) => row.actorType))]).toEqual(['user']);
    // …and nothing anywhere in the table uses a fourth actor type. The CLI bootstrap's
    // `user.created` row is `system`, which is one of the three the DB CHECK allows.
    const all = new Set((await auditRows()).map((row) => row.actorType));
    expect([...all].sort()).toEqual(['system', 'user']);
    expect(all.has('token')).toBe(false);
  });

  it('preserves a non-UUID inbound request id so the correlation survives', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': 'inbound-correlation-id' },
      payload: user,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('inbound-correlation-id');

    // `request_id` is `text`, not `uuid` (TDS 03 §3.14): an externally-originated call such
    // as a hook POST carries its own correlation id, and that is precisely the case where
    // losing the audit correlation would hurt most.
    const rows = await authAuditRows();
    expect(rows[0]?.action).toBe('auth.login');
    expect(rows[0]?.requestId).toBe('inbound-correlation-id');
  });

  it('clamps an over-long request id to the column bound instead of failing the insert', async () => {
    const overLong = 'x'.repeat(200);
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'x-request-id': overLong },
      payload: user,
    });

    expect(response.statusCode).toBe(200);

    const rows = await authAuditRows();
    expect(rows[0]?.requestId?.length).toBeLessThanOrEqual(128);
  });
});

describe('the account is the single local user (F4.1)', () => {
  it('binds a session to the user it authenticated', async () => {
    const cookie = await loginCookie();

    const sessions = await testDatabase()
      .db.select()
      .from(schema.authSessions)
      .where(eq(schema.authSessions.userId, user.id));

    expect(sessions).toHaveLength(1);
    expect(cookie).not.toBe(sessions[0]?.tokenHash);
  });
});
