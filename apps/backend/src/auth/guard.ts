import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../http/errors.js';
import { readCookie, SESSION_COOKIE_NAME } from './cookie.js';
import { type ApiTokenScope, hasScope, type Principal } from './principal.js';
import type { AuthService } from './service.js';

/**
 * The route guard (TDS 04 §1.4): **all routes require authentication except
 * `POST /api/v1/auth/login`.**
 *
 * It is a single global `onRequest` hook rather than a per-route `preHandler`, and that is a
 * security decision, not a style one: with a global hook, a route added later is authenticated
 * because the developer did nothing, and *opting out* is the act that shows up in review. A
 * per-route decorator inverts that — the failure mode of forgetting it is an open endpoint.
 *
 * Unmatched paths go through the same hook (Fastify runs `onRequest` for the 404 handler too),
 * so an unauthenticated caller gets `401` rather than a map of which routes exist.
 */

export type RouteAuthPolicy =
  | { readonly mode: 'public' }
  | {
      readonly mode: 'authenticated';
      /** Scope an API token must hold. `full` satisfies everything (TDS 04 §1.4). */
      readonly scope: ApiTokenScope;
      /** `false` rejects a valid browser session with `FORBIDDEN` (TDS 04 §6.8). */
      readonly allowCookie: boolean;
    };

/** `POST /api/v1/auth/login` and the liveness probe. Nothing else. */
export const PUBLIC_ROUTE: RouteAuthPolicy = Object.freeze({ mode: 'public' });

/** The default for every route that does not say otherwise. */
export const FULL_ACCESS_ROUTE: RouteAuthPolicy = Object.freeze({
  mode: 'authenticated',
  scope: 'full',
  allowCookie: true,
});

/**
 * `POST /api/v1/hook-events` (TDS 04 §6.8): bearer token with scope `ingest` (or `full`),
 * **cookie auth rejected**. Exported here so the observed-session ingest route declares this
 * policy instead of re-deriving it — the scope only means anything if exactly one place
 * decides what it permits.
 */
export const INGEST_ROUTE: RouteAuthPolicy = Object.freeze({
  mode: 'authenticated',
  scope: 'ingest',
  allowCookie: false,
});

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the guard; `null` only on `mode: 'public'` routes. */
    principal: Principal | null;
  }
  interface FastifyContextConfig {
    auth?: RouteAuthPolicy;
  }
}

const BEARER_SCHEME = /^Bearer\s+(.+)$/i;

/**
 * Fetch the authenticated principal inside a guarded route handler.
 *
 * Throws `INTERNAL` rather than `UNAUTHORIZED` if it is missing: a handler reaching this with
 * no principal means the route was declared public by mistake, which is a bug in *our* wiring,
 * not a client error, and it must not be reported as one.
 */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (request.principal === null) {
    throw new ApiError('INTERNAL', 'Route handler requires an authenticated principal');
  }
  return request.principal;
}

export function registerAuthGuard(app: FastifyInstance, auth: AuthService): void {
  app.decorateRequest('principal', null);

  app.addHook('onRequest', async (request) => {
    // No route matched: Fastify runs its `onRequest` chain for the 404 handler too. Let it
    // answer `NOT_FOUND` (F5.4 / TDS 04 §1.3) rather than `UNAUTHORIZED`. Nothing is
    // disclosed by doing so — the route table is a published contract, not a secret — and
    // the alternative would make "unknown resource" and "not logged in" the same response.
    if (request.routeOptions.url === undefined) return;

    const policy = request.routeOptions.config.auth ?? FULL_ACCESS_ROUTE;
    if (policy.mode === 'public') return;

    const authorization = request.headers.authorization;

    if (authorization !== undefined && authorization.length > 0) {
      const match = BEARER_SCHEME.exec(authorization);
      // Any other scheme (Basic, Digest, …) is not a credential this system issues.
      if (match?.[1] === undefined) throw unauthorized();

      const principal = await auth.authenticateBearerToken(match[1].trim());
      if (principal === null) throw unauthorized();

      assertScope(principal, policy.scope);
      request.principal = principal;
      return;
    }

    const cookieToken = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    if (cookieToken === null) throw unauthorized();

    const principal = await auth.authenticateSessionToken(cookieToken);
    if (principal === null) throw unauthorized();

    if (!policy.allowCookie) {
      // TDS 04 §6.8: the ingest endpoint rejects cookie auth outright. 403, not 401 — the
      // caller IS authenticated; this credential type is simply not accepted here.
      throw new ApiError('FORBIDDEN', 'This endpoint requires a bearer API token', {
        authMethod: 'cookie',
      });
    }

    assertScope(principal, policy.scope);
    request.principal = principal;
  });
}

function assertScope(principal: Principal, required: ApiTokenScope): void {
  if (hasScope(principal, required)) return;
  throw new ApiError('FORBIDDEN', `This endpoint requires the '${required}' scope`, {
    requiredScope: required,
    tokenScopes: [...principal.scopes],
  });
}

function unauthorized(): ApiError {
  return new ApiError('UNAUTHORIZED', 'Authentication required');
}
