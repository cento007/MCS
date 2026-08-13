/**
 * F5.4 — the error envelope. Every non-2xx response in the system has this shape:
 *
 *   { "error": { "code", "message", "details", "requestId" } }
 *
 * `requestId` is also returned as the `X-Request-Id` header and appears in every log line
 * for that request (TDS 02 §9.4), which is what makes it the support handle.
 */

/** Error code registry (TDS 04 §1.3). Codes are UPPER_SNAKE and stable. */
export const ERROR_CODES = Object.freeze({
  VALIDATION_FAILED: 400,
  INVALID_CURSOR: 400,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ORIGIN_NOT_ALLOWED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  SESSION_NOT_RUNNING: 409,
  OPERATION_NOT_SUPPORTED: 409,
  NO_TURN_IN_FLIGHT: 409,
  INTEGRATION_NOT_CONFIGURED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  /**
   * The database's schema is not the one this build was written against — a `CHECK` refusing a
   * value the code writes as a constant, most often a pending migration.
   *
   * Distinct from `INTERNAL` because `INTERNAL` means "unhandled, disclose nothing" while this
   * one is fully understood and names the command that fixes it; see `db/violations.ts` for the
   * full argument, including why it is not a `409` and not a `503`.
   */
  DATABASE_SCHEMA_MISMATCH: 500,
  RUNTIME_UNAVAILABLE: 503,
} as const);

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly details: Record<string, unknown> | null;
    readonly requestId: string;
  };
}

/** Success envelope for single resources and action results (TDS 04 §1.2). */
export interface DataEnvelope<T> {
  readonly data: T;
}

/** List envelope with cursor pagination metadata (F5.3). */
export interface ListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: {
    readonly nextCursor: string | null;
    readonly limit: number;
  };
}

/**
 * Domain errors throw this; the Fastify error handler renders it as the F5.4 envelope.
 * Anything else that reaches the handler becomes `INTERNAL` with the detail withheld.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details: Record<string, unknown> | null;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = ERROR_CODES[code];
    this.details = details;
  }
}

export function errorEnvelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details: Record<string, unknown> | null = null,
): ErrorEnvelope {
  return { error: { code, message, details, requestId } };
}

export function dataEnvelope<T>(data: T): DataEnvelope<T> {
  return { data };
}
