import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { queryPolicyOf, unknownQueryParameters } from './query-strictness.js';

/**
 * Query-parameter strictness (`query-strictness.ts`).
 *
 * The defect this closes is silent: Fastify's Ajv runs `removeAdditional: true`, so
 * `?actor=me` on the audit log and `?stat=running` on Sessions were **deleted before the
 * handler ran** and answered `200` with everything. A filter the operator believes is applied
 * and is not is worse than a rejected request, so an unknown parameter is now a 400.
 *
 * No database and no socket — `app.inject()` with a handle that throws on any access, so the
 * DB-free property of this tier is enforced rather than assumed (TDS 07 §2.1). Everything
 * asserted here happens in `preValidation`, before any handler can reach for data.
 */
const NO_DATABASE = new Proxy(
  {},
  {
    get() {
      throw new Error('unit tests must not touch the database');
    },
  },
) as Db;

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details: Record<string, unknown> | null;
    readonly requestId: string;
  };
}

describe('queryPolicyOf', () => {
  it('takes the allowlist from the route schema, sorted', () => {
    const policy = queryPolicyOf('/api/v1/sessions', {
      querystring: {
        type: 'object',
        additionalProperties: false,
        properties: { state: {}, limit: {}, cursor: {} },
      },
    });

    expect(policy.mode).toBe('strict');
    expect(policy.allowed).toEqual(['cursor', 'limit', 'state']);
  });

  it('accepts nothing when a route declares no querystring schema — fail closed', () => {
    // This is the property that makes the guard un-forgettable: a route added tomorrow with no
    // query schema rejects query parameters instead of swallowing them.
    expect(queryPolicyOf('/api/v1/sessions/:id/start', {})).toEqual({
      mode: 'strict',
      allowed: [],
    });
    expect(queryPolicyOf('/api/v1/sessions/:id/start', undefined)).toEqual({
      mode: 'strict',
      allowed: [],
    });
  });

  it('honours an explicit opt-out, and only an explicit one', () => {
    expect(
      queryPolicyOf('/api/v1/anything', {
        querystring: { type: 'object', additionalProperties: true },
      }).mode,
    ).toBe('open');
    expect(
      queryPolicyOf('/api/v1/anything', {
        querystring: { type: 'object', additionalProperties: false },
      }).mode,
    ).toBe('strict');
  });

  it('leaves non-API routes alone — the SPA deep-link fallback owns its own query string', () => {
    expect(queryPolicyOf('/login', undefined).mode).toBe('unguarded');
    expect(queryPolicyOf('/*', undefined).mode).toBe('unguarded');
  });
});

describe('unknownQueryParameters', () => {
  it('names every parameter the route did not declare', () => {
    expect(unknownQueryParameters('/api/v1/sessions?limit=5&stat=running&x=1', ['limit'])).toEqual([
      'stat',
      'x',
    ]);
  });

  it('is quiet when there is nothing to report', () => {
    expect(unknownQueryParameters('/api/v1/sessions', ['limit'])).toEqual([]);
    expect(unknownQueryParameters('/api/v1/sessions?', ['limit'])).toEqual([]);
    expect(unknownQueryParameters('/api/v1/sessions?limit=5&limit=6', ['limit'])).toEqual([]);
    expect(unknownQueryParameters(undefined, ['limit'])).toEqual([]);
  });

  it('reads the RAW url, which is the only place a stripped name survives', () => {
    expect(unknownQueryParameters('/api/v1/audit-log-entries?actor=me', ['action'])).toEqual([
      'actor',
    ]);
  });
});

describe('the guard, through the real app', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logLevel: 'silent', db: NO_DATABASE });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers 400 VALIDATION_FAILED and names the parameter', async () => {
    // `/api/v1/health` is public (no auth) and declares no query parameters, so it exercises
    // both halves at once: fail-closed allowlist, and a 400 raised before the handler.
    const response = await app.inject({ method: 'GET', url: '/api/v1/health?verbose=1' });

    expect(response.statusCode).toBe(400);

    const body = response.json<Envelope>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toContain('verbose');
    expect(body.error.details).toMatchObject({ unknownParameters: ['verbose'] });
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('lists the parameters the route does accept, so the typo is self-correcting', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login?redirect=/x' });

    expect(response.statusCode).toBe(400);
    expect(response.json<Envelope>().error.details).toEqual({
      unknownParameters: ['redirect'],
      allowedParameters: [],
    });
  });

  it('leaves a clean request alone', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    expect(response.statusCode).toBe(200);
  });

  it('still answers 401 first — the guard never confirms a route to an anonymous caller', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/sessions?stat=running' });

    expect(response.statusCode).toBe(401);
    expect(response.json<Envelope>().error.code).toBe('UNAUTHORIZED');
  });

  it('still answers 404 for a route that does not exist', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nope?whatever=1' });

    expect(response.statusCode).toBe(404);
    expect(response.json<Envelope>().error.code).toBe('NOT_FOUND');
  });

  /**
   * The regression that matters most: **not** a list of routes maintained by hand, but the
   * actual route table. A route registered tomorrow appears here without anyone remembering
   * this file, and the only way to leave `strict` is to write `additionalProperties: true` in
   * the route — which is what this assertion exists to surface in review.
   */
  it('holds every registered API route to the allowlist', async () => {
    await app.ready();

    const apiRoutes = app.queryParameterPolicies.filter((route) => route.url.startsWith('/api/'));
    const openedUp = apiRoutes.filter((route) => route.mode !== 'strict');

    expect(apiRoutes.length).toBeGreaterThan(30);
    expect(openedUp).toEqual([]);
  });

  it('covers the routes the two gaps in this change added', async () => {
    await app.ready();

    const allowed = (method: string, url: string): readonly string[] | undefined =>
      app.queryParameterPolicies.find((route) => route.method === method && route.url === url)
        ?.allowed;

    expect(allowed('GET', '/api/v1/repositories/:id/commits')).toEqual([
      'branch',
      'cursor',
      'limit',
      'order',
      'sessionId',
    ]);
    expect(allowed('GET', '/api/v1/commits/:id')).toEqual([]);
    expect(allowed('GET', '/api/v1/repositories/:id/pull-requests')).toEqual([
      'cursor',
      'limit',
      'state',
    ]);
    expect(allowed('GET', '/api/v1/pull-requests')).toEqual([
      'cursor',
      'limit',
      'repositoryId',
      'state',
    ]);
    expect(allowed('GET', '/api/v1/pull-requests/:id')).toEqual([]);
  });
});
