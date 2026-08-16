import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

/**
 * Static SPA serving and its deep-link fallback (F2.3, TDS 05 §12).
 *
 * The point of this tier is the *refusals*, not the happy path. Serving a file is the easy half;
 * what makes the fallback safe is that it declines to answer three kinds of request — an
 * unmatched `/api/` path, a non-navigation asset fetch, and anything that is not a GET — because
 * each of those, answered with `index.html`, produces a failure that is diagnosed nowhere near
 * this file.
 *
 * No database and no socket, matching `error-handler.test.ts`: `app.inject()` against a handle
 * that throws on any access, so the DB-free property of this tier is enforced rather than assumed.
 */
const NO_DATABASE = new Proxy(
  {},
  {
    get() {
      throw new Error('unit tests must not touch the database');
    },
  },
) as Db;

const INDEX_HTML = '<!doctype html><title>Mission Control</title><div id="root"></div>';
const BUNDLE_JS = 'export const version = 1;\n';

interface Envelope {
  readonly error: { readonly code: string; readonly requestId: string };
}

describe('the Backend serves the built SPA on the same origin as the API', () => {
  let app: FastifyInstance;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mc-spa-'));
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'index.html'), INDEX_HTML);
    writeFileSync(join(root, 'assets', 'index-abc123.js'), BUNDLE_JS);

    app = buildApp({ logLevel: 'silent', db: NO_DATABASE, spaRoot: root });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves index.html at the root without a session, because that IS the login screen', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
    expect(response.headers['content-type']).toContain('text/html');
  });

  it('serves the root even to a client that sent no Accept header, so a curl check is not a false alarm', async () => {
    const response = await app.inject({ method: 'GET', url: '/', headers: { accept: '*/*' } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  it('serves the root with a query string, which is still the root', async () => {
    const response = await app.inject({ method: 'GET', url: '/?redirect=/sessions' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  it('serves a deep link with the same document, so client-side routing survives a reload', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/sessions/0199a1b2-c3d4-7000-8000-000000000000',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  it('never caches index.html, so a new build is not shadowed by a stale asset map', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });

    expect(response.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
  });

  it('serves hashed assets as immutable, because the hash IS the version', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(BUNDLE_JS);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('leaves an unmatched /api path as an F5.4 envelope, not HTML a client cannot parse', async () => {
    const response = await app.inject({
      method: 'GET',
      // A browser navigating here sends `text/html`; the API prefix must still win.
      url: '/api/v1/sessionz',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json<Envelope>().error.code).toBe('NOT_FOUND');
  });

  it('404s a missing asset rather than answering HTML under a JavaScript content-type', async () => {
    // No `accept: text/html` — this is how a browser asks for a <script>, and answering
    // index.html here is the classic SPA defect that surfaces as an opaque MIME-type error.
    const response = await app.inject({ method: 'GET', url: '/assets/index-deleted.js' });

    expect(response.statusCode).toBe(404);
    expect(response.json<Envelope>().error.code).toBe('NOT_FOUND');
  });

  it('does not answer a POST to an unknown path with the SPA', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/not-a-route',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<Envelope>().error.code).toBe('NOT_FOUND');
  });

  it('still guards the API — the public bundle opens up nothing behind it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/sessions' });

    expect(response.statusCode).toBe(401);
    expect(response.json<Envelope>().error.code).toBe('UNAUTHORIZED');
  });
});

describe('a Backend with no SPA build serves the API and says so', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it('boots instead of refusing, and answers the F5.4 envelope for a navigation', async () => {
    app = buildApp({
      logLevel: 'silent',
      db: NO_DATABASE,
      spaRoot: join(tmpdir(), 'mc-spa-does-not-exist'),
    });
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/',
      headers: { accept: 'text/html' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<Envelope>().error.code).toBe('NOT_FOUND');
  });

  it('is the default: omitting spaRoot leaves the app API-only', async () => {
    app = buildApp({ logLevel: 'silent', db: NO_DATABASE });
    await app.ready();

    expect(app.spaFallback).toBeNull();
  });
});
