import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit } from '../http/pagination.js';
import { decodePullRequestCursor, encodePullRequestCursor } from './cursors.js';
import { PULL_REQUEST_STATES } from './serialize.js';
import type { PullRequestService } from './service.js';

/**
 * The PullRequest routes of TDS 04 §5.3:
 *
 *   GET /api/v1/pull-requests                     cursor list; `?repositoryId=`, `?state=`
 *   GET /api/v1/repositories/{id}/pull-requests   nested convenience list; `?state=`
 *   GET /api/v1/pull-requests/{id}                single PR, plus `description`
 *
 * All three read-only, per §5.3: PR *actions* (create, describe, summarise reviews) are Phase 2
 * assisted-mode work under sanctioned deviation D8, so this resource has no writer in Phase 1
 * other than the GitHub sync.
 *
 * `?state=` accepts the four **GitHub-truth** states (arbitration A3): `open`, `merged`,
 * `closed`, `draft`. It is also the query behind the "OPEN PRs" column of TDS 06 §5.3.2 —
 * which is precisely a filter an operator must never believe is applied when it is not, and
 * `http/query-strictness.ts` is what makes `?stat=open` a 400 instead of "every PR ever".
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    repositoryId: { type: 'string', pattern: UUID_PATTERN },
    state: { type: 'string', enum: [...PULL_REQUEST_STATES] },
  },
} as const;

/** The nested route fixes the Repository in the path, so `?repositoryId=` would be a second, contradictable source. */
const nestedListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    state: { type: 'string', enum: [...PULL_REQUEST_STATES] },
  },
} as const;

interface IdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  repositoryId?: string;
  state?: (typeof PULL_REQUEST_STATES)[number];
}
type NestedListQuery = Omit<ListQuery, 'repositoryId'>;

export interface PullRequestRoutesOptions {
  readonly pullRequests: PullRequestService;
}

export function registerPullRequestRoutes(
  app: FastifyInstance,
  options: PullRequestRoutesOptions,
): void {
  const { pullRequests } = options;

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/pull-requests',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const rows = await pullRequests.list({
        limit,
        after: decodePullRequestCursor(request.query.cursor),
        repositoryId: request.query.repositoryId,
        state: request.query.state,
      });
      return page(rows, limit);
    },
  );

  app.get<{ Params: IdParams; Querystring: NestedListQuery }>(
    '/api/v1/repositories/:id/pull-requests',
    { schema: { params: idParamsSchema, querystring: nestedListQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const rows = await pullRequests.listForRepository(request.params.id, {
        limit,
        after: decodePullRequestCursor(request.query.cursor),
        state: request.query.state,
      });
      return page(rows, limit);
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/pull-requests/:id',
    { schema: { params: idParamsSchema } },
    async (request) => dataEnvelope(await pullRequests.get(request.params.id)),
  );
}

/**
 * The F5.3 envelope with the `(openedAt, id)` cursor — not the default `paginate` helper, whose
 * ordering key is the `id` alone (see `cursors.ts` for why that would be the wrong order).
 */
function page<T extends { id: string; openedAt: string | null }>(
  rows: readonly T[],
  limit: number,
): { data: readonly T[]; meta: { nextCursor: string | null; limit: number } } {
  const last = rows.length === limit ? rows[rows.length - 1] : undefined;
  return {
    data: rows,
    meta: {
      nextCursor:
        last === undefined
          ? null
          : encodePullRequestCursor({
              openedAt: last.openedAt === null ? null : new Date(last.openedAt),
              id: last.id,
            }),
      limit,
    },
  };
}
