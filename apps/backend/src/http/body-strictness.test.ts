import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { bodyPolicyOf, unknownBodyFields } from './body-strictness.js';

/**
 * Request-body strictness (`body-strictness.ts`).
 *
 * The defect this closes is silent and confirmed live: Fastify's Ajv runs
 * `removeAdditional: true`, so `PATCH /sessions/{id} { "titel": … }` answered **200 with the
 * resource unchanged**, and `POST /sessions` dropped a mistyped `repositoryId` while answering
 * 201. An instruction the caller believes was carried out and was not is worse than a rejected
 * request, so an unknown field is now a 400.
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

describe('bodyPolicyOf', () => {
  it('takes the allowlist from the route schema, sorted', () => {
    const policy = bodyPolicyOf('/api/v1/sessions', {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          projectId: { type: 'string' },
          notes: { type: ['string', 'null'] },
        },
      },
    });

    expect(policy.mode).toBe('strict');
    expect(policy.allowed).toEqual(['notes', 'projectId', 'title']);
    expect(policy.openPaths).toEqual([]);
  });

  it('accepts nothing when a route declares no body schema — fail closed', () => {
    // The property that makes the guard un-forgettable: a route added tomorrow with no body
    // schema rejects fields instead of swallowing them.
    expect(bodyPolicyOf('/api/v1/sessions/:id/start', {})).toEqual({
      mode: 'strict',
      allowed: [],
      openPaths: [],
    });
    expect(bodyPolicyOf('/api/v1/sessions/:id/start', undefined)).toEqual({
      mode: 'strict',
      allowed: [],
      openPaths: [],
    });
  });

  it('treats a declared `properties` list as the allowlist even without additionalProperties', () => {
    // The settings write schemas are spelled this way on purpose (see `writeSchemaFor`): they
    // omit `additionalProperties: false` precisely because Ajv would then *delete* the unknown
    // field. Undeclared means unaccepted here.
    expect(
      bodyPolicyOf('/api/v1/settings/general', {
        body: {
          type: 'object',
          properties: { instanceName: { type: 'string' }, timezone: { type: 'string' } },
        },
      }),
    ).toEqual({ mode: 'strict', allowed: ['instanceName', 'timezone'], openPaths: [] });
  });

  it('counts a field declared as the empty schema as unenforced, because it is', () => {
    // `{ }` is JSON Schema for "any value", so a field spelled that way accepts an object with
    // any contents. No route does this today; the point is that if one did, it would show up
    // in `openPaths` and in the coverage test rather than passing for strict.
    expect(
      bodyPolicyOf('/api/v1/anything', {
        body: { type: 'object', additionalProperties: false, properties: { input: {} } },
      }).openPaths,
    ).toEqual(['input']);
  });

  it('honours an explicit opt-out, and reports every location that took one', () => {
    const policy = bodyPolicyOf('/api/v1/hook-events', {
      body: {
        type: 'object',
        additionalProperties: true,
        properties: {
          hookEventName: { type: 'string' },
          payload: { type: 'object', additionalProperties: true },
        },
      },
    });

    expect(policy.mode).toBe('open');
    // The nested opt-out is listed too — an escape hatch three levels down would otherwise be
    // invisible to review and to the coverage test.
    expect(policy.openPaths).toEqual(['', 'payload']);
  });

  it('reads a composition keyword as unenforceable, and says so out loud', () => {
    // We are not a validator: which branch of a `oneOf` applies is Ajv's business. Reporting
    // the location as open is the honest answer, and it fails the coverage test until someone
    // decides deliberately.
    expect(bodyPolicyOf('/api/v1/anything', { body: { oneOf: [{ type: 'object' }] } }).mode).toBe(
      'open',
    );
    expect(
      bodyPolicyOf('/api/v1/anything', {
        body: { type: 'object', properties: { a: { anyOf: [{ type: 'object' }] } } },
      }).openPaths,
    ).toEqual(['a']);
  });

  it('reads a bare `{ type: object }` as JSON Schema does — any object', () => {
    expect(bodyPolicyOf('/api/v1/anything', { body: { type: 'object' } }).mode).toBe('open');
    expect(
      bodyPolicyOf('/api/v1/anything', { body: { type: 'object', additionalProperties: false } })
        .mode,
    ).toBe('strict');
  });

  it('leaves non-API routes alone — the SPA artifact is not part of the contract', () => {
    expect(bodyPolicyOf('/login', undefined).mode).toBe('unguarded');
    expect(bodyPolicyOf('/*', undefined).mode).toBe('unguarded');
  });
});

describe('unknownBodyFields', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      title: { type: 'string' },
      dailyReport: {
        type: 'object',
        additionalProperties: false,
        properties: { enabled: { type: 'boolean' }, time: { type: 'string' } },
      },
    },
  };

  it('names every field the schema did not declare, with its siblings', () => {
    expect(unknownBodyFields({ titel: 'x', nope: 1 }, schema)).toEqual([
      { path: 'titel', allowed: ['dailyReport', 'title'] },
      { path: 'nope', allowed: ['dailyReport', 'title'] },
    ]);
  });

  it('walks nested objects, where a dropped field is a reset to default', () => {
    // `PUT /settings/notifications { dailyReport: { enabl: true } }` used to strip `enabl`,
    // after which `normalize` read `enabled` as absent and wrote the DEFAULT back. The write
    // planner only ever checked top-level names, so this walk is the only thing in front of it.
    expect(unknownBodyFields({ dailyReport: { enabl: true } }, schema)).toEqual([
      { path: 'dailyReport.enabl', allowed: ['dailyReport.enabled', 'dailyReport.time'] },
    ]);
  });

  it('is quiet about a clean body, an absent body, and a null body', () => {
    expect(unknownBodyFields({ title: 'x', dailyReport: { enabled: true } }, schema)).toEqual([]);
    expect(unknownBodyFields(undefined, schema)).toEqual([]);
    expect(unknownBodyFields(null, schema)).toEqual([]);
    expect(unknownBodyFields({}, undefined)).toEqual([]);
  });

  it('leaves values to Ajv — only names are judged here', () => {
    // A declared field with an unusable value already fails closed; that is not this guard's
    // business, and reporting it here would name the wrong problem.
    expect(unknownBodyFields({ title: 42 }, schema)).toEqual([]);
    expect(unknownBodyFields({ title: { nested: 1 } }, schema)).toEqual([]);
  });

  it('rejects every field when no schema was declared at all', () => {
    expect(unknownBodyFields({ model: 'opus' }, undefined)).toEqual([
      { path: 'model', allowed: [] },
    ]);
  });

  it('accepts everything under a location that opted out', () => {
    const open = {
      type: 'object',
      additionalProperties: true,
      properties: { payload: { type: 'object', additionalProperties: true } },
    };
    expect(unknownBodyFields({ anything: 1, payload: { deep: { deeper: true } } }, open)).toEqual(
      [],
    );
  });

  it('walks array elements when the schema says what an element is', () => {
    const withItems = {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { path: {} } },
        },
      },
    };

    expect(unknownBodyFields({ files: [{ path: 'a' }, { pth: 'b' }] }, withItems)).toEqual([
      { path: 'files[1].pth', allowed: ['files[1].path'] },
    ]);
  });

  it('stops reporting after twenty fields, so a hostile body cannot buy a large answer', () => {
    const body = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`f${i}`, i]));
    expect(unknownBodyFields(body, schema)).toHaveLength(20);
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

  it('answers 400 VALIDATION_FAILED and names the field', async () => {
    // `POST /auth/login` is public (no auth) and fully schema'd, so it exercises both halves at
    // once: the allowlist, and a 400 raised before the handler ever runs.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'operator', password: 'x', remember: true },
    });

    expect(response.statusCode).toBe(400);

    const body = response.json<Envelope>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toBe('Unknown body field: remember');
    expect(body.error.details).toEqual({
      unknownFields: ['remember'],
      allowedFields: ['password', 'username'],
    });
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('leaves a clean body alone', async () => {
    // The credentials are wrong, which is the point: it got past the guard to the handler.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'nobody', password: 'wrong' },
    });

    expect(response.statusCode).not.toBe(400);
  });

  it('still answers 401 first — the guard never confirms a route to an anonymous caller', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/sessions/0198f0a0-0000-7000-8000-000000000000',
      payload: { titel: 'typo' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<Envelope>().error.code).toBe('UNAUTHORIZED');
  });

  it('still answers 404 for a route that does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/nope',
      payload: { whatever: 1 },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<Envelope>().error.code).toBe('NOT_FOUND');
  });

  /**
   * The regression that matters most: **not** a list of routes maintained by hand, but the
   * actual route table. A route registered tomorrow appears here without anyone remembering
   * this file, and the only way to leave `strict` is to write the opt-out into the route —
   * which is what this assertion exists to surface in review.
   */
  it('holds every registered API route to its allowlist, with two named exceptions', async () => {
    await app.ready();

    const openedUp = app.bodyFieldPolicies
      .filter((route) => route.url.startsWith('/api/'))
      .filter((route) => route.mode !== 'strict' || route.openPaths.length > 0)
      .map((route) => `${route.method} ${route.url} [${route.openPaths.join(', ')}]`);

    expect(app.bodyFieldPolicies.length).toBeGreaterThan(30);
    expect(openedUp.sort()).toEqual([
      // F1.5: Claude Code owns this body's shape and adds fields between versions. A strict
      // schema would turn a runtime upgrade into a wall of 400s in the operator's terminal.
      'POST /api/v1/hook-events [, payload]',
      // The parametric settings fallback only ever answers 404 for the *category*; complaining
      // about the fields of a resource that does not exist would name the wrong problem.
      'PUT /api/v1/settings/:category []',
    ]);
  });
});
