import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { PUBLIC_ROUTE } from '../auth/guard.js';

/**
 * Static SPA serving with deep-link fallback (F2.3, TDS 05 §12).
 *
 * The Frontend is a build artifact, not a process: `vite build` emits `apps/frontend/dist` and
 * **the Backend serves it on the same origin as the API**. That is the whole of the F2.1
 * topology — `deploy/systemd/README.md` says it in one line ("The Frontend has no unit") and it
 * is why there is no nginx, no reverse proxy and no CORS branch anywhere in this system.
 *
 * Until this module existed the placeholder in `app.ts` was the only thing standing in for it,
 * and the practical consequence was that the *only* way to reach the UI — in development and on
 * the Ubuntu box alike — was the Vite dev server on `:5173` proxying `/api` back here. A dev
 * server was doing a production job, and the documented single-process deployment did not
 * actually exist.
 *
 * ## Four decisions worth stating
 *
 * **The bundle is public.** `PUBLIC_ROUTE`, deliberately: `index.html` and the hashed assets are
 * the login screen, so requiring a session to fetch them would make logging in impossible. This
 * discloses nothing — the bundle is the same artifact any clone of this repository can build, it
 * contains no secret by construction (TDS 05 §12: "every URL is same-origin relative and
 * everything user-configurable comes from the Settings API at runtime"), and every byte it goes
 * on to ask for is behind the guard in `auth/guard.ts`.
 *
 * **`/api/` never falls back.** An unmatched API path keeps answering the F5.4 envelope. Serving
 * `index.html` for `GET /api/v1/sessionz` would hand a client HTML where it parses JSON and turn
 * a plain 404 into "MALFORMED_RESPONSE" three layers away — the same class of misdirection
 * `listenWithRetry` in `main.ts` was written to stop happening.
 *
 * **A navigation is not an asset fetch.** The fallback requires `Accept: text/html`, which a
 * browser sends when it navigates and does not send for `<script>`, `<link>` or `fetch()`. Without
 * that check a mistyped bundle name answers 200 with HTML under a JavaScript content-type, and
 * the browser reports a MIME-type error that names neither the missing file nor this handler.
 *
 * **HTML is never cached; hashed assets always are.** Vite puts the content hash in every asset
 * filename, so `assets/*` are immutable by construction and a year is simply true. `index.html`
 * is the one name that never changes while its *contents* change every build — cache it and a
 * returning browser is pointed at bundles the last deploy deleted, which presents as a white
 * screen that a reload does not fix and that looks like a backend fault.
 */

export type SpaFallback = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Installed by `registerSpa`; `null` on an API-only Backend — which is every unit and
     * integration test, and any deployment whose SPA has not been built.
     *
     * It hangs off the instance rather than being wired directly into `setNotFoundHandler`
     * because Fastify permits exactly one not-found handler per encapsulation context, and
     * `registerHttpConventions` has already installed it by the time the SPA is registered.
     */
    spaFallback: SpaFallback | null;
  }
}

const API_PREFIX = '/api/';

/** The SPA's entry document. Everything else in `dist` is served by path. */
const INDEX = 'index.html';

const HTML_NO_CACHE = 'no-cache, no-store, must-revalidate';
const ASSET_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Should this unmatched request be answered with the SPA rather than the F5.4 envelope?
 *
 * Exported so `http/index.ts`'s not-found handler asks this question in one place, and so the
 * three refusals above are testable without a built `dist` on disk.
 */
export function shouldServeSpa(request: FastifyRequest): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (request.url.startsWith(API_PREFIX)) return false;

  return request.headers.accept?.includes('text/html') === true;
}

export interface SpaOptions {
  /** Absolute path to the built SPA (`apps/frontend/dist`). */
  readonly root: string;
}

/**
 * Serve `root` as the SPA, and return whether anything was registered.
 *
 * **A missing `root` is a warning, not a fatal error.** A Backend with no SPA still serves the
 * whole API, and that is exactly the shape every test runs in; refusing to boot would also mean
 * an operator who ran `pnpm db:migrate` before `pnpm build` gets a dead process instead of a
 * working API and a line telling them which command they skipped.
 */
export function registerSpa(app: FastifyInstance, options: SpaOptions): boolean {
  const indexPath = join(options.root, INDEX);
  if (!existsSync(options.root) || !existsSync(indexPath)) {
    app.log.warn(
      { root: options.root },
      'SPA not served: no build found. Run `pnpm build` to serve the UI from this process.',
    );
    return false;
  }

  /**
   * Read once, at registration.
   *
   * `index.html` is a few kilobytes and is answered for every navigation and every deep link,
   * so a filesystem round-trip per request buys nothing. It is also the same decision
   * `wildcard: false` already makes about the asset routes — the build artifact is fixed when
   * the process starts — which keeps one rule to remember instead of two: **a rebuild needs a
   * restart.** `pnpm build && restart` is already the documented upgrade runbook
   * (`deploy/systemd/README.md` §"Upgrade runbook").
   */
  const indexHtml = readFileSync(indexPath, 'utf8');

  void app.register(async (scope) => {
    /**
     * Open up **only** the routes registered in this scope.
     *
     * The guard defaults every route to `FULL_ACCESS_ROUTE` and `@fastify/static` has no way to
     * declare a route config, so the policy is stamped on the way past. Doing it on an
     * encapsulated child rather than on `app` is what keeps the blast radius to the static
     * routes: an `onRoute` hook on the root instance would silently make every later non-API
     * route public too, which is the inverted failure mode `auth/guard.ts` exists to avoid.
     */
    scope.addHook('onRoute', (route) => {
      route.config = { ...route.config, auth: PUBLIC_ROUTE };
    });

    await scope.register(fastifyStatic, {
      root: options.root,
      /**
       * No `GET /*`. With the wildcard on, every unmatched path — including a mistyped API route —
       * reaches this plugin first and is answered from a filesystem lookup rather than by the
       * not-found handler that owns the F5.4 envelope. Off, `@fastify/static` registers one route
       * per file it finds at boot, which is the honest model for a build artifact: the file set is
       * fixed the moment `vite build` finishes and does not change until the next restart.
       */
      wildcard: false,
      /**
       * `/` is not auto-served. It goes to the not-found handler and comes back through
       * `spaFallback`, so there is exactly one code path that emits `index.html` and exactly one
       * place its cache policy is set.
       */
      index: false,
      // `setHeaders` is handed the Fastify reply, not the raw `ServerResponse`.
      setHeaders: (reply, path) => {
        reply.header('cache-control', path.endsWith('.html') ? HTML_NO_CACHE : ASSET_IMMUTABLE);
      },
    });
  });

  /**
   * Answered from memory rather than through `reply.sendFile`, and that is forced rather than
   * chosen: `@fastify/static` decorates the reply **inside the encapsulated scope above**, so
   * `sendFile` does not exist on this one. Keeping the plugin encapsulated is what stops its
   * `onRoute` hook from making every later non-API route public, so the fallback gives up the
   * decorator instead of the containment.
   */
  app.spaFallback = async (_request, reply) => {
    await reply
      .code(200)
      .header('cache-control', HTML_NO_CACHE)
      .type('text/html; charset=utf-8')
      .send(indexHtml);
  };

  app.log.info({ root: options.root }, 'serving the SPA');
  return true;
}
