import type { FastifySchema } from 'fastify';
import { bodyPolicyOf } from '../body-strictness.js';
import { queryPolicyOf } from '../query-strictness.js';
import type { ApiRoute } from '../route-table.js';
import type { YamlValue } from './yaml.js';

/**
 * The F5.1 OpenAPI 3.1 document, generated from the live Fastify route table.
 *
 * **Why generated from the route table rather than by `@fastify/swagger`.** Both derive from
 * the same source (the registered routes), so the anti-drift property is identical; the
 * difference is what the output is allowed to say. Three things pushed this to ~200 lines of
 * our own code:
 *
 *  1. **Honesty about what is missing.** No route in this Backend declares a *response* schema
 *     — Fastify serialisation is not used, handlers return plain objects. A generator that
 *     quietly emits `responses: { 200: { description: 'Default Response' } }` (which is what
 *     `@fastify/swagger` does) publishes a document that looks complete and tells the reader
 *     nothing true about the success payload. This one marks every operation
 *     `x-mc-response-schema: undeclared` and says so once, loudly, in `info.description`. A
 *     spec that lies is worse than one that is honestly partial — and the marker is what makes
 *     "declare response schemas" a countable piece of work rather than a vague intention.
 *  2. **No runtime dependency.** `@fastify/swagger` is a plugin registered into the running
 *     server; this is a build-time function over data the server already keeps.
 *  3. **Byte stability.** The document is committed and checked for staleness, so paths,
 *     methods and keys are emitted in a fixed order regardless of registration order.
 *
 * **The schemas pass through verbatim.** OpenAPI 3.1 *is* JSON Schema 2020-12, and every
 * keyword these routes use (`type` incl. the `['string', 'null']` union form, `enum`, `const`,
 * `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`, `items`, `properties`, `required`,
 * `additionalProperties`, `minItems`/`maxItems`, `uniqueItems`) means the same thing in both.
 * No translation layer means no translation bugs — the document says exactly what Ajv enforces.
 *
 * **What it deliberately records beyond the shapes** (`x-mc-*`, all mechanical facts of the
 * route table, none of them invented): the auth policy the guard will apply, the two
 * strictness verdicts from `query-strictness.ts` / `body-strictness.ts`, and any per-route
 * body limit. These are the parts of the contract a caller hits first and cannot discover from
 * the shapes alone.
 */

/** `info.version`. The API itself is versioned in the path (`/api/v1`, F5.2). */
const DOCUMENT_VERSION = '1.0.0';

/** F5.2: every REST route lives under this prefix, and `servers[0].url` carries it. */
const API_BASE_PATH = '/api/v1';

/** Emitted in this order wherever a path has several operations. */
const METHOD_ORDER = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

interface AuthPolicyView {
  readonly mode?: unknown;
  readonly scope?: unknown;
  readonly allowCookie?: unknown;
}

export interface BuildOptions {
  /**
   * Routes Fastify generated rather than a workstream: the automatic `HEAD` sibling of every
   * `GET`. Documenting them would double the path count and describe nothing anyone calls.
   */
  readonly skipHeadRoutes?: boolean;
}

export function buildOpenApiDocument(
  routes: readonly ApiRoute[],
  options: BuildOptions = {},
): YamlValue {
  const skipHead = options.skipHeadRoutes ?? true;

  const apiRoutes = routes
    .filter((route) => route.url.startsWith(`${API_BASE_PATH}/`))
    .filter((route) => !(skipHead && route.method.toUpperCase() === 'HEAD'));

  const paths: Record<string, Record<string, YamlValue>> = {};
  const operationIds = new Map<string, string>();

  for (const route of apiRoutes) {
    const path = openApiPath(route.url);
    const method = route.method.toLowerCase();
    const operation = buildOperation(route, path, method);

    const id = operation['operationId'] as string;
    const clash = operationIds.get(id);
    if (clash !== undefined) {
      // Mechanically derived ids collide only if two different routes share a method and a
      // path shape, which would be a routing bug — better to fail the generator than to emit
      // a document no tool will load.
      throw new Error(`Duplicate operationId "${id}" for ${clash} and ${method} ${path}`);
    }
    operationIds.set(id, `${method} ${path}`);

    const operations = paths[path] ?? {};
    operations[method] = operation;
    paths[path] = operations;
  }

  const sortedPaths: Record<string, YamlValue> = {};
  for (const path of Object.keys(paths).sort()) {
    const operations = paths[path] as Record<string, YamlValue>;
    const ordered: Record<string, YamlValue> = {};
    for (const method of METHOD_ORDER) {
      const operation = operations[method];
      if (operation !== undefined) ordered[method] = operation;
    }
    // Anything outside the canonical order still gets emitted; nothing is dropped silently.
    for (const method of Object.keys(operations).sort()) {
      if (!(method in ordered)) ordered[method] = operations[method] as YamlValue;
    }
    sortedPaths[path] = ordered;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'Mission Control API',
      version: DOCUMENT_VERSION,
      description: DOCUMENT_DESCRIPTION,
    },
    servers: [{ url: API_BASE_PATH }],
    security: [{ cookieAuth: [] }, { bearerAuth: [] }],
    paths: sortedPaths,
    components: COMPONENTS,
  };
}

