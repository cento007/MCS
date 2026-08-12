/**
 * The F5.4 error envelope, client-side (TDS 04 §1.2, §1.3; TDS 05 §4, §11.1).
 *
 * Every non-2xx response in the system has exactly one shape:
 *
 *   { "error": { "code", "message", "details", "requestId" } }
 *
 * `requestId` is the operator's bridge to the Backend log (F5.4 guarantees the
 * correlation, and the same value rides on `X-Request-Id`), so it is a first-class field
 * on `ApiError` and is surfaced by every error UI — never swallowed.
 */

/** TDS 04 §1.3 — the registry, verbatim. Codes are UPPER_SNAKE and stable. */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'INVALID_CURSOR',
  'UNAUTHORIZED',
  'INVALID_CREDENTIALS',
  'FORBIDDEN',
  'ORIGIN_NOT_ALLOWED',
  'NOT_FOUND',
  'CONFLICT',
  'INVALID_STATE_TRANSITION',
  'SESSION_NOT_RUNNING',
  'OPERATION_NOT_SUPPORTED',
  'NO_TURN_IN_FLIGHT',
  'INTEGRATION_NOT_CONFIGURED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'INTERNAL',
  'RUNTIME_UNAVAILABLE',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * Codes this client synthesises for failures that never reached the Backend, so a caller
 * can branch on `error.code` alone without also inspecting `status`. They are deliberately
 * NOT in the §1.3 registry — the registry is the Backend's, and inventing entries in it
 * would make the two drift.
 */
export const CLIENT_ERROR_CODES = {
  /** fetch() rejected: DNS, connection refused, offline, CORS-at-the-transport. */
  NETWORK_ERROR: 'NETWORK_ERROR',
  /** A non-2xx (or a 2xx) whose body was not the envelope we were promised. */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  /** `AbortController` fired — a route change, not a failure worth a toast. */
  ABORTED: 'ABORTED',
} as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];

/** Anything `ApiError.code` can hold. Unknown server codes are admitted as plain strings:
 *  a Backend that grows a code must not crash a client that has not shipped yet. */
export type ErrorCode = ApiErrorCode | ClientErrorCode | (string & {});

export interface ApiErrorInit {
  readonly code: ErrorCode;
  readonly message: string;
  /** HTTP status, or 0 when the request never produced a response. */
  readonly status: number;
  readonly details?: Record<string, unknown> | null;
  /** `null` when the failure never reached the Backend — there is no log line to quote. */
  readonly requestId?: string | null;
  readonly cause?: unknown;
}

/**
 * The single error type crossing the API boundary. Query and mutation failures are always
 * instances of this, so every error surface (`ErrorPanel`, toast, inline form banner) can
 * render `code` / `message` / `requestId` without type-sniffing.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | null;
  readonly requestId: string | null;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details ?? null;
    this.requestId = init.requestId ?? null;
  }

  /** True for the one condition the auth interceptor acts on (TDS 05 §4, §8). */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** Transport-level failure: worth a retry, not worth a `requestId` line. */
  get isNetworkError(): boolean {
    return this.code === CLIENT_ERROR_CODES.NETWORK_ERROR;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

/**
 * `code -> friendlier copy` (TDS 05 §11.1). Deliberately small: an unknown code falls back
 * to the server's own `message`, which is already human-readable, rather than to a generic
 * string that would hide what actually happened.
 */
const FRIENDLY_MESSAGES: Readonly<Partial<Record<string, string>>> = Object.freeze({
  NETWORK_ERROR: 'Could not reach Mission Control. Check that the Backend is running.',
  UNAUTHORIZED: 'Your session has expired. Sign in again to continue.',
  INVALID_CREDENTIALS: 'Incorrect username or password.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  INVALID_STATE_TRANSITION: 'That action is not legal from this session state.',
  SESSION_NOT_RUNNING: 'The session is not running, so it cannot accept a prompt.',
  NO_TURN_IN_FLIGHT: 'There is no turn in flight to stop.',
  OPERATION_NOT_SUPPORTED: 'That action does not apply to this session type.',
  INTEGRATION_NOT_CONFIGURED: 'Configure this integration in Settings first.',
  RUNTIME_UNAVAILABLE: 'The Claude Code runtime is not reachable.',
  INTERNAL: 'Mission Control hit an unexpected error.',
  MALFORMED_RESPONSE: 'Mission Control returned a response this client could not read.',
});

/** The string an error surface should show. Never empty. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    return FRIENDLY_MESSAGES[error.code] ?? error.message;
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'Something went wrong.';
}

/**
 * Parse an F5.4 envelope out of an already-decoded response body. Returns `null` when the
 * body is not one — the caller then synthesises `MALFORMED_RESPONSE` with the status, which
 * keeps "the server broke the contract" distinguishable from "the server rejected me".
 */
export function parseErrorEnvelope(body: unknown): {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  requestId: string | null;
} | null {
  if (typeof body !== 'object' || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return null;

  const record = error as Record<string, unknown>;
  const code = record['code'];
  const message = record['message'];
  if (typeof code !== 'string' || code.length === 0) return null;

  const details = record['details'];
  const requestId = record['requestId'];

  return {
    code,
    message: typeof message === 'string' && message.length > 0 ? message : code,
    details:
      typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : null,
    requestId: typeof requestId === 'string' && requestId.length > 0 ? requestId : null,
  };
}
