import type { FastifyRequest } from 'fastify';

/**
 * The per-request facts a domain service needs for an audit row (TDS 03 §3.14) — and nothing
 * else. Domain services take this instead of a `FastifyRequest` so they stay callable from a
 * queue consumer or a CLI, where there is no request.
 */
export interface RequestContext {
  /** F5.4 `requestId`; the same value the error envelope and every log line carry. */
  readonly requestId: string;
  readonly ipAddress: string | null;
}

export function requestContextOf(request: FastifyRequest): RequestContext {
  return {
    requestId: request.id,
    ipAddress: request.ip.length > 0 ? request.ip : null,
  };
}
