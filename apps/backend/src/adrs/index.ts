import type { Db, QueuePort } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { Outbox } from '../events/index.js';
import { registerAdrRoutes } from './routes.js';
import { AdrService } from './service.js';

/**
 * `adrs/` — the Adr domain (TDS 04 §9, storage TDS 03 §4.1, template PRD §7.3).
 *
 * Layout:
 *   store.ts       every `adrs` read/write, plus the `synced_at` projection from the ledger
 *   serialize.ts   row -> §9 resource
 *   validation.ts  title/section/status rules (there is no `draft`)
 *   service.ts     the §9 contract + `generate-adr` enqueue
 *   routes.ts      `/api/v1/adrs/*` and `POST /api/v1/sessions/{id}/generate-adr`
 *
 * The **drafting** of an ADR from a Session is not here: it is a Sync Worker job
 * (`apps/sync-worker/src/adr-generation.ts`), because that is the process the contract puts it
 * in and because a draft must not run inside a request.
 */

export * from './serialize.js';
export * from './service.js';
export * from './store.js';
export * from './validation.js';

export interface RegisterAdrsOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: QueuePort;
}

export interface AdrModule {
  readonly adrs: AdrService;
}

export function registerAdrs(app: FastifyInstance, options: RegisterAdrsOptions): AdrModule {
  const adrs = new AdrService({ db: options.db, outbox: options.outbox, queue: options.queue });
  registerAdrRoutes(app, { adrs });
  return { adrs };
}
