import type { FastifyContextConfig, FastifyInstance, FastifySchema, RouteOptions } from 'fastify';

/**
 * The route table — **the actual set of routes this process serves**, captured at registration.
 *
 * Three things need to answer questions about "every route", and all three were previously
 * going to answer them from a hand-maintained list:
 *
 *   - the query-parameter guard's coverage test (`query-strictness.ts`),
 *   - the body-field guard's coverage test (`body-strictness.ts`),
 *   - the F5.1 OpenAPI document (`openapi/`), which is generated from the Fastify schemas.
 *
 * A hand-maintained list is exactly the artifact that drifts: a route added tomorrow is absent
 * from it, and its absence is silent. An `onRoute` hook cannot be forgotten, because Fastify
 * calls it for every route anyone registers — including the ones a workstream adds later, and
 * including Fastify's own auto-generated `HEAD` siblings.
 *
 * **It must be installed before any route exists.** `onRoute` fires at registration time and
 * does not replay, so a hook added after `registerX(app)` would see nothing. That is why this
 * is called from `registerHttpConventions` (`http/index.ts`), which `buildApp` runs first.
 *
 * That ordering is also this table's one blind spot, and it is worth naming: a route registered
 * *earlier* than this hook is invisible here — absent from the OpenAPI document and, more
 * importantly, unguarded by the two strictness hooks, which are installed alongside it. There is
 * no way to detect such a route after the fact (Fastify's router is not enumerable and `onRoute`
 * does not replay), so the protection is structural: `registerHttpConventions` is the first
 * thing `buildAppWithServices` does, and nothing may register a route before it.
 */

export interface ApiRoute {
  /** One entry per method: a route registered for `['GET', 'HEAD']` produces two rows. */
  readonly method: string;
  /** Fastify's declared URL, parameters included — `/api/v1/sessions/:id/start`. */
  readonly url: string;
  readonly schema: FastifySchema | undefined;
  /** `config.auth` lives here (`auth/guard.ts` augments `FastifyContextConfig`). */
  readonly config: FastifyContextConfig | undefined;
  /** Per-route override of the app-wide 1 MiB cap; `undefined` means the app default. */
  readonly bodyLimitBytes: number | undefined;
}

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Every registered route, in registration order.
     *
     * Read it after `await app.ready()` — routes registered inside a plugin appear only once
     * the plugin tree has been resolved.
     */
    readonly apiRoutes: readonly ApiRoute[];
  }
}

export function registerRouteTable(app: FastifyInstance): void {
  const routes: ApiRoute[] = [];
  app.decorate('apiRoutes', routes);

  app.addHook('onRoute', (route: RouteOptions) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      routes.push({
        method,
        url: route.url,
        schema: route.schema,
        config: route.config,
        bodyLimitBytes: route.bodyLimit,
      });
    }
  });
}
