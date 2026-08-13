import { readFileSync } from 'node:fs';
import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { buildOpenApiDocument, OPENAPI_DOCUMENT_PATH, renderOpenApiYaml } from './index.js';

/**
 * The F5.1 contract document (`openapi.yaml`) — generated, committed, and checked here.
 *
 * **This test is the staleness guard.** `pnpm api:spec:check` makes the same assertion from the
 * command line for CI, but a check that only runs as a separate CI step is a check someone can
 * add a route without running. This one fails inside `pnpm test`, which is what turns "the spec
 * drifted" into a red test on the change that caused it.
 *
 * The drift it exists to stop is not hypothetical. `apps/frontend/src/lib/api/types.ts` was
 * hand-written against prose and was wrong twice while typechecking cleanly — once declaring
 * `ServiceHealthRow.status` as `'ok' | 'not_configured'` against an API answering
 * `'healthy' | 'disabled'`, once omitting `Repository.lastSyncError` entirely. Generation is
 * what stops a third; this test is what keeps the generated thing true.
 *
 * No database and no socket: the document is a function of the route table, and the `db` handle
 * throws if anything reaches for it (TDS 07 §2.1).
 */
const NO_DATABASE = new Proxy(
  {},
  {
    get() {
      throw new Error('unit tests must not touch the database');
    },
  },
) as Db;

describe('openapi.yaml', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp({ logLevel: 'silent', db: NO_DATABASE });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('is exactly what the current route table generates', () => {
    const committed = readFileSync(OPENAPI_DOCUMENT_PATH, 'utf8');

    // The message matters: whoever sees this failure added or changed a route, and the fix is
    // one command rather than an investigation.
    expect(
      renderOpenApiYaml(app),
      'openapi.yaml is stale — run `pnpm api:spec` and commit it',
    ).toBe(committed);
  });

  it('documents every REST route, and no route Fastify invented', () => {
    const document = buildOpenApiDocument(app.apiRoutes) as {
      paths: Record<string, Record<string, unknown>>;
    };

    const documented = new Set(
      Object.entries(document.paths).flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
      ),
    );

    const expected = new Set(
      app.apiRoutes
        .filter((route) => route.url.startsWith('/api/v1/') && route.method !== 'HEAD')
        .map(
          (route) =>
            `${route.method} ${route.url.slice('/api/v1'.length).replaceAll(/:([^/]+)/g, '{$1}')}`,
        ),
    );

    expect([...documented].sort()).toEqual([...expected].sort());
    // Fastify auto-generates a HEAD sibling for every GET. Documenting them would double the
    // file and describe nothing anyone calls.
    expect([...documented].some((entry) => entry.startsWith('HEAD '))).toBe(false);
  });

  it('claims no response shape it cannot produce', () => {
    const document = buildOpenApiDocument(app.apiRoutes) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    const operations = Object.values(document.paths).flatMap((path) => Object.values(path));
    expect(operations.length).toBeGreaterThan(60);

    for (const operation of operations) {
      // Not one route in this Backend declares a Fastify `response` schema, so the document
      // says so per operation rather than inventing a 200 body. When that changes, this
      // assertion is the reminder that the generator must start emitting the real one.
      expect(operation['x-mc-response-schema']).toBe('undeclared');
      expect(Object.keys(operation['responses'] as object)).toEqual(['default']);
    }
  });

  it('records the auth policy the guard will actually apply', () => {
    const document = buildOpenApiDocument(app.apiRoutes) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    // Public: the login route and the liveness probe, and nothing else (TDS 04 §1.4).
    const publicOperations = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods)
        .filter(([, operation]) => (operation['x-mc-auth'] as { mode: string }).mode === 'public')
        .map(([method]) => `${method.toUpperCase()} ${path}`),
    );
    expect(publicOperations.sort()).toEqual(['GET /health', 'POST /auth/login']);

    // Ingest: bearer only, cookie refused (§6.8) — and the document says so with a per-route
    // `security` override rather than leaving the reader to infer it.
    const ingest = document.paths['/hook-events']?.['post'] as Record<string, unknown>;
    expect(ingest['x-mc-auth']).toEqual({
      mode: 'authenticated',
      scope: 'ingest',
      allowCookie: false,
    });
    expect(ingest['security']).toEqual([{ bearerAuth: [] }]);
  });
});
