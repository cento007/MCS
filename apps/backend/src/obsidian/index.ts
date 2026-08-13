import type { Db, QueuePort, ScanBounds } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../events/index.js';
import { registerObsidianRoutes } from './routes.js';
import { ObsidianService } from './service.js';

/**
 * `obsidian/` — the Backend's half of Obsidian sync (TDS 04 §10).
 *
 * Trigger, report, preview. **No write path**: the engine that touches the operator's vault
 * lives in `@mc/shared/obsidian` and runs in the Sync Worker, which is the only process with
 * write access to the vault (F2.2, TDS 02 §2.2). What is here is the API surface plus the
 * read-only dry run.
 *
 * Layout:
 *   serialize.ts   `SyncRun` (§10) + the per-file detail the detail route joins in
 *   service.ts     trigger / list / get / preview
 *   routes.ts      `/api/v1/sync-runs/*`
 */

export * from './routes.js';
export * from './serialize.js';
export * from './service.js';

export interface RegisterObsidianOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: QueuePort;
  /** Tighten the preview's vault walk (tests). */
  readonly scanBounds?: ScanBounds | undefined;
}

export interface ObsidianModule {
  readonly obsidian: ObsidianService;
}

export function registerObsidian(
  app: FastifyInstance,
  options: RegisterObsidianOptions,
): ObsidianModule {
  const obsidian = new ObsidianService({
    db: options.db,
    outbox: options.outbox,
    queue: options.queue,
    scanBounds: options.scanBounds,
  });

  registerObsidianRoutes(app, { obsidian });
  return { obsidian };
}
