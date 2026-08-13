import { schema } from '@mc/shared';
import { type SQL, sql } from 'drizzle-orm';
import type { SearchCursor } from './cursors.js';
import { HEADLINE_OPTIONS } from './highlight.js';
import type { SearchType } from './types.js';

/**
 * The full-text query of TDS 03 §4.6 — the five-branch `UNION ALL`, its ranking, its keyset and
 * its highlighting — expressed over the Drizzle schema.
 *
 * Nothing here re-derives §4.6; it implements it. Worth restating because each choice is load-
 * bearing and none of them is obvious from the SQL alone:
 *
 *  - **`websearch_to_tsquery`, not `to_tsquery`.** It accepts raw operator input (`"quoted
 *    phrases"`, `or`, `-negation`) and **never raises a syntax error on junk**, which for a
 *    search box is the difference between a feature and a 500.
 *  - **`ts_rank_cd(search_tsv, query, 32)`.** Normalization flag `32` is `rank/(rank+1)`, which
 *    maps every rank into `(0,1)`. That is what makes five tables into one ordered list: without
 *    it, ranks from different branches are on incomparable scales and merging them produces an
 *    ordering that means nothing.
 *  - **`ts_headline` outside the `LIMIT`.** It re-parses the source document, so running it over
 *    the match set instead of the page is the difference between highlighting 20 documents and
 *    highlighting every Message that mentioned the word. The `page` CTE limits first; the outer
 *    select highlights what survived.
 *  - **`left(source, 100000)`** on the highlight input, mirroring the guard §4.6 puts on the
 *    generated `messages.search_tsv`. Highlighting past the indexed prefix would also be a lie:
 *    a match cannot exist out there, because the tsvector never saw it.
 *  - **Tool Messages are excluded with no predicate.** `messages.search_tsv` is `NULL` for any
 *    role outside `('user','assistant')` (§4.6), and `NULL @@ query` is `NULL`, which is not
 *    true — so the branch drops them and the partial GIN index never has to consider them.
 *
 * Every branch aliases **all** of its output columns, not just the first branch's. `?types=`
 * prunes branches, so any of the five can end up first, and in PostgreSQL a `UNION` takes its
 * column names from whichever branch that is.
 *
 * `chr(10)` appears where §4.6 writes `E'\n'`: identical to PostgreSQL, and free of the
 * backslash-escaping ambiguity of a newline inside a JS template literal inside a SQL string.
 */

/** §4.6's guard against PostgreSQL's 1 MB `tsvector` ceiling, reused for the headline input. */
const SOURCE_LIMIT = 100_000;

/** `pg_catalog.english` — schema-qualified so the expression is `search_path`-independent. */
const CONFIG = sql`'pg_catalog.english'`;

export interface SearchQueryParams {
  readonly q: string;
  readonly types: readonly SearchType[];
  readonly limit: number;
  readonly cursor?: SearchCursor | undefined;
}

export interface SearchRow extends Record<string, unknown> {
  type: string;
  id: string;
  title: string;
  occurred_at: Date | string;
  rank: number | string;
  /** `rank::text`, verbatim — the cursor's exact key (see `cursors.ts`). */
  rank_key: string;
  project_id: string | null;
  repository_id: string | null;
  session_id: string | null;
  snippet: string;
}

/**
 * One branch of the `UNION ALL`, per §4.6.
 *
 * `source` is the text `ts_headline` highlights, and it is the *original* text rather than the
 * tsvector — a tsvector has no word order and cannot be highlighted. Weighting lives in the
 * generated column; this expression only decides what the operator gets to read.
 */
