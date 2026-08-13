import type { FastifyInstance, FastifySchema } from 'fastify';
import { ApiError } from './errors.js';

/**
 * Query-string strictness — **one hook, every API route** (F5.4 / TDS 04 §1.3).
 *
 * Fastify runs Ajv with `removeAdditional: true` (its default). On a *body* that turns
 * `additionalProperties: false` into "delete the unknown field"; on a *query string* it does
 * the same thing, and the consequence is worse, because a query parameter is almost always a
 * **filter**:
 *
 *   GET /api/v1/audit-log-entries?actor=me   ->  `actor` deleted -> reads as NO filter -> 200
 *                                                with every row in the table
 *   GET /api/v1/sessions?stat=running        ->  `stat` deleted  -> reads as NO filter -> 200
 *                                                with every Session
 *
 * Both answer `200 OK` to a question they did not answer. A *known* filter with an unusable
 * value already fails closed (`?from=lastTuesday` is a 400), so the hole was specifically
 * unknown parameter **names** — and the failure is silent, which is what makes it dangerous:
 * the operator reads a narrowed list that was never narrowed.
 *
 * **The verdict is `VALIDATION_FAILED` (400)**, the same answer the settings write planner
 * gives an unknown field name (`settings/documents.ts`, and the reasoning recorded in
 * `packages/shared/src/settings/registry.ts`). A rejected request costs the caller one
 * corrected typo; an accepted one costs them a wrong answer they have no way to detect. There
 * is no softer option that preserves that distinction — a warning header is not read by
 * `fetch`, and dropping the parameter *is* the defect.
 *
 * **It cannot be forgotten by a new route.** This is a single `preValidation` hook installed
 * before any route is registered, and the allowlist is derived from the route's own
 * `querystring` schema:
 *
 *   - schema with `properties`  -> those names, and nothing else       (`strict`)
 *   - **no querystring schema** -> **no parameter is accepted at all** (`strict`, empty)
 *   - `additionalProperties: true` -> the route opted out, explicitly  (`open`)
 *
 * So the failure mode of forgetting something is a route that rejects query parameters, never
 * one that silently swallows them. Opting out is an act that shows up in review — the same
 * inversion the auth guard relies on (`auth/guard.ts`).
 *
 * **Why `preValidation` and not `onRequest`:** it must run *before* Ajv (which is what deletes
 * the parameter) and *after* the auth guard's `onRequest` hook, so an unauthenticated caller
 * still gets `401` rather than a 400 that confirms which parameters a route accepts. Lifecycle
 * order gives both properties without depending on hook registration order.
 *
 * **Scope: routes under `/api/`.** Everything else is the SPA artifact (F2.3) — static assets
 * and the deep-link fallback, where `/login?returnTo=…` is a client-side route the browser
 * asks the server for verbatim, and rejecting its query string would 400 a legitimate page
 * load. No API route can land outside the prefix: F5.2 fixes every one of them under
 * `/api/v1`.
 */

/** F5.2: every REST route lives under this prefix. Anything else is the SPA artifact. */
const API_PREFIX = '/api/';

export type QueryParameterMode =
  /** The allowlist is enforced; an unknown name is a 400. */
  | 'strict'
  /** The route declared `additionalProperties: true` — deliberately unenforced. */
  | 'open'
  /** Not under `/api/` — the SPA artifact, out of the API contract. */
  | 'unguarded';

export interface QueryParameterPolicy {
  readonly mode: QueryParameterMode;
  /** Accepted parameter names, sorted. Empty for `open`/`unguarded` (they allow anything). */
  readonly allowed: readonly string[];
}

/** One row of the route table, for introspection and for the "no route was missed" test. */
export interface RouteQueryPolicy extends QueryParameterPolicy {
  readonly method: string;
  readonly url: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Every registered route and the query-parameter policy it will be held to.
     *
     * A view over `app.apiRoutes` (`route-table.ts`), so it is the *actual* route table rather
     * than a hand-maintained list — which is what lets a test assert that a route added
     * tomorrow is covered without anyone remembering to add it to a fixture.
     */
    readonly queryParameterPolicies: readonly RouteQueryPolicy[];
  }
}

