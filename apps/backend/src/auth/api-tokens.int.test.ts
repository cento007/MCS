import { schema } from '@mc/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  type SeededUser,
  seedProject,
  seedUser,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from './cookie.js';
import { INGEST_ROUTE } from './guard.js';
import { hashToken } from './tokens.js';

/**
 * API tokens (TDS 04 §3.2–§3.3) and the scope authorization rule (§1.4, §6.8) against a real
 * database.
 *
 * The `ingest` scope exists so the observed-session hook endpoint can authenticate without
 * full access, so it is tested as an authorization *decision* on a route that declares the
 * policy — not as a string on a row. `POST /api/v1/hook-events` itself belongs to the
 * observed-session ingest work; the stub below declares the exact exported policy that route
 * will use, so the decision under test is the shipped one.
 */

interface TokenBody {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

let app: FastifyInstance;
let user: SeededUser;
let cookie: string;

/**
 * `scopes` defaults to `['full']` **here in the helper, not in the API**. Most tests below
 * want a working token and do not care about its scope; the route itself requires the field,
 * because a full-access token must never be issuable by omission. The tests that assert that
 * contract call `app.inject` directly so nothing is filled in behind them.
 */
async function createToken(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: TokenBody & { token: string } }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/tokens',
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    payload: { scopes: ['full'], ...payload },
  });

  return {
    status: response.statusCode,
    body: response.json<{ data: TokenBody & { token: string } }>().data,
  };
}

/** A minimal, valid `POST /hook-events` body (TDS 04 §6.8) for the authorized cases. */
function hookEvent(runtimeSessionId = '11111111-1111-4111-8111-111111111111'): {
  hookEventName: string;
  runtimeSessionId: string;
  payload: Record<string, unknown>;
} {
  return { hookEventName: 'SessionStart', runtimeSessionId, payload: {} };
}

async function bearerMe(token: string): Promise<ReturnType<FastifyInstance['inject']>> {
  return app.inject({
    method: 'GET',
    url: '/api/v1/auth/me',
    headers: { authorization: `Bearer ${token}` },
  });
}

