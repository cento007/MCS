import { ApiError, CLIENT_ERROR_CODES, parseErrorEnvelope } from './errors.js';

/**
 * The API client (TDS 05 §4). A thin typed `fetch` wrapper — no heavyweight HTTP library.
 *
 *  - Base is same-origin `/api/v1`. In prod the Backend serves the SPA (F2.3); in dev the
 *    Vite proxy forwards `/api` to `127.0.0.1:8710`. Same-origin in both, so there is no
 *    CORS branch anywhere in this codebase.
 *  - `credentials: 'same-origin'` so the HTTP-only `mc_session` cookie flows (F5.5). The
 *    SPA never reads, stores or forwards the credential itself.
 *  - Every non-2xx becomes a typed `ApiError` carrying `code` / `message` / `details` /
 *    `requestId` (F5.4). Nothing else is ever thrown from here.
 *  - A single 401 interceptor routes session expiry through the §8 auth path, exactly once
 *    per event, rather than letting every call site invent its own redirect.
 */

export const API_BASE = '/api/v1';

/** F5.3 list envelope — `nextCursor` is opaque and must never be parsed by the client. */
export interface ListMeta {
  readonly nextCursor: string | null;
  readonly limit: number;
}

export interface ListEnvelope<T> {
  readonly data: readonly T[];
  readonly meta: ListMeta;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Serialised as JSON. `undefined` sends no body and no content-type. */
  readonly body?: unknown;
  readonly query?: QueryParams | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * Suppress the global 401 handler for this call. Exactly one caller needs it — the login
   * request, whose 401 IS the answer rather than an expiry (TDS 05 §4).
   */
  readonly skipAuthInterceptor?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

export type QueryParams = Readonly<Record<string, string | number | boolean | null | undefined>>;

/**
 * Called once per detected 401 (outside login). Registered by `app/providers.tsx`, which
 * clears the query cache, tears down the socket and redirects to `/login?returnTo=…`.
 * Held as a module-level slot rather than injected everywhere because there is exactly one
 * session, one cache and one router — a per-call parameter would be ceremony over a
 * singleton.
 */
let unauthorizedHandler: ((error: ApiError) => void) | null = null;

export function setUnauthorizedHandler(handler: ((error: ApiError) => void) | null): void {
  unauthorizedHandler = handler;
}

export function buildUrl(path: string, query?: QueryParams | undefined): string {
  const base = path.startsWith('/api/') ? path : `${API_BASE}${path}`;
  if (query === undefined) return base;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const serialised = search.toString();
  return serialised.length > 0 ? `${base}?${serialised}` : base;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __raw: text };
  }
}

function requestIdOf(response: Response, fallback: string | null): string | null {
  return response.headers.get('x-request-id') ?? fallback;
}

/**
 * Issue one request and normalise the outcome.
 *
 * Returns the decoded body verbatim — envelope unwrapping is the caller's, because the
 * three envelope shapes (§1.2: `{data}`, `{data, meta}`, and `204` no-body) are not
 * distinguishable from the response alone and pretending otherwise costs type safety.
 */
export async function apiRequest(path: string, options: RequestOptions = {}): Promise<unknown> {
  const { method = 'GET', body, query, signal, skipAuthInterceptor = false, headers } = options;

  const init: RequestInit = {
    method,
    // F5.5: the session cookie is the browser's credential. Never `include` — same-origin
    // is the whole security model and `include` would quietly enable a cross-origin one.
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal === undefined ? {} : { signal }),
  };

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw new ApiError({
        code: CLIENT_ERROR_CODES.ABORTED,
        message: 'Request aborted',
        status: 0,
        cause,
      });
    }
    // A transport failure never reached the Backend, so there is no `requestId` to quote.
    // Synthesising one would be a lie an operator could waste time grepping for.
    throw new ApiError({
      code: CLIENT_ERROR_CODES.NETWORK_ERROR,
      message: 'Network request failed',
      status: 0,
      requestId: null,
      cause,
    });
  }

  const decoded = await readBody(response);

  if (response.ok) return decoded;

  const envelope = parseErrorEnvelope(decoded);
  const error =
    envelope === null
      ? new ApiError({
          code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
          message: `Unexpected ${response.status} response from ${path}`,
          status: response.status,
          requestId: requestIdOf(response, null),
        })
      : new ApiError({
          code: envelope.code,
          message: envelope.message,
          status: response.status,
          details: envelope.details,
          requestId: requestIdOf(response, envelope.requestId),
        });

  if (error.isUnauthorized && !skipAuthInterceptor) {
    unauthorizedHandler?.(error);
  }

  throw error;
}

/** `{ data: T }` — single resources and action results (§1.2). */
export async function apiGet<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return unwrapData<T>(await apiRequest(path, { ...options, method: 'GET' }), path);
}

export async function apiSend<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  return unwrapData<T>(await apiRequest(path, { ...options, method }), path);
}

/** `204 No Content` routes: logout, delete, ingest acks (§1.2). */
export async function apiVoid(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  options: RequestOptions = {},
): Promise<void> {
  await apiRequest(path, { ...options, method });
}

/** `{ data: T[], meta: { nextCursor, limit } }` — every unbounded collection (F5.3). */
export async function apiList<T>(
  path: string,
  options: RequestOptions = {},
): Promise<ListEnvelope<T>> {
  const decoded = await apiRequest(path, { ...options, method: 'GET' });
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !Array.isArray((decoded as ListEnvelope<T>).data)
  ) {
    throw malformed(path);
  }
  const meta = (decoded as { meta?: unknown }).meta;
  const nextCursor =
    typeof meta === 'object' && meta !== null && typeof (meta as ListMeta).nextCursor === 'string'
      ? (meta as ListMeta).nextCursor
      : null;
  const limit =
    typeof meta === 'object' && meta !== null && typeof (meta as ListMeta).limit === 'number'
      ? (meta as ListMeta).limit
      : (decoded as ListEnvelope<T>).data.length;

  return { data: (decoded as ListEnvelope<T>).data, meta: { nextCursor, limit } };
}

function unwrapData<T>(decoded: unknown, path: string): T {
  if (typeof decoded !== 'object' || decoded === null || !('data' in decoded)) {
    throw malformed(path);
  }
  return (decoded as { data: T }).data;
}

function malformed(path: string): ApiError {
  return new ApiError({
    code: CLIENT_ERROR_CODES.MALFORMED_RESPONSE,
    message: `Response from ${path} was not the expected envelope`,
    status: 200,
  });
}