const DOCUMENT_DESCRIPTION = [
  'Generated from the Backend’s Fastify route table by `pnpm api:spec` (F5.1). Do not edit',
  'by hand: `pnpm api:spec:check` fails when this file and the routes disagree.',
  '',
  'PARTIAL BY CONSTRUCTION, AND HONESTLY SO. Request shapes here are the schemas Ajv actually',
  'enforces, so they are exact. RESPONSE shapes are absent: no route in this Backend declares',
  'a Fastify response schema today, so there is nothing to generate from and nothing is',
  'invented. Every operation is marked `x-mc-response-schema: undeclared`; the response',
  'contracts are prose in docs/tds/04-api-contracts-and-events.md, and §16 of that document',
  'holds the hand-written reference for the Sessions resource.',
  '',
  'Consequence for consumers: types generated from this document cover requests, path and',
  'query parameters, and the error envelope. They do not yet cover success payloads.',
  '',
  'One entry is not an HTTP resource: GET /ws is the single multiplexed WebSocket upgrade',
  'endpoint (F5.6, TDS 04 §14). It is listed because it is a registered route — omitting it',
  'would make this document quietly incomplete — but it speaks the WS frame protocol.',
].join('\n');

function buildOperation(route: ApiRoute, path: string, method: string): Record<string, YamlValue> {
  const schema: FastifySchema | undefined = route.schema;
  const auth = authPolicyOf(route);
  const queryPolicy = queryPolicyOf(route.url, schema);
  const bodyPolicy = bodyPolicyOf(route.url, schema);

  const operation: Record<string, YamlValue> = {
    operationId: operationIdOf(method, route.url),
    summary: `${method.toUpperCase()} ${path}`,
  };

  const parameters = [...pathParameters(route.url, schema), ...queryParameters(schema)];
  if (parameters.length > 0) operation['parameters'] = parameters;

  const body = schema?.body;
  if (isRecord(body)) {
    operation['requestBody'] = {
      // `required` on the *body* means "a body must be sent". A schema with required fields
      // cannot be satisfied by no body at all; one with none can (every field is optional).
      required: Array.isArray(body['required']) && body['required'].length > 0,
      content: { 'application/json': { schema: body as YamlValue } },
    };
  }

  operation['responses'] = {
    default: { $ref: '#/components/responses/ErrorEnvelope' },
  };

  operation['x-mc-response-schema'] = 'undeclared';
  operation['x-mc-auth'] = authExtension(auth);
  operation['x-mc-strictness'] = {
    query: queryPolicy.mode,
    body: bodyPolicy.mode,
    ...(bodyPolicy.openPaths.length > 0 ? { bodyOpenPaths: [...bodyPolicy.openPaths] } : {}),
  };
  if (route.bodyLimitBytes !== undefined) operation['x-mc-body-limit-bytes'] = route.bodyLimitBytes;

  // Per-operation `security` only where it differs from the document default, which is the
  // OpenAPI convention and keeps the exceptions readable.
  if (auth.mode === 'public') operation['security'] = [];
  else if (auth.allowCookie === false) operation['security'] = [{ bearerAuth: [] }];

  return operation;
}

