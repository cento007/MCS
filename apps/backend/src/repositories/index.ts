import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../events/index.js';
import type { GitOptions } from './git.js';
import { registerRepositoryRoutes } from './routes.js';
import { RepositoryService } from './service.js';

/**
 * `repositories/` — the Repository domain (TDS 04 §5.1, storage TDS 03 §3.6).
 *
 * NOTE FOR THE CONTRACT OWNERS: TDS 02 §2 gives repository *discovery and polling* to
 * `github/` and names no module for the Repository entity itself. Discovery is a producer of
 * Repository rows; it is not their owner. This module owns the entity — CRUD, validation, and
 * the working-tree read model — and `github/` will write through it when it lands.
 *
 * Layout:
 *   git.ts         the only place the Backend runs `git`; bounded, total, shell-free (F8.1)
 *   store.ts       every `repositories` read and write
 *   serialize.ts   DB row -> API resource (§5.1) + the working-tree read model
 *   validation.ts  path/name rules and the "is this really a working tree" check
 *   service.ts     the §5.1 contract, plus the three routes it does not define
 *   routes.ts      `/api/v1/repositories/*`
 */

export * from './git.js';
export * from './serialize.js';
export * from './service.js';
export * from './store.js';
export * from './validation.js';

export interface RegisterRepositoriesOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  /** git executable + timeout. Defaults to `git` on PATH with a 5 s bound. */
  readonly git?: GitOptions | undefined;
}

export interface RepositoryModule {
  readonly repositories: RepositoryService;
}

export function registerRepositories(
  app: FastifyInstance,
  options: RegisterRepositoriesOptions,
): RepositoryModule {
  const repositories = new RepositoryService({
    db: options.db,
    outbox: options.outbox,
    ...(options.git === undefined ? {} : { git: options.git }),
  });

  registerRepositoryRoutes(app, { repositories });
  return { repositories };
}
