import type { FastifyInstance, FastifySchema } from 'fastify';
import { ApiError } from './errors.js';

/**
 * Request-body strictness — **one hook, every API route** (F5.4 / TDS 04 §1.3).
 *
 * The sibling of `query-strictness.ts`, closing the same defect on the other half of the
 * request. Fastify runs Ajv with `removeAdditional: true` (its default), which turns
 * `additionalProperties: false` into *delete the unknown field* rather than *reject the body*.
 * So a typo is discarded and the request **succeeds**:
 *
 *   PATCH /api/v1/sessions/{id}      { "titel": "…" }        -> 200, title unchanged
 *   PATCH /api/v1/repositories/{id}  { "defaultBrach": "…" } -> 200, branch unchanged
 *   POST  /api/v1/sessions           { "repositoryId": … }   -> 201, Session with no repository
 *   POST  /api/v1/projects           { "workflowMode": … }   -> 201, mode silently inherited
 *
 * Each answers `2xx` to an instruction it did not carry out, and the caller has no way to tell.
 * This is not a hypothetical class: it has been fixed twice already, once per route.
 * `POST /auth/tokens` with a misspelled `scopes` silently issued a **full-access** token
 * (`auth/routes.ts`), and a misspelled field in a settings `PUT` would have *reset* that
 * setting to its default under full-replace semantics (`settings/documents.ts`,
 * `packages/shared/src/settings/registry.ts`). Both were closed where they were found; this
 * closes the class.
 *
 * **The verdict is `VALIDATION_FAILED` (400)**, naming the offending field — the same answer
 * the settings write planner and the query guard give. A rejected request costs the caller one
 * corrected typo; an accepted one costs them an instruction that was never carried out.
 *
 * **It cannot be forgotten by a new route.** The allowlist is derived from the route's own
 * `body` schema, and the derivation fails *closed*:
 *
 *   - schema with `properties`        -> those names, and nothing else        (`strict`)
 *   - **no body schema at all**       -> **no field is accepted at all**      (`strict`, empty)
 *   - `additionalProperties: true`    -> the route opted out, explicitly      (`open`)
 *   - free-form `{ type: 'object' }`  -> open, because that is what it means  (`open`)
 *
 * So forgetting to write a schema makes a route reject bodies, never swallow them. The only
 * way out is to write the opt-out into the route, where review sees it — and `bodyPolicyOf`
 * reports **every** unenforced location in the schema tree (`openPaths`), so an escape hatch
 * buried three levels down still shows up in the coverage test rather than hiding.
 *
 * **The one opt-out in the product today is `POST /api/v1/hook-events`** (plus the settings
 * `PUT /settings/{category}` fallback, which only ever answers 404). F1.5 requires tolerance of
 * Claude Code's hook payloads across versions: the runtime owns that body's shape and adds
 * fields between releases, so a strict schema would turn a Claude Code upgrade into a wall of
 * 400s in the operator's terminal. It declares `additionalProperties: true` and keeps it.
 *
 * **Nested fields are checked too, and that is not gold-plating.** `removeAdditional` strips at
 * every level, and the settings documents are the place where a stripped *nested* field is
 * destructive: `PUT /settings/notifications { "dailyReport": { "enabl": true } }` would drop
 * `enabl`, and `normalize` would then read `enabled` as absent and write the **default** back.
 * The write planner only ever checked top-level names, so this walk is the only thing standing
 * in front of that.
 *
 * **Why `preValidation`:** it must run *before* Ajv (which is what deletes the field) and
 * *after* the auth guard's `onRequest` hook, so an unauthenticated caller still gets `401`
 * rather than a 400 that confirms which fields a route accepts. Unlike the query guard, this
 * one reads `request.body` directly — at `preValidation` the body is parsed but not yet
 * validated, so the unknown names are still there.
 *
 * **Scope: routes under `/api/`.** Everything else is the SPA artifact (F2.3), which is served
 * by `GET` and has no body to police.
 */

/** F5.2: every REST route lives under this prefix. Anything else is the SPA artifact. */
const API_PREFIX = '/api/';

/**
 * How many unknown fields one rejection reports.
 *
 * The list exists to make the typo self-correcting, and twenty names does that for any body a
 * human wrote. It also bounds the work: the walk stops at the cap, so a hostile body cannot
 * turn a 400 into an expensive traversal or a large response.
 */
const MAX_REPORTED_FIELDS = 20;

