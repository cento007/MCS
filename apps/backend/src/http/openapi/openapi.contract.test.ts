import { readFileSync } from 'node:fs';
import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { ERROR_CODES } from '../errors.js';
import type { ApiRoute } from '../route-table.js';
import {
  API_TYPES_PATH,
  buildOpenApiDocument,
  OPENAPI_DOCUMENT_PATH,
  renderApiTypesFor,
  renderOpenApiYaml,
} from './index.js';

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

  /**
   * The operations that deliberately publish no success payload, with the reason each one has.
   *
   * A hard-coded list rather than a threshold: "at most N undeclared" would let the next
   * undeclared route slip in under the count, and the point of the marker is that every remaining
   * gap is a decision someone wrote down.
   */
  const UNDECLARED = new Map<string, string>([
    ['GET /health', 'health/ — owned by another workstream in flight'],
    ['GET /services/health', 'health/ — owned by another workstream in flight'],
    ['GET /schedule', 'schedule/ — owned by another workstream in flight'],
    [
      'GET /settings/{category}',
      'serves one of five different documents; the honest spelling is a `oneOf` the ' +
        'response-conformance checker does not implement',
    ],
    ['PUT /settings/{category}', 'has no success response at all — it exists to answer NOT_FOUND'],
    ['GET /ws', 'the WebSocket upgrade; it speaks the WS frame protocol, not JSON over HTTP'],
  ]);

  it('declares a response for every operation but the six that say why not', () => {
    const document = buildOpenApiDocument(app.apiRoutes) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
    };

    const operations = Object.entries(document.paths).flatMap(([path, methods]) =>
      Object.entries(methods).map(
        ([method, operation]) => [`${method.toUpperCase()} ${path}`, operation] as const,
      ),
    );
    expect(operations.length).toBeGreaterThan(60);

    const undeclared = operations
      .filter(([, operation]) => operation['x-mc-response-schema'] === 'undeclared')
      .map(([name]) => name)
      .sort();

    expect(undeclared).toEqual([...UNDECLARED.keys()].sort());

    for (const [name, operation] of operations) {
      const responses = Object.keys(operation['responses'] as object);
      // Every operation carries the F5.4 error envelope; a declared one also carries at least one
      // success status.
      expect(responses).toContain('default');
      if (UNDECLARED.has(name)) {
        expect(responses).toEqual(['default']);
      } else {
        expect(responses.length).toBeGreaterThan(1);
      }
    }
  });

  it('types error.code as the registry itself, not as a spelling rule', () => {
    const document = buildOpenApiDocument(app.apiRoutes) as {
      components: { schemas: Record<string, Record<string, unknown>> };
    };

    const code = document.components.schemas['ErrorEnvelopeCode'] as { enum?: unknown };
    // A pattern (`^[A-Z][A-Z0-9_]*$`) typed the shape of a code and said nothing about which
    // codes exist, so a client switching on `error.code` got no help from the contract.
    expect(code.enum).toEqual([...Object.keys(ERROR_CODES)].sort());

    const envelope = document.components.schemas['ErrorEnvelope'] as {
      properties: { error: { properties: { code: { $ref?: string } } } };
    };
    expect(envelope.properties.error.properties.code.$ref).toBe(
      '#/components/schemas/ErrorEnvelopeCode',
    );
  });

  it('hoists every named schema into components, and refuses to reuse a name for two shapes', () => {
    const document = buildOpenApiDocument(app.apiRoutes) as {
      components: { schemas: Record<string, unknown> };
    };

    // A spot check that the resources whose drift already hurt are named components rather than
    // inline blobs — a `$ref` is what gives the generated client type its name.
    for (const name of ['Session', 'Agent', 'AgentTeam', 'AgentWorkflow', 'AgentWorkflowRun']) {
      expect(Object.keys(document.components.schemas)).toContain(name);
    }

    // And the collision guard itself: two different shapes under one title must throw rather than
    // silently publish whichever was registered first.
    const clashing: ApiRoute[] = [
      {
        method: 'GET',
        url: '/api/v1/first',
        schema: { response: { 200: { title: 'Clash', type: 'object', properties: {} } } },
        config: undefined,
        bodyLimitBytes: undefined,
      },
      {
        method: 'GET',
        url: '/api/v1/second',
        schema: {
          response: {
            200: { title: 'Clash', type: 'object', properties: { extra: { type: 'string' } } },
          },
        },
        config: undefined,
        bodyLimitBytes: undefined,
      },
    ];
    expect(() => buildOpenApiDocument(clashing)).toThrow(/both titled "Clash"/);
  });

  it('generates client types the SPA can import by name', () => {
    const types = renderApiTypesFor(app);

    // The field whose absence from the hand-written copy made the entire Phase 4 agent binding
    // unreachable from the browser. Generated, it cannot go missing without the Backend failing
    // to compile.
    const session = types.slice(types.indexOf('export interface Session {'));
    expect(session.slice(0, session.indexOf('\n}'))).toContain('readonly agentId: string | null;');
    expect(types).toContain('export interface Agent {');
    expect(types).toContain('export interface AgentTeam {');
    expect(types).toContain('export interface AgentWorkflowRun {');
    expect(types).toContain('GENERATED FILE — DO NOT EDIT.');
  });

  it('is exactly what the committed generated types file contains', () => {
    const committed = readFileSync(API_TYPES_PATH, 'utf8');
    expect(
      renderApiTypesFor(app),
      'types.generated.ts is stale — run `pnpm api:spec` and commit it',
    ).toBe(committed);
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
