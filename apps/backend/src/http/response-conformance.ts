/**
 * Response conformance — the runtime half of the anti-drift argument in `response-schema.ts`.
 *
 * The response schemas this Backend declares are inert on the wire (the serializer never uses
 * them, so nothing can be stripped). That safety has a cost: a schema nothing enforces is a
 * schema nothing keeps true, and a *wrong* published contract is only marginally better than an
 * absent one. This module is what pays it back — every reply produced while conformance checking
 * is on is validated against the schema its route declares, in **both** directions:
 *
 *   - a property the handler emitted and the schema does not declare  -> `undeclared property`
 *   - a property the schema requires and the handler did not emit     -> `missing required`
 *   - a value outside the declared `type` / `enum`                    -> `expected …`
 *
 * The first of those is the one that matters most: it is exactly the field that
 * `fast-json-stringify` would have deleted in production, surfaced as a test failure instead.
 *
 * ## Where it runs
 *
 * On by default under `NODE_ENV=test`, which is what Vitest sets — so the unit tier's
 * `app.inject()` suites and the whole integration tier check every response they happen to
 * produce, with no per-test opt-in and nothing to remember. `MC_VALIDATE_RESPONSES=on|off`
 * overrides in either direction; production defaults to `off` because a schema bug must never be
 * able to turn a good reply into a 500 on the operator's own dashboard.
 *
 * ## Why hand-written rather than Ajv
 *
 * Ajv is present only as a transitive dependency of Fastify, and adding it as a direct one to
 * validate a nine-keyword subset would be a heavier answer than the question. The subset is
 * closed and the checker rejects any keyword outside it, so a schema this cannot check is a
 * failing test rather than a rule that silently does nothing — the same standard
 * `auth/routes.ts` applies to `format: 'date-time'`. `yaml.ts` and `openapi/build.ts` are here
 * for the same reason.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';
import type { ResponseSchema } from './response-schema.js';

/** Every keyword this checker understands. Anything else in a schema is an error. */
const KNOWN_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'title',
  'description',
]);

export interface ConformanceIssue {
  /** JSON-pointer-ish path from the response root, e.g. `data.runtime.model`. */
  readonly path: string;
  readonly message: string;
}

/**
 * Check `value` against `schema`. Returns every issue found, not just the first: a response that
 * drifted usually drifted in more than one place, and reporting one field per run turns a
 * five-minute fix into five runs.
 */
export function checkResponse(value: unknown, schema: ResponseSchema): readonly ConformanceIssue[] {
  const issues: ConformanceIssue[] = [];
  walk(value, schema, '', issues);
  return issues;
}

function walk(value: unknown, schema: ResponseSchema, path: string, issues: ConformanceIssue[]) {
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN_KEYWORDS.has(keyword)) {
      issues.push({
        path,
        message: `schema uses the keyword "${keyword}", which the conformance checker does not implement`,
      });
    }
  }

  const types = typesOf(schema);
  const actual = jsonTypeOf(value);

  if (types !== null && !types.some((type) => matchesType(actual, type))) {
    issues.push({ path, message: `expected ${types.join(' | ')}, got ${actual}` });
    // Nothing below can be meaningful once the type is wrong; reporting the same node's
    // properties as "missing" would bury the one issue that explains all of them.
    return;
  }

  const allowed = schema['enum'];
  if (Array.isArray(allowed) && !allowed.some((option) => option === value)) {
    issues.push({
      path,
      message: `${JSON.stringify(value)} is not one of ${allowed.map((o) => JSON.stringify(o)).join(', ')}`,
    });
  }

  if ('const' in schema && schema['const'] !== value) {
    issues.push({ path, message: `expected the constant ${JSON.stringify(schema['const'])}` });
  }

  if (Array.isArray(value)) {
    const items = schema['items'];
    if (isSchema(items)) {
      value.forEach((element, index) => {
        walk(element, items, `${path}[${index}]`, issues);
      });
    }
    return;
  }

  if (isPlainObject(value)) {
    checkObject(value, schema, path, issues);
  }
}

