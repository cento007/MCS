import type { Db } from '@mc/shared';
import { sql } from 'drizzle-orm';
import { ApiError, type ListEnvelope } from '../http/errors.js';
import { encodeSearchCursor, type SearchCursor, searchFingerprint } from './cursors.js';
import { toSnippet } from './highlight.js';
import { assertQueryNodesWithinBudget } from './parse.js';
import { buildQueryNodeCount, buildSearchQuery, type SearchRow } from './query.js';
import { SEARCH_TYPES, type SearchResultResource, type SearchType } from './types.js';

/**
 * `GET /api/v1/search` (TDS 04 §11) — keyword full-text search over PostgreSQL.
 *
 * Read-only: no writes, no events, no audit entry. Searching is not an action on the system, and
 * a `search.*` event would be a per-keystroke firehose with no consumer.
 */

/**
 * PostgreSQL `query_canceled` — what `statement_timeout` raises.
 *
 * Note it is the same SQLSTATE as an explicit `pg_cancel_backend`; nothing else in this
 * transaction can produce it, so attributing it to the timeout is safe here and would not be in
 * a general-purpose helper.
 */
const QUERY_CANCELED = '57014';

/**
 * The other half of the query bound (`parse.ts` caps the tsquery; this caps the wall clock).
 *
 * A node-capped query over a single-user corpus finishes in milliseconds, so this is not a
 * tuning knob — it is the backstop for the case the cap cannot see: a corpus that has grown
 * past what five GIN scans answer quickly. Five seconds is far beyond any healthy search and far
 * short of holding a connection open while an operator gives up and retries.
 *
 * Set with `SET LOCAL` inside the transaction, so it applies to this statement and is discarded
 * with the transaction rather than leaking into the next borrower of the pooled connection.
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 5_000;

export interface SearchParams {
  readonly q: string;
  readonly types: readonly SearchType[];
  readonly limit: number;
  readonly cursor?: SearchCursor | undefined;
}

export interface SearchServiceOptions {
  readonly db: Db;
  /** Overridden by tests to prove the timeout is real rather than aspirational. */
  readonly timeoutMs?: number | undefined;
  readonly onTimeout?: ((q: string, timeoutMs: number) => void) | undefined;
}

export class SearchService {
  readonly #db: Db;
  readonly #timeoutMs: number;
  readonly #onTimeout: ((q: string, timeoutMs: number) => void) | undefined;

  constructor(options: SearchServiceOptions) {
    this.#db = options.db;
    const timeout = options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
    // Interpolated into `SET LOCAL` (which takes no bind parameters), so it is validated here
    // rather than trusted. Nothing but this constructor can reach that statement.
    if (!Number.isInteger(timeout) || timeout <= 0) {
      throw new Error(`Search timeout must be a positive integer of milliseconds: ${timeout}`);
    }
    this.#timeoutMs = timeout;
    this.#onTimeout = options.onTimeout;
  }

  /**
   * One page of results, ordered by relevance across every requested type.
   *
   * **No match is `{ data: [] }`, not a 404** — the route exists, the search ran, and the answer
   * is "nothing". The same is true of a query that parses to zero terms (`?q=the`): the
   * distinction a client needs is between "searched, found nothing" and "could not search", and
   * only the second is an error.
   */
  async search(params: SearchParams): Promise<ListEnvelope<SearchResultResource>> {
    const rows = await this.#run(params);

    const data = rows.map(toResource);
    const fingerprint = searchFingerprint(params.q, params.types);

    // F5.3: `nextCursor` is non-null only on a full page, so a client stops on `null` rather
    // than on an empty page.
    const last = rows.length === params.limit ? rows[rows.length - 1] : undefined;

    return {
      data,
      meta: {
        nextCursor:
          last === undefined
            ? null
            : encodeSearchCursor(
                {
                  rankKey: last.rank_key,
                  occurredAt: asDate(last.occurred_at),
                  id: last.id,
                },
                fingerprint,
              ),
        limit: params.limit,
      },
    };
  }

  /**
   * The bounded database work: one read-only transaction carrying a statement timeout, a
   * `numnode` probe, and — only if the probe found something to look for — the §4.6 query.
   *
   * Read-only is defence in depth rather than ceremony: this is the one place in the Backend
   * that assembles SQL from a request-shaped list of fragments, and a read-only transaction
   * makes "could this ever write" a question PostgreSQL answers instead of a question review
   * has to.
   */
  async #run(params: SearchParams): Promise<SearchRow[]> {
    try {
      return await this.#db.transaction(
        async (tx) => {
          await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${this.#timeoutMs}`));

          const probe = await tx.execute<{ nodes: number }>(buildQueryNodeCount(params.q));
          const nodes = Number(probe.rows[0]?.nodes ?? 0);
          assertQueryNodesWithinBudget(nodes);
          if (nodes === 0) return [];

          const result = await tx.execute<SearchRow>(buildSearchQuery(params));
          return [...result.rows];
        },
        { accessMode: 'read only' },
      );
    } catch (error) {
      if (!isQueryCanceled(error)) throw error;
      this.#onTimeout?.(params.q, this.#timeoutMs);
      // There is no timeout code in the §1.3 registry and inventing one would amend a contract
      // this workstream does not own, so the honest available answer is `INTERNAL`: the server
      // failed to produce an answer. `details` states the bound, which is a published limit
      // rather than a server internal, so a client can tell this apart from a generic 500.
      throw new ApiError(
        'INTERNAL',
        'Search did not complete within its time budget. Try a more specific query.',
        { timeoutMs: this.#timeoutMs },
      );
    }
  }
}

function toResource(row: SearchRow): SearchResultResource {
  return {
    type: asSearchType(row.type),
    id: row.id,
    title: row.title,
    snippet: toSnippet(row.snippet),
    occurredAt: asDate(row.occurred_at).toISOString(),
    rank: Number(row.rank),
    context: {
      projectId: row.project_id,
      repositoryId: row.repository_id,
      sessionId: row.session_id,
    },
  };
}

/**
 * The discriminator is a literal in each branch of the `UNION ALL`, so this can only fail if a
 * branch and this list disagree — which is a bug in `query.ts`, not data. It throws rather than
 * defaulting: a result typed `session` that is actually a Message links the operator to the
 * wrong screen, and a wrong link is worse than a failed request.
 */
function asSearchType(value: string): SearchType {
  if ((SEARCH_TYPES as readonly string[]).includes(value)) return value as SearchType;
  throw new Error(`Search returned an unknown result type: ${value}`);
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Is this PostgreSQL cancelling the statement?
 *
 * The cause chain is walked because Drizzle 0.45 wraps every driver failure in a
 * `DrizzleQueryError` whose `cause` is the `pg` error — so the SQLSTATE is one level down, and a
 * check that only looked at the thrown object would silently never fire. That is the difference
 * between a timeout that is enforced and a timeout that merely appears to be.
 */
function isQueryCanceled(error: unknown): boolean {
  for (let current = error, depth = 0; current !== null && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;
    if ((current as { readonly code?: unknown }).code === QUERY_CANCELED) return true;
    current = (current as { readonly cause?: unknown }).cause ?? null;
  }
  return false;
}
