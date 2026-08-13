import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit } from '../http/pagination.js';
import { decodeCommitCursor, encodeCommitCursor } from './cursors.js';
import type { CommitService } from './service.js';

/**
 * The Commit routes of TDS 04 §5.2:
 *
 *   GET /api/v1/repositories/{id}/commits   cursor list, newest first; `?sessionId=`, `?branch=`
 *   GET /api/v1/commits/{id}                single commit, **with** `files[]`
 *
 * Until now the only reader of the `commits` table anywhere in the product was
 * `GET /sessions/{id}/commits` (§6.10.1) — so the GitHub sync wrote rows that the Repository
 * screens had no way to ask for, and `files[]` (the per-file breakdown §5.2 puts on the single
 * fetch) had no endpoint at all.
 *
 * **`files[]` is on the single fetch and deliberately not on the list.** That is §5.2's split,
 * restated in §6.10.1: a list carrying every file of every commit turns the Session Files tab
 * into an N+1 walk and makes a 200-row page enormous for data no list renders.
 *
 * There is no top-level `GET /api/v1/commits` list. §5.2 defines two routes and this is both of
 * them; a commit is only meaningful under the Repository (or the Session) that produced it, and
 * a global commit feed is Phase 2 search (§11), which links *to* these routes.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const idParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

/**
 * Every accepted parameter, by name — and since `http/query-strictness.ts` derives the
 * allowlist from exactly this object, a name that is missing here is a `400`, never a filter
 * that quietly does nothing.
 */
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200 },
    cursor: { type: 'string', minLength: 1, maxLength: 512 },
    order: { type: 'string', enum: ['asc', 'desc'] },
    sessionId: { type: 'string', pattern: UUID_PATTERN },
    branch: { type: 'string', minLength: 1, maxLength: 255 },
  },
} as const;

interface IdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
  order?: 'asc' | 'desc';
  sessionId?: string;
  branch?: string;
}

export interface CommitRoutesOptions {
  readonly commits: CommitService;
}

export function registerCommitRoutes(app: FastifyInstance, options: CommitRoutesOptions): void {
  const { commits } = options;

  app.get<{ Params: IdParams; Querystring: ListQuery }>(
    '/api/v1/repositories/:id/commits',
    { schema: { params: idParamsSchema, querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      // §5.2: "newest first (`order=desc` default here)" — the one resource-level exception to
      // §1.2's ascending default, because "the last thing that happened" is what a commit list
      // is for.
      const order = request.query.order ?? 'desc';

      const rows = await commits.listForRepository(request.params.id, {
        limit,
        order,
        after: decodeCommitCursor(request.query.cursor),
        sessionId: request.query.sessionId,
        branch: request.query.branch,
      });

      // Keyed on `(committedAt, id)`, never `id` alone (see `cursors.ts`), so this cannot go
      // through the default `paginate` helper.
      const last = rows.length === limit ? rows[rows.length - 1] : undefined;
      return {
        data: rows,
        meta: {
          nextCursor:
            last === undefined
              ? null
              : encodeCommitCursor({ committedAt: new Date(last.committedAt), id: last.id }),
          limit,
        },
      };
    },
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/commits/:id',
    { schema: { params: idParamsSchema } },
    async (request) => dataEnvelope(await commits.get(request.params.id)),
  );
}
