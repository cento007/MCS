import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { registerPullRequestRoutes } from './routes.js';
import { PullRequestService } from './service.js';

/**
 * `pull-requests/` — the PullRequest read model (TDS 04 §5.3, storage TDS 03 §3.8).
 *
 * Directory named for the resource path (F5.2: kebab-case path segments,
 * `/api/v1/pull-requests`), and the entity is `PullRequest` per F4.1.
 *
 * Ownership: `github/` writes the rows (`upsertPullRequest`, plus the `pull_request.*` events);
 * this module reads them. Phase 1 has no other writer and §5.3 defines no write endpoint.
 *
 * Layout mirrors `commits/`:
 *   cursors.ts     the `(openedAt, id)` ordering key behind the opaque F5.3 cursor
 *   store.ts       every `pull_requests` read
 *   serialize.ts   DB row -> §5.3 resource (list shape and detail shape)
 *   service.ts     the §5.3 contract
 *   routes.ts      `/api/v1/pull-requests[/{id}]`, `/api/v1/repositories/{id}/pull-requests`
 */

export * from './cursors.js';
export * from './serialize.js';
export * from './service.js';
export * from './store.js';

export interface RegisterPullRequestsOptions {
  readonly db: Db;
}

export interface PullRequestModule {
  readonly pullRequests: PullRequestService;
}

export function registerPullRequests(
  app: FastifyInstance,
  options: RegisterPullRequestsOptions,
): PullRequestModule {
  const pullRequests = new PullRequestService({ db: options.db });
  registerPullRequestRoutes(app, { pullRequests });
  return { pullRequests };
}
