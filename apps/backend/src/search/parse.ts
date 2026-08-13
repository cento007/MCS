import { ApiError } from '../http/errors.js';
import { SEARCH_TYPES, type SearchType } from './types.js';

/**
 * `?types=` parsing (TDS 04 §11) and the query-text bounds.
 *
 * Pure functions with no database and no Fastify — the unit tier proves the rejection rules
 * without PostgreSQL, which is the property `pnpm test` exists to keep.
 */

/**
 * Comma-separated singular discriminators -> a deduplicated, canonically ordered list.
 *
 * **Omitted searches all five** (§11). An unrecognized value is `VALIDATION_FAILED` (400) with
 * the offending value in `details` — including the withdrawn plural spellings, which is the
 * point: `types=sessions` fails loudly instead of quietly searching everything.
 *
 * The result is sorted into `SEARCH_TYPES` order rather than the caller's order, because the
 * cursor fingerprint (`cursors.ts`) is computed over it and `types=adr,session` and
 * `types=session,adr` are the same search.
 */
export function parseSearchTypes(raw: string | undefined): readonly SearchType[] {
  if (raw === undefined) return SEARCH_TYPES;

  const known = new Set<string>(SEARCH_TYPES);
  const requested = new Set<SearchType>();
  const rejected: string[] = [];

  for (const part of raw.split(',')) {
    const value = part.trim();
    // An empty segment is a typo with a comma in it (`types=session,`), not a request for
    // everything — treating it as "all five" would silently widen the search.
    if (!known.has(value)) {
      rejected.push(value);
      continue;
    }
    requested.add(value as SearchType);
  }

  if (rejected.length > 0) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `Unknown search type${rejected.length === 1 ? '' : 's'}: ${rejected.join(', ')}`,
      { parameter: 'types', rejected, allowed: [...SEARCH_TYPES] },
    );
  }

  // Unreachable through the route (`minLength: 1` plus the rejection above), but a caller
  // reaching the service directly with `','` must not silently get an all-types search.
  if (requested.size === 0) {
    throw new ApiError('VALIDATION_FAILED', 'No search type was requested', {
      parameter: 'types',
      allowed: [...SEARCH_TYPES],
    });
  }

  return SEARCH_TYPES.filter((type) => requested.has(type));
}

/**
 * The maximum number of `tsquery` nodes (lexemes **plus** operators, as counted by PostgreSQL's
 * `numnode`) a single search may contain.
 *
 * This is the query bound, and it is measured on the parsed tsquery rather than on the raw
 * string because that is the thing whose size actually costs: `websearch_to_tsquery` drops
 * stopwords and stems, so "the quick brown fox" is three nodes, not four, and a 256-character
 * `q` of punctuation is zero. 64 nodes is far past any human search and far short of anything
 * that makes five GIN scans expensive.
 *
 * It is the *second* bound. The first is `maxLength: 256` on `q` in the route schema, which
 * caps the parse itself; this one caps what the parse produced.
 */
export const MAX_QUERY_NODES = 64;

/** `q` is bounded before it reaches PostgreSQL; the route schema enforces the same number. */
export const MAX_QUERY_LENGTH = 256;

export function assertQueryNodesWithinBudget(nodes: number): void {
  if (nodes <= MAX_QUERY_NODES) return;
  throw new ApiError(
    'VALIDATION_FAILED',
    `Search query is too complex: ${nodes} terms and operators, maximum ${MAX_QUERY_NODES}`,
    { parameter: 'q', queryNodes: nodes, maxQueryNodes: MAX_QUERY_NODES },
  );
}