function authPolicyOf(route: ApiRoute): {
  readonly mode: string;
  readonly scope: string;
  readonly allowCookie: boolean;
} {
  const declared = (route.config as { auth?: AuthPolicyView } | undefined)?.auth;
  // `auth/guard.ts`: every route is `FULL_ACCESS_ROUTE` unless it says otherwise. The default
  // is repeated here rather than imported so `openapi/` stays a reader of the route table.
  if (declared === undefined) return { mode: 'authenticated', scope: 'full', allowCookie: true };
  return {
    mode: typeof declared.mode === 'string' ? declared.mode : 'authenticated',
    scope: typeof declared.scope === 'string' ? declared.scope : 'full',
    allowCookie: declared.allowCookie !== false,
  };
}

function authExtension(auth: {
  readonly mode: string;
  readonly scope: string;
  readonly allowCookie: boolean;
}): YamlValue {
  if (auth.mode === 'public') return { mode: 'public' };
  return { mode: auth.mode, scope: auth.scope, allowCookie: auth.allowCookie };
}

/** `/api/v1/sessions/:id/start` -> `/sessions/{id}/start` (path relative to `servers[0].url`). */
export function openApiPath(url: string): string {
  const relative = url.slice(API_BASE_PATH.length);
  return relative
    .split('/')
    .map((segment) => (segment.startsWith(':') ? `{${segment.slice(1)}}` : segment))
    .join('/');
}

/**
 * A deterministic id per route: method + path, parameters folded in as `ById`.
 *
 * Mechanically derived rather than hand-named. TDS 04 §16 uses semantic ids (`startSession`),
 * which cannot be recovered from a URL — and a generator that guessed them would drift from
 * the prose it was imitating. `postSessionsByIdStart` is ugly and unambiguous; ugly and
 * unambiguous is the right trade for a generated identifier.
 */
export function operationIdOf(method: string, url: string): string {
  const segments = url
    .slice(API_BASE_PATH.length)
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => (segment.startsWith(':') ? `by-${segment.slice(1)}` : segment));

  return (
    method.toLowerCase() +
    segments
      .flatMap((segment) => segment.split('-'))
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join('')
  );
}

function pathParameters(url: string, schema: FastifySchema | undefined): YamlValue[] {
  const params = schema?.params;
  const declared = isRecord(params) && isRecord(params['properties']) ? params['properties'] : {};

  return url
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1))
    .map((name) => {
      const parameterSchema = declared[name];
      return {
        name,
        in: 'path',
        required: true,
        schema: isRecord(parameterSchema) ? (parameterSchema as YamlValue) : { type: 'string' },
        ...(isRecord(parameterSchema)
          ? {}
          : // Fail loudly in the document rather than pretending the route validates it.
            { description: 'No params schema is declared for this route; type is assumed.' }),
      };
    });
}

function queryParameters(schema: FastifySchema | undefined): YamlValue[] {
  const querystring = schema?.querystring;
  if (!isRecord(querystring)) return [];
  const properties = querystring['properties'];
  if (!isRecord(properties)) return [];

  const required = new Set(
    Array.isArray(querystring['required']) ? (querystring['required'] as unknown[]) : [],
  );

  return Object.keys(properties)
    .sort()
    .map((name) => ({
      name,
      in: 'query',
      required: required.has(name),
      schema: properties[name] as YamlValue,
    }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The only shape this document can state with certainty: the F5.4 error envelope, which every
 * non-2xx response in the system has (`http/errors.ts`), and the two credentials the guard
 * accepts (`auth/guard.ts`). Both are copied from TDS 04 §16 and verified by
 * `openapi.contract.test.ts` against the code that produces them.
 */
const COMPONENTS: YamlValue = {
  schemas: {
    ErrorEnvelope: {
      type: 'object',
      required: ['error'],
      properties: {
        error: {
          type: 'object',
          required: ['code', 'message', 'details', 'requestId'],
          properties: {
            code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]*$' },
            message: { type: 'string' },
            details: { type: ['object', 'null'] },
            requestId: {
              type: 'string',
              description: 'Also returned as the X-Request-Id header, and in every log line.',
            },
          },
        },
      },
    },
  },
  responses: {
    ErrorEnvelope: {
      description:
        'Any non-2xx response (F5.4). The status code and the `error.code` registry entry ' +
        'carry the meaning; see docs/tds/04-api-contracts-and-events.md §1.3.',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorEnvelope' } } },
    },
  },
  securitySchemes: {
    cookieAuth: { type: 'apiKey', in: 'cookie', name: 'mc_session' },
    bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'mct_ API token' },
  },
};
