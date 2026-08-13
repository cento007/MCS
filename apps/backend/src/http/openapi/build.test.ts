import { describe, expect, it } from 'vitest';
import type { ApiRoute } from '../route-table.js';
import { buildOpenApiDocument, openApiPath, operationIdOf } from './build.js';

/**
 * The mechanical half of the generator (`build.ts`) — route table in, OpenAPI object out.
 *
 * Driven by synthetic routes rather than the real app so each translation rule is asserted on
 * its own; `openapi.contract.test.ts` covers the real table and the committed document.
 */

function route(partial: Partial<ApiRoute> & Pick<ApiRoute, 'method' | 'url'>): ApiRoute {
  return { schema: undefined, config: undefined, bodyLimitBytes: undefined, ...partial };
}

type Document = {
  paths: Record<string, Record<string, Record<string, unknown>>>;
};

describe('openApiPath', () => {
  it('strips the base path and converts Fastify parameters to OpenAPI templates', () => {
    expect(openApiPath('/api/v1/sessions')).toBe('/sessions');
    expect(openApiPath('/api/v1/sessions/:id/start')).toBe('/sessions/{id}/start');
    expect(openApiPath('/api/v1/repositories/:id/pull-requests')).toBe(
      '/repositories/{id}/pull-requests',
    );
  });
});

describe('operationIdOf', () => {
  it('derives a deterministic id from the method and the path', () => {
    expect(operationIdOf('GET', '/api/v1/sessions')).toBe('getSessions');
    expect(operationIdOf('post', '/api/v1/sessions/:id/start')).toBe('postSessionsByIdStart');
    expect(operationIdOf('get', '/api/v1/audit-log-entries')).toBe('getAuditLogEntries');
    expect(operationIdOf('put', '/api/v1/settings/integrations/claude-code')).toBe(
      'putSettingsIntegrationsClaudeCode',
    );
  });
});

