import type { FastifyInstance } from 'fastify';
import { clampLimit } from '../http/pagination.js';
import { decodeSearchCursor, searchFingerprint } from './cursors.js';
import { MAX_QUERY_LENGTH, parseSearchTypes } from './parse.js';
import type { SearchService } from './service.js';

/**
 * `GET /api/v1/search?q=<text>&types=<csv>&limit=<n>&cursor=<opaque>` — TDS 04 §11.
 *
 * Four parameters, and the schema below is also the allowlist: `http/query-strictness.ts`
 * derives the accepted names from exactly this object, so anything else is a 400 rather than a
 * filter that quietly does nothing. That is the concurrent convention this route inherits, and
 * it is the right one here — `?type=commit` (singular, a plausible typo for `?types=`) silently
 * searching all five types is precisely the class of wrong-and-confident answer it prevents.
 *
 * `q` is validated as a string and nothing more. It is a **search box**: `websearch_to_tsquery`
 * treats `"quoted phrases"`, `or` and `-exclusion` as syntax and everything else as words, and
 * it does not raise on junk (`query.ts`). Rejecting characters here would only mean rejecting
 * text that PostgreSQL would have handled correctly.
 */

const querySchema = {
  type: 'object',
  required: ['q'],
  additionalProperties: false,
  properties: {
    /**
     * The first of the two query bounds. `MAX_QUERY_NODES` (`parse.ts`) is the second and the
     * one that matters; this one caps the parse itself so a megabyte of URL never reaches
     * `websearch_to_tsquery`.
     */
    q: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
    /** Comma-separated singular discriminators. Parsed (and rejected) in `parse.ts`. */
    types: { type: 'string', minLength: 1, maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const;

interface SearchQuery {
  q: string;
  types?: string;
  limit?: number;
  cursor?: string;
}

export interface SearchRoutesOptions {
  readonly search: SearchService;
}

export function registerSearchRoutes(app: FastifyInstance, options: SearchRoutesOptions): void {
  app.get<{ Querystring: SearchQuery }>(
    '/api/v1/search',
    { schema: { querystring: querySchema } },
    async (request) => {
      const q = request.query.q.trim();
      const types = parseSearchTypes(request.query.types);
      const limit = clampLimit(request.query.limit);

      // The fingerprint is computed from *this* request's `q`/`types`, so a cursor minted for a
      // different search fails here rather than silently returning a page from another
      // distribution (§11, and the reasoning in `cursors.ts`).
      const cursor = decodeSearchCursor(request.query.cursor, searchFingerprint(q, types));

      return options.search.search({ q, types, limit, cursor });
    },
  );
}
