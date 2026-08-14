import { MEMORY_SOURCE_TYPES, PRODUCIBLE_MEMORY_TIERS } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../http/errors.js';
import { dataEnvelopeSchema } from '../http/response-schema.js';
import type { MemoryIndexService } from './indexing.js';
import {
  memoryBackfillAcceptedSchema,
  memoryBackfillStatusSchema,
  memoryItemSchema,
  memorySearchResponseSchema,
} from './response-schemas.js';
import {
  MAX_MEMORY_QUERY_LENGTH,
  MAX_MEMORY_SEARCH_LIMIT,
  type MemorySearchService,
} from './retrieval.js';

/**
 * `/api/v1/memory-items/*` — TDS 04 §13.1, which reserved these routes as "interface only, no
 * payload detail". This is that detail.
 *
 *   POST /api/v1/memory-items/search     semantic query -> 200 { data: { results, … } }
 *   GET  /api/v1/memory-items/{id}       one chunk, with its reachable context
 *   POST /api/v1/memory-items/backfill   trigger an index run -> 202 { data: { runId … } }
 *   GET  /api/v1/memory-items/backfill   the active run, or the most recent one
 *
 * ## Two of §13.1's four reserved routes are deliberately absent
 *
 * `POST /api/v1/memory-items` ("store a MemoryItem") and `DELETE /api/v1/memory-items/{id}` are
 * **not implemented**, and that is a decision rather than an omission.
 *
 * A hand-written MemoryItem has no source. Every row in this table is a *projection* of
 * something the database already holds, keyed by `(source, chunk, model)`, and the whole
 * idempotence story — re-index writes nothing, a changed source re-embeds only what changed —
 * is built on that key. A row with no source would be re-created by nothing, deleted by
 * nothing, and re-embedded by nothing when the model changed: a permanent straggler that the
 * `ix_memory_items_model` work list would find and never be able to fix. The honest place for
 * free-form operator knowledge is an Obsidian note, which this system already indexes.
 *
 * Likewise a single-chunk `DELETE` would delete one chunk of a document whose other chunks stay,
 * and the next index run would put it straight back — deletion that does not stick is worse than
 * no deletion. Forgetting is expressed at source granularity instead: archive the Session.
 *
 * ## Why search is a POST
 *
 * §13.1 says `POST .../search` and it is right for a reason worth recording: the query is
 * natural-language prose up to 2 000 characters plus a filter object, which is a body, not a
 * query string. It is also not cacheable — the answer depends on the index, which changes
 * underneath it — so the usual argument for GET does not apply.
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
 * `additionalProperties: false` everywhere, as every other body in this API has: an unknown
 * field is a `400` rather than a filter that silently does nothing. That is the exact defect
 * the list routes still carry for *query* parameters, and there is no reason to repeat it in a
 * body written from scratch.
 */
const searchBodySchema = {
  type: 'object',
  required: ['q'],
  additionalProperties: false,
  properties: {
    q: { type: 'string', minLength: 1, maxLength: MAX_MEMORY_QUERY_LENGTH },
    limit: { type: 'integer', minimum: 1, maximum: MAX_MEMORY_SEARCH_LIMIT },
    projectId: { type: 'string', pattern: UUID_PATTERN },
    sessionId: { type: 'string', pattern: UUID_PATTERN },
    tiers: {
      type: 'array',
      minItems: 1,
      maxItems: PRODUCIBLE_MEMORY_TIERS.length,
      uniqueItems: true,
      // `agent` is absent because nothing produces it (Phase 4): admitting a tier that can
      // never match would make an empty result look like a scope problem.
      items: { type: 'string', enum: [...PRODUCIBLE_MEMORY_TIERS] },
    },
    sourceTypes: {
      type: 'array',
      minItems: 1,
      maxItems: MEMORY_SOURCE_TYPES.length,
      uniqueItems: true,
      items: { type: 'string', enum: [...MEMORY_SOURCE_TYPES] },
    },
    /**
     * Overriding the relevance floor. `0` is allowed and means "show me everything you have",
     * which is a legitimate debugging request and an illegitimate default — hence the default
     * being `DEFAULT_MIN_SCORE` and not this.
     */
    minScore: { type: 'number', minimum: 0, maximum: 1 },
  },
} as const;

const backfillBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    /**
     * `rebuild` **destroys every stored vector** and re-indexes from zero. It is the model-change
     * path and nothing else; `incremental` is the default precisely so the destructive one has
     * to be typed.
     */
    mode: { type: 'string', enum: ['incremental', 'rebuild'] },
  },
} as const;

interface IdParams {
  id: string;
}

interface SearchBody {
  q: string;
  limit?: number;
  projectId?: string;
  sessionId?: string;
  tiers?: string[];
  sourceTypes?: string[];
  minScore?: number;
}

interface BackfillBody {
  mode?: 'incremental' | 'rebuild';
}

export interface MemoryRoutesOptions {
  readonly search: MemorySearchService;
  readonly indexing: MemoryIndexService;
}

export function registerMemoryRoutes(app: FastifyInstance, options: MemoryRoutesOptions): void {
  app.post<{ Body: SearchBody }>(
    '/api/v1/memory-items/search',
    {
      schema: {
        body: searchBodySchema,
        response: { 200: dataEnvelopeSchema(memorySearchResponseSchema) },
      },
    },
    async (request) => {
      const body = request.body;
      return dataEnvelope(
        await options.search.search({
          q: body.q.trim(),
          limit: body.limit,
          ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
          ...(body.sessionId === undefined ? {} : { sessionId: body.sessionId }),
          ...(body.tiers === undefined
            ? {}
            : { tiers: body.tiers as (typeof PRODUCIBLE_MEMORY_TIERS)[number][] }),
          ...(body.sourceTypes === undefined
            ? {}
            : { sourceTypes: body.sourceTypes as (typeof MEMORY_SOURCE_TYPES)[number][] }),
          ...(body.minScore === undefined ? {} : { minScore: body.minScore }),
        }),
      );
    },
  );

  // Registered before `/:id` so the literal segment cannot be parsed as a UUID parameter. It
  // could not be anyway — `:id` is pattern-validated — but relying on that is relying on a
  // validator to do a router's job.
  app.post<{ Body: BackfillBody }>(
    '/api/v1/memory-items/backfill',
    {
      schema: {
        body: backfillBodySchema,
        response: { 202: dataEnvelopeSchema(memoryBackfillAcceptedSchema) },
      },
    },
    async (request, reply) => {
      const run = await options.indexing.trigger({ mode: request.body?.mode ?? 'incremental' });
      reply.code(202);
      return dataEnvelope({
        runId: run.id,
        state: run.state,
        mode: request.body?.mode ?? 'incremental',
        createdAt: run.createdAt.toISOString(),
      });
    },
  );

  app.get(
    '/api/v1/memory-items/backfill',
    { schema: { response: { 200: dataEnvelopeSchema(memoryBackfillStatusSchema) } } },
    async () => dataEnvelope(await options.indexing.status()),
  );

  app.get<{ Params: IdParams }>(
    '/api/v1/memory-items/:id',
    {
      schema: {
        params: idParamsSchema,
        response: { 200: dataEnvelopeSchema(memoryItemSchema) },
      },
    },
    async (request) => dataEnvelope(await options.search.get(request.params.id)),
  );
}