function checkObject(
  value: Record<string, unknown>,
  schema: ResponseSchema,
  path: string,
  issues: ConformanceIssue[],
) {
  const properties = isPlainObject(schema['properties'])
    ? (schema['properties'] as Record<string, unknown>)
    : {};
  const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const open = schema['additionalProperties'] !== false;

  for (const name of required) {
    // `undefined` is indistinguishable from absent once the reply is JSON — `JSON.stringify`
    // drops it — so both read as missing here.
    if (value[name] === undefined) {
      issues.push({ path: join(path, name), message: 'missing required property' });
    }
  }

  for (const [name, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const childSchema = properties[name];
    if (isSchema(childSchema)) {
      walk(child, childSchema, join(path, name), issues);
      continue;
    }
    if (!open) {
      // The whole reason this module exists: this is the property a schema-driven serializer
      // would have deleted without telling anyone.
      issues.push({
        path: join(path, name),
        message: 'undeclared property — the response carries a field the schema does not declare',
      });
    }
  }
}

function join(path: string, name: string): string {
  return path.length === 0 ? name : `${path}.${name}`;
}

function typesOf(schema: ResponseSchema): readonly string[] | null {
  const type = schema['type'];
  if (typeof type === 'string') return [type];
  if (Array.isArray(type) && type.every((entry) => typeof entry === 'string')) {
    return type as string[];
  }
  return null;
}

function matchesType(actual: string, expected: string): boolean {
  // JSON Schema's `number` admits integers; `integer` does not admit fractions.
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  return actual === expected;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'object':
      return 'object';
    default:
      return typeof value;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSchema(value: unknown): value is ResponseSchema {
  return isPlainObject(value);
}

// ---------------------------------------------------------------------------- the Fastify hook

export type ConformanceMode = 'on' | 'off';

/**
 * `MC_VALIDATE_RESPONSES` wins; otherwise on under `NODE_ENV=test` and off everywhere else.
 *
 * Deliberately *not* on in development: the operator's dev server must not start answering 500s
 * because a schema is behind its serializer. Development gets the same protection through
 * `pnpm test`, where the failure costs nothing.
 */
export function conformanceModeFromEnv(env: NodeJS.ProcessEnv = process.env): ConformanceMode {
  const explicit = env['MC_VALIDATE_RESPONSES'];
  if (explicit === 'on' || explicit === '1' || explicit === 'true') return 'on';
  if (explicit === 'off' || explicit === '0' || explicit === 'false') return 'off';
  return env['NODE_ENV'] === 'test' ? 'on' : 'off';
}

/**
 * Thrown when a reply does not match the schema its route publishes.
 *
 * An `ApiError` rather than a bare `Error`, so the issue list rides out in the F5.4 envelope's
 * `details` instead of being swallowed by the error handler's "log everything, disclose nothing"
 * branch. Disclosure is not a concern: this is only ever constructed while conformance checking is
 * on, which is the test tiers.
 */
export class ResponseConformanceError extends ApiError {
  readonly issues: readonly ConformanceIssue[];

  constructor(route: string, issues: readonly ConformanceIssue[]) {
    super(
      'INTERNAL',
      `Response does not match the schema declared for ${route}: ` +
        issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('; ') +
        '. The schema is documentation the tests enforce — fix whichever of the two is wrong. ' +
        'A field missing from the schema is a field that would vanish from the generated client types.',
      { route, issues: issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`) },
    );
    this.name = 'ResponseConformanceError';
    this.issues = issues;
  }
}

interface RouteView {
  readonly method: string;
  readonly url: string;
  readonly schema?: { readonly response?: Record<string, unknown> } | undefined;
}

/**
 * Install the `preSerialization` check.
 *
 * `preSerialization` rather than `onSend` because it receives the payload as an *object*: the
 * schema describes the value the handler returned, and re-parsing a serialized string to check it
 * would be checking `JSON.stringify`'s output rather than the handler's.
 */
export function registerResponseConformance(
  app: FastifyInstance,
  mode: ConformanceMode = conformanceModeFromEnv(),
): void {
  if (mode === 'off') return;

  app.addHook('preSerialization', async (request: FastifyRequest, reply, payload: unknown) => {
    const route = request.routeOptions as unknown as RouteView;
    const schema = schemaForStatus(route.schema?.response, reply.statusCode);
    if (schema === null) return payload;

    const issues = checkResponse(payload, schema);
    if (issues.length > 0) {
      throw new ResponseConformanceError(
        `${route.method} ${route.url} (${reply.statusCode})`,
        issues,
      );
    }
    return payload;
  });
}

/** Fastify's own lookup order: exact status, then the `2xx`-style wildcard, then `default`. */
function schemaForStatus(
  responses: Record<string, unknown> | undefined,
  status: number,
): ResponseSchema | null {
  if (responses === undefined) return null;
  const wildcard = `${Math.floor(status / 100)}xx`;
  const candidate = responses[String(status)] ?? responses[wildcard] ?? responses['default'];
  return isSchema(candidate) ? candidate : null;
}