describe('buildOpenApiDocument', () => {
  it('documents only `/api/v1` routes, and skips the HEAD siblings Fastify generates', () => {
    const document = buildOpenApiDocument([
      route({ method: 'GET', url: '/api/v1/health' }),
      route({ method: 'HEAD', url: '/api/v1/health' }),
      // The SPA artifact and its deep-link fallback (F2.3) are not part of the API contract.
      route({ method: 'GET', url: '/*' }),
    ]) as Document;

    expect(Object.keys(document.paths)).toEqual(['/health']);
    expect(Object.keys(document.paths['/health'] as object)).toEqual(['get']);
  });

  it('sorts paths and orders the methods of a path, so the file is diff-stable', () => {
    const document = buildOpenApiDocument([
      route({ method: 'DELETE', url: '/api/v1/projects/:id' }),
      route({ method: 'GET', url: '/api/v1/sessions' }),
      route({ method: 'PATCH', url: '/api/v1/projects/:id' }),
      route({ method: 'GET', url: '/api/v1/projects/:id' }),
    ]) as Document;

    expect(Object.keys(document.paths)).toEqual(['/projects/{id}', '/sessions']);
    expect(Object.keys(document.paths['/projects/{id}'] as object)).toEqual([
      'get',
      'patch',
      'delete',
    ]);
  });

  it('emits path parameters from the URL, typed from the route params schema', () => {
    const document = buildOpenApiDocument([
      route({
        method: 'GET',
        url: '/api/v1/sessions/:id',
        schema: {
          params: {
            type: 'object',
            properties: { id: { type: 'string', pattern: '^u' } },
          },
        },
      }),
    ]) as Document;

    expect(
      (document.paths['/sessions/{id}'] as Record<string, Record<string, unknown>>)['get']?.[
        'parameters'
      ],
    ).toEqual([
      { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^u' } },
    ]);
  });

  it('still declares an undeclared path parameter, and says it is assumed', () => {
    // OpenAPI requires every template variable to be declared. Inventing `type: string` in
    // silence would read as "the route validates this"; it does not, and the description says so.
    const document = buildOpenApiDocument([
      route({ method: 'GET', url: '/api/v1/things/:thingId' }),
    ]) as Document;

    const [parameter] = (document.paths['/things/{thingId}']?.['get']?.['parameters'] ??
      []) as Record<string, unknown>[];
    expect(parameter?.['name']).toBe('thingId');
    expect(parameter?.['schema']).toEqual({ type: 'string' });
    expect(String(parameter?.['description'])).toContain('assumed');
  });

  it('emits query parameters in a fixed order with their schemas verbatim', () => {
    const document = buildOpenApiDocument([
      route({
        method: 'GET',
        url: '/api/v1/sessions',
        schema: {
          querystring: {
            type: 'object',
            additionalProperties: false,
            required: ['state'],
            properties: {
              state: { type: 'string', enum: ['running'] },
              limit: { type: 'integer', minimum: 1, maximum: 200 },
            },
          },
        },
      }),
    ]) as Document;

    expect(document.paths['/sessions']?.['get']?.['parameters']).toEqual([
      {
        name: 'limit',
        in: 'query',
        required: false,
        schema: { type: 'integer', minimum: 1, maximum: 200 },
      },
      { name: 'state', in: 'query', required: true, schema: { type: 'string', enum: ['running'] } },
    ]);
  });

  it('marks the body required only when the schema has a required field', () => {
    const document = buildOpenApiDocument([
      route({
        method: 'POST',
        url: '/api/v1/sessions',
        schema: { body: { type: 'object', required: ['projectId'], properties: {} } },
      }),
      route({
        method: 'PATCH',
        url: '/api/v1/sessions/:id',
        schema: { body: { type: 'object', properties: { title: { type: 'string' } } } },
      }),
    ]) as Document;

    const created = document.paths['/sessions']?.['post']?.['requestBody'] as Record<
      string,
      unknown
    >;
    const patched = document.paths['/sessions/{id}']?.['patch']?.['requestBody'] as Record<
      string,
      unknown
    >;

    expect(created['required']).toBe(true);
    expect(patched['required']).toBe(false);
  });

  it('omits requestBody entirely for a route that declares no body schema', () => {
    const document = buildOpenApiDocument([
      route({ method: 'POST', url: '/api/v1/sessions/:id/start' }),
    ]) as Document;

    const operation = document.paths['/sessions/{id}/start']?.['post'] as Record<string, unknown>;
    expect('requestBody' in operation).toBe(false);
    // …and the reader is told the route accepts no fields, which is a real part of the contract
    // now that the body guard enforces it.
    expect(operation['x-mc-strictness']).toEqual({ query: 'strict', body: 'strict' });
  });

  it('publishes the body opt-out rather than hiding it', () => {
    const document = buildOpenApiDocument([
      route({
        method: 'POST',
        url: '/api/v1/hook-events',
        schema: {
          body: {
            type: 'object',
            additionalProperties: true,
            properties: { payload: { type: 'object', additionalProperties: true } },
          },
        },
      }),
    ]) as Document;

    expect(document.paths['/hook-events']?.['post']?.['x-mc-strictness']).toEqual({
      query: 'strict',
      body: 'open',
      bodyOpenPaths: ['', 'payload'],
    });
  });

  it('refuses to emit a document with a duplicate operationId', () => {
    expect(() =>
      buildOpenApiDocument([
        route({ method: 'GET', url: '/api/v1/sessions/:id' }),
        route({ method: 'GET', url: '/api/v1/sessions/:sessionId' }),
      ]),
    ).not.toThrow();

    expect(() =>
      buildOpenApiDocument([
        route({ method: 'GET', url: '/api/v1/things' }),
        route({ method: 'GET', url: '/api/v1/Things' }),
      ]),
    ).toThrow(/Duplicate operationId/);
  });
});