export type BodyFieldMode =
  /** The allowlist is enforced; an unknown field is a 400. */
  | 'strict'
  /** The route's body schema is open at its root — deliberately unenforced. */
  | 'open'
  /** Not under `/api/` — the SPA artifact, out of the API contract. */
  | 'unguarded';

export interface BodyFieldPolicy {
  readonly mode: BodyFieldMode;
  /** Accepted top-level field names, sorted. Empty for `open`/`unguarded`. */
  readonly allowed: readonly string[];
  /**
   * Every location in the schema tree where unknown fields are *not* enforced, as a dotted
   * path (`''` is the body root, `'payload'` a nested object, `'items[]'` an array element).
   *
   * This is what makes the opt-out visible: a route cannot quietly open a sub-object, because
   * the coverage test asserts the full list of open locations across the whole route table.
   */
  readonly openPaths: readonly string[];
}

/** One row of the route table, for introspection and for the "no route was missed" test. */
export interface RouteBodyPolicy extends BodyFieldPolicy {
  readonly method: string;
  readonly url: string;
}

/** An unknown field and the names that *were* available where it appeared. */
export interface UnknownBodyField {
  /** Dotted path from the body root: `titel`, `dailyReport.enabl`, `files[0].nam`. */
  readonly path: string;
  /** The declared sibling fields at that location, as dotted paths, sorted. */
  readonly allowed: readonly string[];
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Every registered route and the body-field policy it will be held to, derived from the
     * live route table (`route-table.ts`) rather than from a hand-maintained list.
     */
    readonly bodyFieldPolicies: readonly RouteBodyPolicy[];
  }
}

const UNGUARDED: BodyFieldPolicy = Object.freeze({
  mode: 'unguarded',
  allowed: Object.freeze([]) as readonly string[],
  openPaths: Object.freeze([]) as readonly string[],
});

/**
 * The schema a route with **no** `body` schema is held to: an object with no declared field, so
 * every field in the body is unknown.
 *
 * Written as a schema rather than as a special case in the walk so there is exactly one set of
 * rules. It is also the difference between "no schema" (accept nothing) and a written
 * `{ type: 'object' }` (accept anything, because that is what JSON Schema says it means).
 */
const NO_DECLARED_FIELDS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: Object.freeze({}),
});

/**
 * Keywords whose semantics this guard cannot reproduce without being a full validator.
 *
 * Where one appears, the location is reported as `open` — the honest answer, since deciding
 * which branch of a `oneOf` applies is Ajv's job, not ours. That is a *lax* fallback, so it is
 * deliberately made loud: an open location fails the coverage test until someone lists it.
 */
const UNENFORCEABLE_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  'if',
  '$ref',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
  'unevaluatedProperties',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `type` admits an object value — so this location is one where field names exist. */
function admitsObject(schema: Record<string, unknown>): boolean {
  const type = schema['type'];
  if (type === undefined) return true;
  if (typeof type === 'string') return type === 'object';
  if (Array.isArray(type)) return type.includes('object');
  return true;
}

/** This location accepts fields it did not declare. */
function locationIsOpen(schema: Record<string, unknown>): boolean {
  const additional = schema['additionalProperties'];
  // `true` is the written opt-out; a *schema* means "extras are allowed if they match", which
  // is also an acceptance of undeclared names.
  if (additional === true || isRecord(additional)) return true;
  if (UNENFORCEABLE_KEYWORDS.some((keyword) => keyword in schema)) return true;
  // `{ type: 'object' }` with nothing else is JSON Schema for "any object". Note this is
  // reachable only from a schema someone wrote: a missing schema becomes NO_DECLARED_FIELDS.
  return additional === undefined && !isRecord(schema['properties']);
}