/** A route with no querystring schema accepts no query parameters. Shared, so it is cheap. */
const NO_PARAMETERS: QueryParameterPolicy = Object.freeze({
  mode: 'strict',
  allowed: Object.freeze([]) as readonly string[],
});

const UNGUARDED: QueryParameterPolicy = Object.freeze({
  mode: 'unguarded',
  allowed: Object.freeze([]) as readonly string[],
});

/**
 * Derived policies, keyed on the schema object itself.
 *
 * Route schemas are module-level constants (`listQuerySchema` and friends), so this is one
 * derivation per schema for the life of the process rather than one per request.
 */
const derived = new WeakMap<object, QueryParameterPolicy>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The policy a route's schema implies. Exported for the unit tier and for route-table tests. */
export function queryPolicyOf(
  url: string,
  schema: FastifySchema | undefined,
): QueryParameterPolicy {
  if (!url.startsWith(API_PREFIX)) return UNGUARDED;

  const querystring: unknown = schema?.querystring;
  if (!isRecord(querystring)) return NO_PARAMETERS;

  const cached = derived.get(querystring);
  if (cached !== undefined) return cached;

  const policy: QueryParameterPolicy =
    // The one opt-out, and it has to be written down in the route to exist.
    querystring['additionalProperties'] === true
      ? { mode: 'open', allowed: [] }
      : {
          mode: 'strict',
          allowed: isRecord(querystring['properties'])
            ? Object.keys(querystring['properties']).sort()
            : [],
        };

  derived.set(querystring, policy);
  return policy;
}

/**
 * The query parameter *names* a request carries, read from the raw URL.
 *
 * Deliberately not `request.query`: that object is Fastify's, and by the time validation has
 * run it no longer contains the very names this function exists to find. The raw URL is the
 * only place the truth survives.
 */
export function queryParameterNames(rawUrl: string | undefined): readonly string[] {
  if (rawUrl === undefined) return [];
  const start = rawUrl.indexOf('?');
  if (start === -1) return [];

  const names = new Set<string>();
  for (const name of new URLSearchParams(rawUrl.slice(start + 1)).keys()) names.add(name);
  return [...names];
}

export function unknownQueryParameters(
  rawUrl: string | undefined,
  allowed: readonly string[],
): readonly string[] {
  const names = queryParameterNames(rawUrl);
  if (names.length === 0) return [];
  const permitted = new Set(allowed);
  return names.filter((name) => !permitted.has(name));
}

/**
 * Install the guard.
 *
 * Called from `registerHttpConventions` — after `registerRouteTable`, whose table the
 * `queryParameterPolicies` view is computed from, and before any route exists, because Fastify
 * binds hooks to a route at registration time and a hook added afterwards would cover nothing.
 */
export function registerQueryStrictness(app: FastifyInstance): void {
  app.decorate('queryParameterPolicies', {
    getter(this: FastifyInstance): readonly RouteQueryPolicy[] {
      return this.apiRoutes.map((route) => ({
        method: route.method,
        url: route.url,
        ...queryPolicyOf(route.url, route.schema),
      }));
    },
  });

  app.addHook('preValidation', async (request) => {
    // No route matched: the F5.4 not-found handler owns the answer, and `?anything` on a URL
    // that does not exist is not the interesting fact about that request.
    const url = request.routeOptions.url;
    if (url === undefined) return;

    const policy = queryPolicyOf(url, request.routeOptions.schema);
    if (policy.mode !== 'strict') return;

    const unknown = unknownQueryParameters(request.raw.url, policy.allowed);
    if (unknown.length === 0) return;

    throw new ApiError(
      'VALIDATION_FAILED',
      `Unknown query parameter${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`,
      {
        // Named, because the whole point is that the caller believes this filter is applied.
        unknownParameters: unknown,
        // The route contract is published (F5.1 OpenAPI), so echoing it discloses nothing and
        // turns a rejected request into a self-correcting one.
        allowedParameters: policy.allowed,
      },
    );
  });
}
