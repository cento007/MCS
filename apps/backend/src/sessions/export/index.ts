import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { MemorySearchService } from '../../memory/retrieval.js';
import type { WorkingTreeStatus } from '../../repositories/git.js';
import { registerSessionExportRoutes } from './routes.js';
import { SessionExportService } from './service.js';

/**
 * `sessions/export/` — PRD §4.1's two remaining Session features, TDS 04 §6.7's two reserved
 * routes.
 *
 *   evidence.ts   the bounded reads both documents share; nothing unbounded is ever selected
 *   text.ts       making recorded text safe to embed in Markdown, and honest about the repairs
 *   render.ts     the Export document (pure)
 *   package.ts    the Context package document (pure), and the case for each of its sections
 *   service.ts    the two outbound edges (semantic memory, `git status`), both bounded
 *   routes.ts     the two routes, and why they answer with an envelope rather than a download
 *
 * TDS 02 §2 names this `sessions/export.ts`. It is a directory instead, for the same reason
 * `managed/` and `observed/` are: the pure renderers must be reachable by a unit tier that has
 * no database and no network, and a single file would have put the SQL and the string building
 * in one module that could only be tested with PostgreSQL running.
 *
 * **Nothing is written to disk.** TDS 02 §2's parenthetical says "writes `MC_DATA_DIR/exports`",
 * and that is not done, deliberately: §6.7's contract returns the document *in the response*,
 * there is no route that reads such a file back, and nothing would ever delete one. The result
 * would be an unbounded, unpruned pile of transcripts — the most sensitive text this product
 * holds — accumulating in a directory no feature reads. Recorded as a deviation in the return
 * notes rather than silently split between two behaviours.
 */

export * from './evidence.js';
export * from './package.js';
export * from './render.js';
export * from './routes.js';
export * from './service.js';
export * from './text.js';

export interface RegisterSessionExportOptions {
  readonly db: Db;
  /**
   * The retrieval service the context package's related-context section is built from.
   *
   * `null` is a legitimate value and does **not** mean "skip the section": it renders the
   * `not_configured` gap, exactly as a Backend whose operator never set an embedding model does.
   * A package that silently dropped the section would look complete and be half a document.
   */
  readonly memory: MemorySearchService | null;
  readonly memoryBudgetMs?: number | undefined;
  readonly gitBudgetMs?: number | undefined;
  readonly probe?:
    | ((localPath: string, options: { timeoutMs: number }) => Promise<WorkingTreeStatus>)
    | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

export interface SessionExportModule {
  readonly service: SessionExportService;
}

export function registerSessionExport(
  app: FastifyInstance,
  options: RegisterSessionExportOptions,
): SessionExportModule {
  const service = new SessionExportService({
    db: options.db,
    memory: options.memory,
    ...(options.memoryBudgetMs === undefined ? {} : { memoryBudgetMs: options.memoryBudgetMs }),
    ...(options.gitBudgetMs === undefined ? {} : { gitBudgetMs: options.gitBudgetMs }),
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  registerSessionExportRoutes(app, { service });

  return { service };
}
