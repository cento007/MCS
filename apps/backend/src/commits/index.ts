import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { registerCommitRoutes } from './routes.js';
import { CommitService } from './service.js';

/**
 * `commits/` — the Commit read model (TDS 04 §5.2, storage TDS 03 §3.7).
 *
 * Ownership, stated because three modules touch this table:
 *   - `github/`     **writes** commits (sync + attribution) and emits `commit.recorded`
 *   - `commits/`    **reads** them: the §5.2 resource, its cursor, its two routes
 *   - `sessions/`   serves §6.10.1's Session-scoped list — through *this* module's store,
 *                   cursor and serializer, so one resource has one shape everywhere
 *
 * Layout mirrors `repositories/`:
 *   cursors.ts     the `(committedAt, id)` ordering key behind the opaque F5.3 cursor
 *   store.ts       every `commits` read
 *   serialize.ts   DB row -> §5.2 resource (list shape and detail shape)
 *   service.ts     the §5.2 contract
 *   routes.ts      `/api/v1/repositories/{id}/commits`, `/api/v1/commits/{id}`
 */

export * from './cursors.js';
export * from './serialize.js';
export * from './service.js';
export * from './store.js';

export interface RegisterCommitsOptions {
  readonly db: Db;
}

export interface CommitModule {
  readonly commits: CommitService;
}

export function registerCommits(
  app: FastifyInstance,
  options: RegisterCommitsOptions,
): CommitModule {
  const commits = new CommitService({ db: options.db });
  registerCommitRoutes(app, { commits });
  return { commits };
}