beforeEach(async () => {
  await truncateAll();
  ({ app } = createTestApp({ cookieSecure: false }));

  // `POST /api/v1/hook-events` (TDS 04 §6.8) is now real, and it declares this very policy.
  // The stub survives only for the case where this file runs against a build without it — the
  // subject here is the guard's scope decision, not the ingest body contract.
  if (!app.hasRoute({ method: 'POST', url: '/api/v1/hook-events' })) {
    app.post('/api/v1/hook-events', { config: { auth: INGEST_ROUTE } }, async (_request, reply) =>
      reply.code(204).send(),
    );
  }

  user = await seedUser();
  // The real ingest route binds a first-seen runtime session to a Project (TDS 04 §6.8), so the
  // authorized cases below need one to exist. The rejected cases never reach the handler.
  await seedProject();

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

describe('POST /api/v1/auth/tokens', () => {
  it('returns the full token exactly once, and never again', async () => {
    const created = await createToken({ name: 'cli-laptop', scopes: ['full'] });

    expect(created.status).toBe(201);
    expect(created.body.token).toMatch(/^mct_[A-Za-z0-9_-]{43}$/);
    expect(created.body.prefix).toBe(created.body.token.slice(0, 8));
    expect(created.body.scopes).toEqual(['full']);
    expect(created.body.expiresAt).toBeNull();

    // 1. The list never carries it.
    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(list.body).not.toContain(created.body.token);
    expect(list.json<{ data: TokenBody[] }>().data[0]).not.toHaveProperty('token');

    // 2. There is no re-display endpoint at all.
    const fetchOne = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/tokens/${created.body.id}`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(fetchOne.statusCode).toBe(404);

    // 3. The database holds only the hash and the display prefix.
    const rows = await testDatabase().db.select().from(schema.apiTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashToken(created.body.token));
    expect(JSON.stringify(rows)).not.toContain(created.body.token.slice(8));
  });

  it('accepts an explicit scope set', async () => {
    expect((await createToken({ name: 'ingest', scopes: ['ingest'] })).body.scopes).toEqual([
      'ingest',
    ]);
    expect((await createToken({ name: 'both', scopes: ['full', 'ingest'] })).body.scopes).toEqual([
      'full',
      'ingest',
    ]);
  });

  it('refuses to issue a token when scopes is omitted, rather than defaulting to full', async () => {
    // Privilege escalation by omission: `scopes` used to be optional with a `['full']` default.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { name: 'no-scopes' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    expect(await testDatabase().db.select().from(schema.apiTokens)).toHaveLength(0);
  });

  it('refuses a misspelled scope field instead of silently granting full access', async () => {
    // The real hazard: Fastify runs Ajv with `removeAdditional`, so `additionalProperties: false`
    // *deletes* the unknown key rather than rejecting it. With `scopes` optional, a singular
    // `scope: ['ingest']` was stripped, the default applied, and the caller received a
    // full-access token with a 201 and no indication their requested scope was discarded.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { name: 'typo', scope: ['ingest'] },
    });

    expect(response.statusCode).toBe(400);
    expect(await testDatabase().db.select().from(schema.apiTokens)).toHaveLength(0);
  });

  it('rejects an unknown scope and an empty scope set with VALIDATION_FAILED', async () => {
    for (const scopes of [['admin'], [], ['full', 'full']]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/tokens',
        headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
        payload: { name: 'bad', scopes },
      });

      expect(response.statusCode, JSON.stringify(scopes)).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('stores an expiry when given, and rejects one that is not a timestamp', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    expect((await createToken({ name: 'expiring', expiresAt })).body.expiresAt).toBe(expiresAt);

    const bad = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { name: 'bad', expiresAt: 'yesterday' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('bearer authentication', () => {
  it('accepts a valid token and reports authMethod token with a null session', async () => {
    const { body } = await createToken({ name: 'cli-laptop' });

    const response = await bearerMe(body.token);
    expect(response.statusCode).toBe(200);

    const me = response.json<{
      data: { user: { id: string }; authMethod: string; session: null };
    }>();
    expect(me.data.user.id).toBe(user.id);
    expect(me.data.authMethod).toBe('token');
    // TDS 04 §3.1: `session` is null for token auth — a bearer token has no server session.
    expect(me.data.session).toBeNull();
  });

  it('records last_used_at on first use', async () => {
    const { body } = await createToken({ name: 'cli-laptop' });

    const before = await testDatabase()
      .db.select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.id, body.id));
    expect(before[0]?.lastUsedAt).toBeNull();

    await bearerMe(body.token);

    const after = await testDatabase()
      .db.select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.id, body.id));
    expect(after[0]?.lastUsedAt).toBeInstanceOf(Date);
  });

  it('rejects a REVOKED token', async () => {
    const { body } = await createToken({ name: 'cli-laptop' });
    expect((await bearerMe(body.token)).statusCode).toBe(200);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/tokens/${body.id}`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    expect(revoke.statusCode).toBe(204);

    const response = await bearerMe(body.token);
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');

    // Revocation is `revoked_at`, not deletion (TDS 03 §3.3) — the audit trail keeps its
    // referent, and the row being present is exactly why the check has to be in the guard.
    const rows = await testDatabase()
      .db.select()
      .from(schema.apiTokens)
      .where(eq(schema.apiTokens.id, body.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
  });

  it('rejects an EXPIRED token', async () => {
    const { body } = await createToken({
      name: 'expiring',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await bearerMe(body.token)).statusCode).toBe(200);

    await testDatabase()
      .db.update(schema.apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.apiTokens.id, body.id));

    const response = await bearerMe(body.token);
    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects an unknown token, and a token from another instance', async () => {
    expect((await bearerMe('mct_this-token-was-never-issued-by-this-server')).statusCode).toBe(401);
    expect((await bearerMe('not-even-shaped-like-a-token')).statusCode).toBe(401);
  });
});

describe('scope enforcement (TDS 04 §1.4, §6.8)', () => {
  it('rejects an INGEST-scoped token on a full-access route with FORBIDDEN', async () => {
    const { body } = await createToken({ name: 'hooks', scopes: ['ingest'] });

    for (const [method, url] of [
      ['GET', '/api/v1/auth/me'],
      ['GET', '/api/v1/auth/tokens'],
      ['POST', '/api/v1/auth/logout'],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${body.token}` },
      });

      expect(response.statusCode, `${method} ${url}`).toBe(403);

      const error = response.json<{ error: { code: string; details: Record<string, unknown> } }>();
      expect(error.error.code).toBe('FORBIDDEN');
      expect(error.error.details['requiredScope']).toBe('full');
    }
  });

  it('accepts an ingest-scoped token on the ingest route', async () => {
    const { body } = await createToken({ name: 'hooks', scopes: ['ingest'] });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/hook-events',
      headers: { authorization: `Bearer ${body.token}` },
      payload: hookEvent(),
    });

    expect(response.statusCode).toBe(204);
  });

  it('accepts a full-scoped token on the ingest route — full grants the entire API', async () => {
    const { body } = await createToken({ name: 'everything' });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/hook-events',
      headers: { authorization: `Bearer ${body.token}` },
      payload: hookEvent('22222222-2222-4222-8222-222222222222'),
    });

    expect(response.statusCode).toBe(204);
  });

  it('rejects COOKIE auth on the ingest route with FORBIDDEN, not UNAUTHORIZED', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/hook-events',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    const error = response.json<{ error: { code: string; details: Record<string, unknown> } }>();
    expect(error.error.code).toBe('FORBIDDEN');
    expect(error.error.details['authMethod']).toBe('cookie');
  });

  it('still rejects an unauthenticated ingest call with UNAUTHORIZED', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/hook-events', payload: {} });

    expect(response.statusCode).toBe(401);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/v1/auth/tokens', () => {
  it('lists active tokens in the §3.2 shape, without the value', async () => {
    await createToken({ name: 'cli-laptop' });
    await createToken({ name: 'obsidian', scopes: ['ingest'] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ data: TokenBody[]; meta: { nextCursor: null; limit: number } }>();
    expect(Object.keys(body).sort()).toEqual(['data', 'meta']);
    expect(body.meta).toEqual({ nextCursor: null, limit: 50 });
    expect(body.data.map((row) => row.name)).toEqual(['cli-laptop', 'obsidian']);
    expect(Object.keys(body.data[0] ?? {}).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'id',
      'lastUsedAt',
      'name',
      'prefix',
      'scopes',
    ]);
  });

  it('excludes revoked tokens — the list shape has no revokedAt to disambiguate them', async () => {
    const keep = await createToken({ name: 'keep' });
    const drop = await createToken({ name: 'drop' });

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/tokens/${drop.body.id}`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/tokens',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.json<{ data: TokenBody[] }>().data.map((row) => row.id)).toEqual([
      keep.body.id,
    ]);
  });

  it('paginates with an opaque cursor (F5.3)', async () => {
    for (const name of ['one', 'two', 'three']) await createToken({ name });

    const first = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/tokens?limit=2',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    const firstBody = first.json<{ data: TokenBody[]; meta: { nextCursor: string | null } }>();
    expect(firstBody.data).toHaveLength(2);
    expect(firstBody.meta.nextCursor).not.toBeNull();

    const second = await app.inject({
      method: 'GET',
      url: `/api/v1/auth/tokens?limit=2&cursor=${encodeURIComponent(String(firstBody.meta.nextCursor))}`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    const secondBody = second.json<{ data: TokenBody[]; meta: { nextCursor: string | null } }>();
    expect(secondBody.data).toHaveLength(1);
    expect(secondBody.meta.nextCursor).toBeNull();
    expect(secondBody.data[0]?.name).toBe('three');
  });

  it('rejects a corrupt cursor with INVALID_CURSOR', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/tokens?cursor=not-a-cursor',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_CURSOR');
  });
});

describe('DELETE /api/v1/auth/tokens/{id}', () => {
  it('returns 204 once, then NOT_FOUND — revoking twice is not idempotent by design', async () => {
    const { body } = await createToken({ name: 'cli-laptop' });

    const headers = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/v1/auth/tokens/${body.id}`, headers }))
        .statusCode,
    ).toBe(204);

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/tokens/${body.id}`,
      headers,
    });
    expect(second.statusCode).toBe(404);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND for an unknown id and VALIDATION_FAILED for a malformed one', async () => {
    const headers = { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };

    const unknown = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/tokens/018f6b2e-0000-7000-8000-000000000009',
      headers,
    });
    expect(unknown.statusCode).toBe(404);

    const malformed = await app.inject({
      method: 'DELETE',
      url: '/api/v1/auth/tokens/not-a-uuid',
      headers,
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('audit trail for token lifecycle (TDS 03 §3.14, TDS 04 §12)', () => {
  it('records token.created and token.revoked without the token value', async () => {
    const { body } = await createToken({ name: 'cli-laptop', scopes: ['ingest'] });
    await app.inject({
      method: 'DELETE',
      url: `/api/v1/auth/tokens/${body.id}`,
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .orderBy(desc(schema.auditLogEntries.createdAt));

    const created = rows.find((row) => row.action === 'token.created');
    const revoked = rows.find((row) => row.action === 'token.revoked');

    expect(created?.actorType).toBe('user');
    expect(created?.actorId).toBe(user.id);
    expect(created?.entityType).toBe('api_tokens');
    expect(created?.entityId).toBe(body.id);
    expect(created?.after?.['scopes']).toEqual(['ingest']);

    expect(revoked?.entityId).toBe(body.id);
    expect(revoked?.before?.['revokedAt']).toBeNull();
    expect(revoked?.after?.['revokedAt']).toBeTruthy();

    expect(JSON.stringify(rows)).not.toContain(body.token);
  });

  it('records a token-authenticated call as actorType user with the token in the payload', async () => {
    const { body } = await createToken({ name: 'cli-laptop' });

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(logout.statusCode).toBe(204);

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.action, 'auth.logout'));

    expect(rows).toHaveLength(1);
    const entry = rows[0];

    // TDS 04 §12 verbatim: there is no 'token' actor; it is the User acting, with the
    // acting token identified in the payload — and never the token value.
    expect(entry?.actorType).toBe('user');
    expect(entry?.actorId).toBe(user.id);
    expect(entry?.after?.['authMethod']).toBe('token');
    expect(entry?.after?.['apiTokenId']).toBe(body.id);
    expect(entry?.after?.['apiTokenName']).toBe('cli-laptop');
    expect(JSON.stringify(entry)).not.toContain(body.token);
  });
});