function join(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

function declaredFields(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema['properties'];
  return isRecord(properties) ? properties : {};
}

/** Derived policies, keyed on the schema object. Route schemas are module-level constants. */
const derived = new WeakMap<object, BodyFieldPolicy>();

/**
 * The policy a route's schema implies. Exported for the unit tier, the coverage test and the
 * F5.1 OpenAPI document, which records each route's strictness alongside its shape.
 */
export function bodyPolicyOf(url: string, schema: FastifySchema | undefined): BodyFieldPolicy {
  if (!url.startsWith(API_PREFIX)) return UNGUARDED;

  const body: unknown = schema?.body;
  const effective = isRecord(body) ? body : NO_DECLARED_FIELDS;

  const cached = derived.get(effective);
  if (cached !== undefined) return cached;

  const openPaths: string[] = [];
  collectOpenLocations(effective, '', openPaths, 0);

  const policy: BodyFieldPolicy = {
    mode: openPaths.includes('') ? 'open' : 'strict',
    allowed: admitsObject(effective) ? Object.keys(declaredFields(effective)).sort() : [],
    openPaths,
  };

  derived.set(effective, policy);
  return policy;
}

/** Walk the *schema* and record every location that accepts undeclared fields. */
function collectOpenLocations(schema: unknown, path: string, out: string[], depth: number): void {
  // Schemas are static and shallow; the cap is a guard against a pathological one, not a limit
  // anything real approaches.
  if (depth > 12 || !isRecord(schema)) return;

  if (admitsObject(schema) && locationIsOpen(schema)) out.push(path);

  for (const [name, child] of Object.entries(declaredFields(schema))) {
    collectOpenLocations(child, join(path, name), out, depth + 1);
  }

  const items = schema['items'];
  if (isRecord(items)) collectOpenLocations(items, `${path}[]`, out, depth + 1);
}

/**
 * Every field in `body` the schema did not declare, as dotted paths.
 *
 * Only *names* are judged here. A declared field carrying an unusable value is Ajv's business
 * and already fails closed (`?limit=banana` and `{ "title": 42 }` are both 400s today); the
 * hole was always unknown names, because those fail **open**.
 */
export function unknownBodyFields(
  body: unknown,
  bodySchema: FastifySchema['body'],
): readonly UnknownBodyField[] {
  const found: UnknownBodyField[] = [];
  walk(body, isRecord(bodySchema) ? bodySchema : NO_DECLARED_FIELDS, '', found);
  return found;
}

function walk(value: unknown, schema: unknown, path: string, out: UnknownBodyField[]): void {
  if (out.length >= MAX_REPORTED_FIELDS) return;

  if (Array.isArray(value)) {
    const items = isRecord(schema) ? schema['items'] : undefined;
    // No `items` schema (or the tuple form): nothing declares what an element may contain, so
    // there is no allowlist to enforce. Ajv still owns the element's type.
    if (!isRecord(items)) return;
    for (const [index, element] of value.entries()) {
      walk(element, items, `${path}[${index}]`, out);
    }
    return;
  }

  if (!isRecord(value) || !isRecord(schema)) return;
  // The schema says this is not an object; Ajv will reject the value on its own, and reporting
  // "unknown field" for a body that should have been a string would name the wrong problem.
  if (!admitsObject(schema)) return;

  const open = locationIsOpen(schema);
  const properties = declaredFields(schema);
  const siblings = Object.keys(properties)
    .sort()
    .map((name) => join(path, name));

  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) {
      walk(value[key], properties[key], join(path, key), out);
      continue;
    }
    if (open) continue;

    out.push({ path: join(path, key), allowed: siblings });
    if (out.length >= MAX_REPORTED_FIELDS) return;
  }
}

/**
 * Install the guard.
 *
 * Called from `registerHttpConventions` — after `registerRouteTable`, whose table the
 * `bodyFieldPolicies` view is computed from, and before any route is registered, because
 * Fastify binds hooks to a route when the route is registered.
 */
export function registerBodyStrictness(app: FastifyInstance): void {
  app.decorate('bodyFieldPolicies', {
    getter(this: FastifyInstance): readonly RouteBodyPolicy[] {
      return this.apiRoutes.map((route) => ({
        method: route.method,
        url: route.url,
        ...bodyPolicyOf(route.url, route.schema),
      }));
    },
  });

  app.addHook('preValidation', async (request) => {
    // No route matched: the F5.4 not-found handler owns the answer, and the body of a request
    // to a URL that does not exist is not the interesting fact about it.
    const url = request.routeOptions.url;
    if (url === undefined || !url.startsWith(API_PREFIX)) return;

    const body: unknown = request.body;
    // No body at all, and the `null` a `POST` with no payload arrives as (§6.3's optional
    // clone body). Neither carries a field name.
    if (body === undefined || body === null) return;

    const unknown = unknownBodyFields(body, request.routeOptions.schema?.body);
    if (unknown.length === 0) return;

    const paths = unknown.map((field) => field.path);
    const allowed = [...new Set(unknown.flatMap((field) => field.allowed))].sort();

    throw new ApiError(
      'VALIDATION_FAILED',
      `Unknown body field${paths.length === 1 ? '' : 's'}: ${paths.join(', ')}`,
      {
        // Named, because the whole point is that the caller believes this field was applied.
        unknownFields: paths,
        // The route contract is published (F5.1 OpenAPI), so echoing it discloses nothing and
        // turns a rejected request into a self-correcting one.
        allowedFields: allowed,
      },
    );
  });
}
