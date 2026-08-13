import { createHash } from 'node:crypto';
import { ApiError } from '../http/errors.js';
import { decodeCursor, encodeCursor } from '../http/pagination.js';
import type { SearchType } from './types.js';

/**
 * The search cursor (TDS 04 §11, matching TDS 03 §4.6).
 *
 * **This is the one list in the system whose cursor is not a UUIDv7 keyset.** Every other
 * resource orders by something intrinsic to a single table, so F5.3's default — base64 of the
 * `id` — is the ordering key. Search results are a `UNION ALL` across five tables ordered by
 * *relevance*, and relevance is a property of the (row, query) pair rather than of the row. So
 * the ordering key is the triple the query actually sorts on:
 *
 *     ORDER BY rank DESC, occurred_at DESC, id DESC
 *
 * All three parts are load-bearing. `rank` alone collides constantly — `ts_rank_cd` over short
 * documents produces long runs of identical values, and two Sessions with the same title match
 * identically. `(rank, occurredAt)` still collides for rows written in the same instant, which
 * is exactly what a backfill sync produces. `id` breaks the last tie and is unique, so the
 * composite is total and a page boundary can never hide a row.
 *
 * **`rank` travels as its PostgreSQL text form, not as a JS number.** `ts_rank_cd` returns
 * `real` (float4); the keyset predicate compares the cursor value back against that same
 * expression, so any lossy step between the two turns an equality into an inequality and drops
 * or repeats a row at the boundary. Carrying the exact text PostgreSQL emitted and casting it
 * back with `::real` makes the round-trip bit-exact by construction rather than by floating-point
 * luck. (`SearchResultResource.rank` is still a `number` — that is the API contract; this is the
 * internal key.)
 *
 * **A cursor is bound to the search that produced it.** §11: "a cursor is only valid for the
 * `q`/`types` combination that produced it, and a client changing either must restart from the
 * first page." Ranks are stable for a fixed query string — which is what makes the keyset sound
 * at all — and meaningless against a different one, so a cursor carries a fingerprint of
 * `(q, types)` and a mismatch is `INVALID_CURSOR` (400). Without it, editing the search box and
 * reusing the cursor silently returns a page from nowhere: the ranks are drawn from a different
 * distribution, so the keyset admits an essentially arbitrary subset and the client sees a
 * plausible, wrong answer. `INVALID_CURSOR` is the registry's own wording for a "foreign"
 * cursor (§1.3) and this is precisely that.
 *
 * The encoding stays opaque and base64url per F5.3 — clients do not parse it, and the
 * fingerprint is a keyed-free digest, not a secret.
 */

export interface SearchCursor {
  /** `ts_rank_cd(...)::text`, verbatim from PostgreSQL. See the module header. */
  readonly rankKey: string;
  readonly occurredAt: Date;
  readonly id: string;
}

const SEPARATOR = '|';
const FINGERPRINT_LENGTH = 16;

/**
 * A short digest of the search a cursor belongs to.
 *
 * `q` is used exactly as the caller sent it (after the route's own trim): any change to the
 * text is a different search, including a change that `websearch_to_tsquery` would normalize
 * away. Erring toward "restart from page one" is free; erring the other way returns a wrong
 * page that looks right.
 *
 * `types` arrives already deduplicated and canonically ordered (`parse.ts`), so
 * `types=adr,session` and `types=session,adr` share a fingerprint — they are the same search.
 */
export function searchFingerprint(q: string, types: readonly SearchType[]): string {
  return createHash('sha256')
    .update(JSON.stringify([q, types]))
    .digest('base64url')
    .slice(0, FINGERPRINT_LENGTH);
}

export function encodeSearchCursor(cursor: SearchCursor, fingerprint: string): string {
  return encodeCursor(
    [fingerprint, cursor.rankKey, cursor.occurredAt.toISOString(), cursor.id].join(SEPARATOR),
  );
}

/**
 * Decode a cursor and check it belongs to this search.
 *
 * @throws {ApiError} `INVALID_CURSOR` (400) for an unparseable value, or for one issued against
 * a different `q`/`types` combination.
 */
export function decodeSearchCursor(
  cursor: string | undefined,
  fingerprint: string,
): SearchCursor | undefined {
  if (cursor === undefined) return undefined;

  const parts = decodeCursor(cursor).split(SEPARATOR);
  if (parts.length !== 4) throw invalidCursor();

  const [issuedFor, rankKey, occurredAtText, id] = parts as [string, string, string, string];

  if (issuedFor !== fingerprint) {
    throw new ApiError(
      'INVALID_CURSOR',
      'Cursor was issued for a different search — restart from the first page when q or types changes',
      // Named rather than described: a client that changed `q` mid-walk has to be told which
      // knob invalidated the cursor, and echoing the two candidates is not a disclosure.
      { parameter: 'cursor', invalidatedBy: ['q', 'types'] },
    );
  }

  const occurredAt = new Date(occurredAtText);
  if (rankKey.length === 0 || Number.isNaN(occurredAt.getTime()) || id.length === 0) {
    throw invalidCursor();
  }
  // The keyset casts this straight back to `real`; anything that is not a PostgreSQL float
  // literal would be a cast error (a 500) instead of a rejected cursor (a 400).
  if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(rankKey)) throw invalidCursor();

  return { rankKey, occurredAt, id };
}

function invalidCursor(): ApiError {
  return new ApiError('INVALID_CURSOR', 'Cursor is not a valid pagination cursor');
}
