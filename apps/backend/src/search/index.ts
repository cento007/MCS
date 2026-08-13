import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { registerSearchRoutes } from './routes.js';
import { SearchService } from './service.js';

/**
 * `search/` — global keyword search (TDS 04 §11, storage TDS 03 §4.6, roadmap Phase 2).
 *
 * One route, `GET /api/v1/search`, over one query: the five-branch `UNION ALL` §4.6 pinned when
 * the schema was authored, across `sessions`, `adrs`, `commits`, `pull_requests` and `messages`.
 * The generated `search_tsv` columns and their GIN indexes already exist — this module adds no
 * table, no column and no migration; it reads what PostgreSQL is already maintaining.
 *
 * Layout mirrors the other read models:
 *   types.ts       the §11 resource and the five singular discriminators
 *   parse.ts       `?types=` parsing and the query bound
 *   cursors.ts     the `(rank, occurredAt, id)` ordering key and its `q`/`types` fingerprint
 *   highlight.ts   `ts_headline` output -> a snippet whose only markup is `<mark>`
 *   query.ts       the §4.6 SQL
 *   service.ts     the bounded, read-only execution and the §11 envelope
 *   routes.ts      the route and its schema/allowlist
 *
 * **This is keyword search, and only keyword search.** PostgreSQL full-text: stemming, weights,
 * cover-density ranking. It is not similarity, not embeddings, and not memory. §4.6 is explicit
 * that fuzzy matching and accent folding (`pg_trgm`, `unaccent`) are out of V1 — both are
 * extensions, and installing extensions on two operating systems is the dependency the no-Docker
 * constraint punishes (F8). Everything here is stock PostgreSQL, so Windows 11 dev and Ubuntu
 * prod behave identically.
 *
 * Semantic search lives elsewhere, deliberately:
 *
 * > **Phase 3 — interface only.** This section is a placeholder/extension point.
 * > Detailed design is out of TDS scope per the project-plan scope guard.
 *
 * TDS 04 §13.1 reserves `POST /api/v1/memory-items/search` for Qdrant-backed semantic query
 * across the memory tiers. It is a **different route** with a different backing store, a
 * different notion of a match, and a different phase. Nothing in this module anticipates it: no
 * `mode=semantic` parameter, no vector column, no shared envelope. When Phase 3 arrives it adds
 * a route; it does not reinterpret this one.
 */

export * from './cursors.js';
export * from './highlight.js';
export * from './parse.js';
export * from './query.js';
export * from './service.js';
export * from './types.js';

export interface RegisterSearchOptions {
  readonly db: Db;
  /** Overridden by tests; production takes `DEFAULT_SEARCH_TIMEOUT_MS`. */
  readonly searchTimeoutMs?: number | undefined;
  readonly onTimeout?: ((q: string, timeoutMs: number) => void) | undefined;
}

export interface SearchModule {
  readonly search: SearchService;
}

export function registerSearch(app: FastifyInstance, options: RegisterSearchOptions): SearchModule {
  const search = new SearchService({
    db: options.db,
    ...(options.searchTimeoutMs === undefined ? {} : { timeoutMs: options.searchTimeoutMs }),
    ...(options.onTimeout === undefined ? {} : { onTimeout: options.onTimeout }),
  });

  registerSearchRoutes(app, { search });
  return { search };
}
