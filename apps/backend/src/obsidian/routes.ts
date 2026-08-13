import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../auth/guard.js';
import { requestContextOf } from '../http/context.js';
import { dataEnvelope } from '../http/errors.js';
import { clampLimit, decodeIdCursor, paginate } from '../http/pagination.js';
import type { ObsidianService } from './service.js';

/**
 * `/api/v1/sync-runs/*` — TDS 04 §10.
 *
 *   POST /api/v1/sync-runs          trigger a manual sync -> 202 (state `queued`)
 *   GET  /api/v1/sync-runs          cursor list, newest first
 *   GET  /api/v1/sync-runs/preview  ⚠ dry run — plan only, writes nothing
 *   GET  /api/v1/sync-runs/{id}     the run, plus unresolved conflicts and file errors
 *
 * **Contract note — the path.** The feature brief for this workstream calls the trigger
 * `POST /api/v1/sync`; TDS 04 §10 calls it `POST /api/v1/sync-runs`, gives it the `SyncRun`
 * resource, and the frontend's endpoint table (`lib/api/endpoints.ts`) already reads
 * `syncRuns: '/sync-runs'`. The TDS and the existing client agree, so `/sync-runs` is what
 * ships; no alias is added, because two paths for one action is how a client ends up
 * depending on the one that was never meant to exist.
 *
 * `/preview` is registered before `/:id` for readability only — Fastify's router prefers a
 * static segment over a parametric one regardless of declaration order, so `preview` can never
 * be swallowed as an id (and an id is `uuid`-patterned anyway).
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
  },
} as const;

/**
 * `{ kind: 'obsidian' }` per §10. The field is optional and enumerated: `obsidian` is the only
 * kind the schema admits (TDS 03 §4.5's CHECK), so a caller asking for anything else is told
 * so instead of silently getting a vault sync.
 */
const triggerBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: { kind: { type: 'string', enum: ['obsidian'] } },
} as const;

interface IdParams {
  id: string;
}
interface ListQuery {
  limit?: number;
  cursor?: string;
}

export interface ObsidianRoutesOptions {
  readonly obsidian: ObsidianService;
}

export function registerObsidianRoutes(app: FastifyInstance, options: ObsidianRoutesOptions): void {
  const { obsidian } = options;

  app.post('/api/v1/sync-runs', { schema: { body: triggerBodySchema } }, async (request, reply) => {
    const run = await obsidian.trigger(requirePrincipal(request), requestContextOf(request));
    reply.code(202);
    return dataEnvelope(run);
  });

  app.get<{ Querystring: ListQuery }>(
    '/api/v1/sync-runs',
    { schema: { querystring: listQuerySchema } },
    async (request) => {
      const limit = clampLimit(request.query.limit);
      const rows = await obsidian.list({
        limit,
        beforeId: decodeIdCursor(request.query.cursor),
      });
      return paginate(rows, limit, (row) => row.id);
    },
  );

  // §1.2: a bounded read model returns `{ data: … }` with no `meta`.
  app.get('/api/v1/sync-runs/preview', async () => dataEnvelope(await obsidian.preview()));

  app.get<{ Params: IdParams }>(
    '/api/v1/sync-runs/:id',
    { schema: { params: idParamsSchema } },
    async (request) => dataEnvelope(await obsidian.get(request.params.id)),
  );
}
