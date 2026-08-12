import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

/**
 * These tests run with NO database and NO listening socket — `app.inject()` only
 * (TDS 07 §2.1). That is the point of `GET /api/v1/health`: it proves the process serves
 * HTTP without depending on PostgreSQL.
 */
describe('GET /api/v1/health', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logLevel: 'silent' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with the F5 { data } envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ data: Record<string, unknown> }>();
    expect(Object.keys(body)).toEqual(['data']);
    expect(body.data['status']).toBe('ok');
    expect(typeof body.data['version']).toBe('string');
    expect(typeof body.data['uptimeSeconds']).toBe('number');
    // ISO 8601 UTC with Z suffix (F4.2).
    expect(String(body.data['startedAt'])).toMatch(/Z$/);
  });

  it('returns an X-Request-Id header on every response', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const requestId = response.headers['x-request-id'];

    expect(typeof requestId).toBe('string');
    expect(String(requestId)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('honours an inbound X-Request-Id so correlation survives across processes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-request-id': 'inbound-correlation-id' },
    });

    expect(response.headers['x-request-id']).toBe('inbound-correlation-id');
  });

  it('issues a distinct request id per request', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const second = await app.inject({ method: 'GET', url: '/api/v1/health' });

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});

describe('F5.4 error envelope', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    app = buildApp({ logLevel: 'silent' });
  });

  afterEach(async () => {
    await app.close();
  });

  it('renders unknown routes as NOT_FOUND in the error envelope', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });

    expect(response.statusCode).toBe(404);

    const body = response.json<{
      error: { code: string; message: string; details: unknown; requestId: string };
    }>();

    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error).sort()).toEqual(['code', 'details', 'message', 'requestId']);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toBeNull();
    // requestId in the envelope matches the header — the F5.4 support handle.
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });
});
