import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { registerProjectRoutes } from './routes.js';
import { ProjectService } from './service.js';

/**
 * `projects/` — the Project domain (TDS 04 §4, storage TDS 03 §3.5).
 *
 * NOTE FOR THE CONTRACT OWNERS: TDS 02 §2's backend module list does not name a `projects/`
 * module — Projects are a Phase 1 entity (F4.1) with a Phase 1 contract and no owning module,
 * the same gap `audit/` records for `audit_log_entries`. It lives here rather than inside
 * `github/` (which owns *discovery*, not the Project entity) or `sessions/` (which only
 * validates the FK).
 *
 * Layout:
 *   repository.ts  every `projects` / `workspaces` read and write
 *   serialize.ts   DB row -> API resource (§4 shape)
 *   validation.ts  the pure rules: name normalisation, `archivedAt` parsing
 *   service.ts     the §4 contract, one method per row
 *   routes.ts      `/api/v1/projects/*`
 */

export * from './repository.js';
export * from './serialize.js';
export * from './service.js';
export * from './validation.js';

export interface RegisterProjectsOptions {
  readonly db: Db;
}

export interface ProjectModule {
  readonly projects: ProjectService;
}

export function registerProjects(
  app: FastifyInstance,
  options: RegisterProjectsOptions,
): ProjectModule {
  const projects = new ProjectService({ db: options.db });
  registerProjectRoutes(app, { projects });
  return { projects };
}
