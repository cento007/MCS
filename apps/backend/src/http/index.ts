import { newId } from '@mc/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { registerBodyStrictness } from './body-strictness.js';
import { ApiError, type ErrorCode, errorEnvelope } from './errors.js';
import { registerQueryStrictness } from './query-strictness.js';
import { registerResponseConformance } from './response-conformance.js';
import { registerNonStrippingSerializer } from './response-schema.js';
import { registerRouteTable } from './route-table.js';

/**
 * `http/` — Fastify wiring: route plugins per domain, the F5.4 error envelope, request-id,
 * auth guards, and (in production) static SPA serving with deep-link fallback (F2.3).
 *
 * SCAFFOLD STATE: request-id and the error envelope are real and wired. Auth guards,
 * per-domain route plugins, OpenAPI generation from Fastify schemas (F5.1) and the static
 * SPA plugin land with WS1/WS2 implementation. `http/` owns NO business logic — routes
 * validate and delegate to domain modules (TDS 02 §2).
 */

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * UUIDv7 request ids (F4.2), honouring an inbound `X-Request-Id` so a correlation id can
 * be carried in from a hook POST or a CLI client.
 */
export function generateRequestId(inbound: unknown): string {
  return typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128
    ? inbound
    : newId();
}

/**
 * Register cross-cutting HTTP behaviour: the `X-Request-Id` response header on every
 * reply, the F5.4 error envelope for thrown errors, the F5.4 envelope for 404s
 * (which Fastify otherwise renders in its own shape), the route table every "every route"
 * question is answered from (`route-table.ts`), and strictness for both halves of the request
 * — query parameters (`query-strictness.ts`) and body fields (`body-strictness.ts`).
 *
 * Called before any route is registered, and that ordering is load-bearing for all three:
 * Fastify binds hooks to a route when the route is registered, so a hook added later would
 * cover nothing that already exists.
 */
export function registerHttpConventions(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

  // First: the two guards below publish views over this table, and the F5.1 OpenAPI document
  // is generated from it.
  registerRouteTable(app);

  // An unknown query parameter is a rejected request, not a dropped filter; an unknown body
  // field is a rejected request, not a dropped instruction. See each module header for why
  // that is a 400 and why each is a single global hook rather than a per-route opt-in.
  registerQueryStrictness(app);
  registerBodyStrictness(app);

  // The response half of the same principle, and the same trap read from the other side: an
  // undeclared *response* field must not be a dropped field. `registerNonStrippingSerializer`
  // makes the declared response schemas incapable of removing anything — which is what this
  // Backend already did before any of them existed — and `registerResponseConformance` is what
  // keeps them true, by validating every reply against its own schema in the test tiers.
  // See `response-schema.ts` for the full argument.
  registerNonStrippingSerializer(app);
  registerResponseConformance(app);

  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send(
        errorEnvelope(
          'NOT_FOUND',
          `Route ${request.method} ${request.url} does not exist`,
          request.id,
        ),
      );
  });

  /**
   * HTTP status → F5.4 registry code, for framework rejections that carry their own 4xx.
   * `VALIDATION_FAILED` is the fallback: an unmapped client error is, by definition, a request
   * the server would not accept as sent.
   */
  const CLIENT_ERROR_CODES: Readonly<Record<number, ErrorCode>> = {
    400: 'VALIDATION_FAILED',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    413: 'PAYLOAD_TOO_LARGE',
    429: 'RATE_LIMITED',
  };

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      request.log.warn({ err: error, code: error.code }, 'request failed');
      void reply
        .code(error.statusCode)
        .send(errorEnvelope(error.code, error.message, request.id, error.details));
      return;
    }

    // Fastify rejects an oversized body itself, before any handler runs — the prompt route caps
    // at 256 KiB (§6.4). Without this mapping it would surface as a 500 `INTERNAL`, hiding a
    // condition the caller can act on behind one it cannot.
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      request.log.warn({ err: error }, 'request body too large');
      void reply
        .code(413)
        .send(errorEnvelope('PAYLOAD_TOO_LARGE', 'Request body is too large', request.id));
      return;
    }

    // Fastify's own schema validation failures (F5.4 / TDS 04 §1.3).
    if (error.validation !== undefined) {
      request.log.warn({ err: error }, 'request validation failed');
      void reply.code(400).send(
        errorEnvelope('VALIDATION_FAILED', 'Request failed schema validation', request.id, {
          issues: error.validation,
        }),
      );
      return;
    }

    // Every *other* framework rejection that already knows it is the caller's fault.
    //
    // Fastify raises these before any handler runs and stamps a real 4xx `statusCode` on them:
    // an empty body under `content-type: application/json` (`FST_ERR_CTP_EMPTY_JSON_BODY`),
    // malformed JSON, an unsupported media type, and so on. Falling through to `INTERNAL`
    // told the caller "the server broke" for a request only they can fix — indistinguishable
    // from a genuine fault, and it trips retry and alerting logic that should stay quiet.
    // Observed: `POST /sessions/{id}/start` with an empty JSON body answered 500 while the
    // underlying error carried `statusCode: 400`.
    //
    // The status is the framework's; the code comes from the F5.4 registry so the envelope
    // stays closed. Fastify's messages describe the malformed request and contain no
    // server internals, so they are safe to pass through — unlike the 5xx branch below.
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 400 && status < 500) {
      const code = CLIENT_ERROR_CODES[status] ?? 'VALIDATION_FAILED';
      request.log.warn({ err: error, code }, 'request rejected');
      void reply.code(status).send(errorEnvelope(code, error.message, request.id));
      return;
    }

    // Anything unclassified: log everything, disclose nothing beyond the request id.
    request.log.error({ err: error }, 'unhandled error');
    void reply
      .code(500)
      .send(
        errorEnvelope(
          'INTERNAL',
          'An unexpected error occurred. Quote the requestId when reporting this.',
          request.id,
        ),
      );
  });
}

export * from './body-strictness.js';
export * from './errors.js';
export * from './query-strictness.js';
export * from './response-conformance.js';
export * from './response-schema.js';
export * from './route-table.js';
