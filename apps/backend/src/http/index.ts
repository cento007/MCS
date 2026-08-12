import { newId } from '@mc/shared';
import type { FastifyError, FastifyInstance } from 'fastify';
import { ApiError, errorEnvelope } from './errors.js';

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
 * reply, the F5.4 error envelope for thrown errors, and the F5.4 envelope for 404s
 * (which Fastify otherwise renders in its own shape).
 */
export function registerHttpConventions(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply) => {
    reply.header(REQUEST_ID_HEADER, request.id);
  });

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

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      request.log.warn({ err: error, code: error.code }, 'request failed');
      void reply
        .code(error.statusCode)
        .send(errorEnvelope(error.code, error.message, request.id, error.details));
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

export * from './errors.js';
