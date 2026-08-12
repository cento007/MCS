import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

/**
 * Regression cover for the F5.4 error handler's treatment of *framework* rejections.
 *
 * Fastify raises a class of errors before any handler runs — an empty body under a JSON
 * content-type, malformed JSON, an unsupported media type — and stamps a real 4xx
 * `statusCode` on each. Those used to fall through to the unclassified branch and answer
 * `500 INTERNAL`, which told the caller "the server broke" about a request only they could
 * fix. It was found in the wild: `POST /sessions/{id}/start` with an empty JSON body
 * answered 500 while the underlying error carried `statusCode: 400`.
 *
 * No database and no socket — `app.inject()` only, with a handle that throws on any access
 * so the DB-free property of this tier is enforced rather than assumed.
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

describe('the F5.4 error handler maps framework rejections to their own status', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logLevel: 'silent', db: NO_DATABASE });
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers 400, not 500, for an empty body under a JSON content-type', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '',
    });

    expect(response.statusCode).toBe(400);

    const body = response.json<Envelope>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    // The framework's message describes the malformed request and leaks no internals, so it
    // is passed through — the caller needs to know *what* was wrong, not just that it was.
    expect(body.error.message).toMatch(/body cannot be empty/i);
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('answers 400, not 500, for malformed JSON', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{"username": "operator",',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<Envelope>().error.code).toBe('VALIDATION_FAILED');
  });

  it('keeps the envelope closed — every rejection carries a registry code and a requestId', async () => {
    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '',
      }),
      app.inject({ method: 'GET', url: '/api/v1/no-such-route' }),
    ]);

    for (const response of responses) {
      const body = response.json<Envelope>();
      expect(body.error.code).toMatch(/^[A-Z][A-Z_]*$/);
      expect(body.error.requestId).toBeTruthy();
      expect(body.error).toHaveProperty('details');
      // A client error must never be reported as a server fault.
      expect(response.statusCode).toBeLessThan(500);
    }
  });
});