const BRANCHES: Readonly<Record<SearchType, SQL>> = {
  session: sql`
    SELECT 'session'::text AS type,
           ${schema.sessions.id} AS id,
           coalesce(${schema.sessions.title}, '(untitled session)') AS title,
           ${schema.sessions.createdAt} AS occurred_at,
           ts_rank_cd(${schema.sessions.searchTsv}, q.query, 32) AS rank,
           coalesce(${schema.sessions.title}, '') || chr(10) || coalesce(${schema.sessions.notes}, '') AS source,
           ${schema.sessions.projectId} AS project_id,
           ${schema.sessions.repositoryId} AS repository_id,
           NULL::uuid AS session_id
      FROM ${schema.sessions} CROSS JOIN q
     WHERE ${schema.sessions.searchTsv} @@ q.query
       AND ${schema.sessions.state} <> 'archived'`,

  adr: sql`
    SELECT 'adr'::text AS type,
           ${schema.adrs.id} AS id,
           'ADR-' || lpad(${schema.adrs.adrNumber}::text, 4, '0') || ' — ' || ${schema.adrs.title} AS title,
           ${schema.adrs.updatedAt} AS occurred_at,
           ts_rank_cd(${schema.adrs.searchTsv}, q.query, 32) AS rank,
           ${schema.adrs.title} || chr(10) || ${schema.adrs.decision} || chr(10) || ${schema.adrs.context} AS source,
           ${schema.adrs.projectId} AS project_id,
           NULL::uuid AS repository_id,
           NULL::uuid AS session_id
      FROM ${schema.adrs} CROSS JOIN q
     WHERE ${schema.adrs.searchTsv} @@ q.query`,

  commit: sql`
    SELECT 'commit'::text AS type,
           ${schema.commits.id} AS id,
           split_part(${schema.commits.message}, chr(10), 1) AS title,
           ${schema.commits.committedAt} AS occurred_at,
           ts_rank_cd(${schema.commits.searchTsv}, q.query, 32) AS rank,
           ${schema.commits.message} AS source,
           ${schema.repositories.projectId} AS project_id,
           ${schema.commits.repositoryId} AS repository_id,
           ${schema.commits.sessionId} AS session_id
      FROM ${schema.commits}
      JOIN ${schema.repositories} ON ${schema.repositories.id} = ${schema.commits.repositoryId}
      CROSS JOIN q
     WHERE ${schema.commits.searchTsv} @@ q.query`,

  message: sql`
    SELECT 'message'::text AS type,
           ${schema.messages.id} AS id,
           ${schema.messages.role} || ' message' AS title,
           ${schema.messages.occurredAt} AS occurred_at,
           ts_rank_cd(${schema.messages.searchTsv}, q.query, 32) AS rank,
           ${schema.messages.content} AS source,
           ${schema.sessions.projectId} AS project_id,
           NULL::uuid AS repository_id,
           ${schema.messages.sessionId} AS session_id
      FROM ${schema.messages}
      JOIN ${schema.sessions} ON ${schema.sessions.id} = ${schema.messages.sessionId}
      CROSS JOIN q
     WHERE ${schema.messages.searchTsv} @@ q.query`,

  pull_request: sql`
    SELECT 'pull_request'::text AS type,
           ${schema.pullRequests.id} AS id,
           '#' || ${schema.pullRequests.number} || ' ' || ${schema.pullRequests.title} AS title,
           coalesce(${schema.pullRequests.openedAt}, ${schema.pullRequests.createdAt}) AS occurred_at,
           ts_rank_cd(${schema.pullRequests.searchTsv}, q.query, 32) AS rank,
           ${schema.pullRequests.title} || chr(10) || coalesce(${schema.pullRequests.description}, '') AS source,
           ${schema.repositories.projectId} AS project_id,
           ${schema.pullRequests.repositoryId} AS repository_id,
           NULL::uuid AS session_id
      FROM ${schema.pullRequests}
      JOIN ${schema.repositories} ON ${schema.repositories.id} = ${schema.pullRequests.repositoryId}
      CROSS JOIN q
     WHERE ${schema.pullRequests.searchTsv} @@ q.query`,
};

/**
 * "Strictly after the cursor row, in `(rank DESC, occurred_at DESC, id DESC)` order", written as
 * the nested comparison rather than a row-value one — Drizzle has no portable spelling for
 * `(a,b,c) < (x,y,z)` and the planner sees the same thing either way.
 *
 * The cast to `real` is what makes the equality case work: `rank` is `ts_rank_cd`'s `real`, and
 * comparing it against a `double precision` parameter promotes it, at which point "the same
 * rank" can stop being the same number and a row is silently dropped or repeated at every page
 * boundary. Equal ranks are the common case here, not the corner case.
 */
function keysetPredicate(cursor: SearchCursor | undefined): SQL {
  if (cursor === undefined) return sql`TRUE`;

  const rank = sql`${cursor.rankKey}::real`;
  const occurredAt = sql`${cursor.occurredAt.toISOString()}::timestamptz`;
  const id = sql`${cursor.id}::uuid`;

  return sql`(hits.rank < ${rank}
           OR (hits.rank = ${rank}
               AND (hits.occurred_at < ${occurredAt}
                    OR (hits.occurred_at = ${occurredAt} AND hits.id < ${id}))))`;
}

/**
 * The statement. Callers run it inside the read-only, statement-timeout-bounded transaction
 * `service.ts` opens — the timeout is the reason this returns SQL instead of running itself.
 */
export function buildSearchQuery(params: SearchQueryParams): SQL {
  const branches = params.types.map((type) => BRANCHES[type]);
  if (branches.length === 0) {
    // `parseSearchTypes` cannot produce this; a direct caller could.
    throw new Error('buildSearchQuery requires at least one search type');
  }

  return sql`
    WITH q AS (
      SELECT websearch_to_tsquery(${CONFIG}, ${params.q}) AS query
    ),
    hits AS (
      ${sql.join(branches, sql` UNION ALL `)}
    ),
    page AS (
      SELECT hits.*
        FROM hits
       WHERE ${keysetPredicate(params.cursor)}
       ORDER BY hits.rank DESC, hits.occurred_at DESC, hits.id DESC
       LIMIT ${params.limit}
    )
    SELECT page.type,
           page.id,
           page.title,
           page.occurred_at,
           page.rank,
           page.rank::text AS rank_key,
           page.project_id,
           page.repository_id,
           page.session_id,
           ts_headline(${CONFIG}, left(page.source, ${SOURCE_LIMIT}), q.query, ${HEADLINE_OPTIONS}) AS snippet
      FROM page CROSS JOIN q
     ORDER BY page.rank DESC, page.occurred_at DESC, page.id DESC`;
}

/**
 * `numnode(websearch_to_tsquery(...))` — the parsed size of the query, used as the query bound
 * (`parse.ts`) and as the "did this parse to anything at all" check.
 *
 * `numnode` on an empty tsquery is `0` and raises nothing, so `?q=the` (all stopwords) and
 * `?q=...` (all punctuation) are both answered as "0 nodes" rather than as errors. That matters
 * for more than tidiness: an empty tsquery matches nothing but PostgreSQL cannot serve
 * `@@ ''::tsquery` from a GIN index, so letting it through would sequentially scan `messages`
 * to prove a foregone conclusion.
 */
export function buildQueryNodeCount(q: string): SQL {
  return sql`SELECT numnode(websearch_to_tsquery(${CONFIG}, ${q})) AS nodes`;
}
