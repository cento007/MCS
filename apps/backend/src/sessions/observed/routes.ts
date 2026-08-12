import type { FastifyInstance } from 'fastify';
import { INGEST_ROUTE } from '../../auth/guard.js';
import { normalizeHookRequestBody } from './hook-events.js';
import type { ObservedIngestService } from './ingest.js';

/**
 * `POST /api/v1/hook-events` — the observed-session ingest endpoint (TDS 04 §6.8).
 *
 * **Auth (§6.8).** `INGEST_ROUTE` from `auth/guard.ts`, not a locally re-derived policy: a
 * bearer API token with scope `ingest` (or `full`), and **cookie auth rejected with 403**. The
 * scope only means something if exactly one place decides what it permits, and that place is
 * the guard.
 *
 * **Fast ACK (§6.1).** The handler validates, runs one bounded transaction and returns `204`.
 * It never opens a file: the transcript tailer is scheduled from inside the service and is
 * deliberately not awaited. A slow hook endpoint stalls the operator's own CLI session, which
 * is the one failure mode this endpoint may not have.
 *
 * **Tolerance (F1.5).** The JSON-schema gate here is deliberately loose — object, bounded size —
 * and the real parsing happens in `normalizeHookRequestBody`, which accepts both the documented
 * envelope and a raw Claude Code hook body, keeps unrecognised `payload` shapes verbatim, and
 * rejects only the two fields we cannot proceed without.
 */

/**
 * 256 KiB, matching the prompt endpoint's cap (§6.4): a `PostToolUse` payload carries a tool
 * result, and the request body limit is the only thing standing between a large one and the
 * default 1 MiB whole-app limit.
 */
export const HOOK_EVENT_BODY_LIMIT_BYTES = 256 * 1024;

/**
 * `additionalProperties: true` is the point, not an oversight. The runtime owns this body's
 * shape and adds fields between versions; a strict schema would turn a Claude Code upgrade into
 * a wall of 400s in the operator's terminal (F1.5 version-drift rule).
 */
const hookEventBodySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    hookEventName: { type: 'string', maxLength: 64 },
    hook_event_name: { type: 'string', maxLength: 64 },
    runtimeSessionId: { type: 'string', maxLength: 128 },
    session_id: { type: 'string', maxLength: 128 },
    transcriptPath: { type: 'string', maxLength: 4096 },
    transcript_path: { type: 'string', maxLength: 4096 },
    cwd: { type: 'string', maxLength: 4096 },
    occurredAt: { type: 'string', maxLength: 64 },
    payload: { type: 'object', additionalProperties: true },
  },
} as const;

export interface ObservedRoutesOptions {
  readonly ingest: ObservedIngestService;
}

export function registerObservedRoutes(app: FastifyInstance, options: ObservedRoutesOptions): void {
  app.post(
    '/api/v1/hook-events',
    {
      config: { auth: INGEST_ROUTE },
      bodyLimit: HOOK_EVENT_BODY_LIMIT_BYTES,
      schema: { body: hookEventBodySchema },
    },
    async (request, reply) => {
      const event = normalizeHookRequestBody(request.body);
      const outcome = await options.ingest.ingest(event);

      request.log.debug(
        {
          hookEventName: event.hookEventName,
          runtimeSessionId: event.runtimeSessionId,
          sessionId: outcome.sessionId,
          created: outcome.created,
          ignored: outcome.ignored,
        },
        'hook event ingested',
      );

      // §6.8: `204`. No body — there is nothing the runtime can do with one, and every byte
      // here is a byte the operator's CLI waits for.
      reply.code(204);
      return null;
    },
  );
}
