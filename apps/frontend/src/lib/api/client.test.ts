import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  apiGet,
  apiList,
  apiRequest,
  apiVoid,
  buildUrl,
  setUnauthorizedHandler,
} from './client.js';
import { ApiError, errorMessage, parseErrorEnvelope } from './errors.js';

/**
 * The API client's contract with F5.4 (TDS 04 §1.2/§1.3, TDS 05 §4).
 *
 * The property under test throughout is that **every failure mode produces one typed
 * `ApiError` carrying a code, a status and a `requestId` where one exists** — because every
 * error surface downstream renders exactly those three fields and nothing else, and a
 * failure that escapes as a raw `TypeError` renders as "Something went wrong" with no
 * reference the operator can quote at a log.
 */

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  setUnauthorizedHandler(null);
  vi.unstubAllGlobals();
});

describe('buildUrl', () => {
  it('prefixes the versioned base and drops empty query values', () => {
    expect(buildUrl('/sessions')).toBe('/api/v1/sessions');
    expect(buildUrl('/sessions', { limit: 50, cursor: undefined, state: '' })).toBe(
      '/api/v1/sessions?limit=50',
    );
  });

  it('leaves an already-absolute api path alone', () => {
    expect(buildUrl('/api/v1/auth/me')).toBe('/api/v1/auth/me');
  });
});

describe('envelope unwrapping', () => {
  it('returns `data` for a single-resource envelope', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { id: 'abc' } }));
    await expect(apiGet<{ id: string }>('/sessions/abc')).resolves.toEqual({ id: 'abc' });
  });

  it('returns data + meta for a list envelope and treats the cursor as opaque', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ data: [{ id: '1' }], meta: { nextCursor: 'b3Bh', limit: 50 } }),
    );
    const page = await apiList<{ id: string }>('/sessions');
    expect(page.data).toEqual([{ id: '1' }]);
    expect(page.meta).toEqual({ nextCursor: 'b3Bh', limit: 50 });
  });

  it('accepts 204 No Content for logout and deletes', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiVoid('POST', '/auth/logout')).resolves.toBeUndefined();
  });

  it('sends the session cookie same-origin and never `include`', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: null }));
    await apiRequest('/auth/me');
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });
});

describe('error envelope mapping (F5.4)', () => {
  it('maps a full envelope to ApiError, surfacing code, details and requestId', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'INVALID_STATE_TRANSITION',
            message: 'Cannot pause a completed session',
            details: { from: 'completed', to: 'paused' },
            requestId: '018f6b2e-1111-7abc-8def-0123456789ab',
          },
        },
        { status: 409 },
      ),
    );

    const error = await apiGet('/sessions/x/pause').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('INVALID_STATE_TRANSITION');
    expect(apiError.status).toBe(409);
    expect(apiError.details).toEqual({ from: 'completed', to: 'paused' });
    expect(apiError.requestId).toBe('018f6b2e-1111-7abc-8def-0123456789ab');
  });

  it('prefers the X-Request-Id header when the envelope omits requestId', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'NOT_FOUND', message: 'no such session' } },
        { status: 404, headers: { 'x-request-id': 'hdr-123' } },
      ),
    );

    const error = (await apiGet('/sessions/x').catch((caught: unknown) => caught)) as ApiError;
    expect(error.requestId).toBe('hdr-123');
  });

  it('admits an unknown server code rather than crashing a client that has not shipped yet', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'SOME_FUTURE_CODE', message: 'later' } }, { status: 409 }),
    );
    const error = (await apiGet('/x').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('SOME_FUTURE_CODE');
    expect(errorMessage(error)).toBe('later');
  });

  it('synthesises MALFORMED_RESPONSE when a non-2xx body is not the envelope', async () => {
    fetchMock.mockResolvedValue(new Response('<html>502</html>', { status: 502 }));
    const error = (await apiGet('/x').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('MALFORMED_RESPONSE');
    expect(error.status).toBe(502);
  });

  it('synthesises NETWORK_ERROR with a null requestId when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const error = (await apiGet('/x').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
    // There is no Backend log line for a request that never arrived; inventing an id would
    // send the operator grepping for something that does not exist.
    expect(error.requestId).toBeNull();
    expect(error.isNetworkError).toBe(true);
  });

  it('distinguishes an abort from a failure', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const error = (await apiGet('/x').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('ABORTED');
  });

  it('throws MALFORMED_RESPONSE when a 200 body lacks `data`', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ notData: true }));
    const error = (await apiGet('/x').catch((caught: unknown) => caught)) as ApiError;
    expect(error.code).toBe('MALFORMED_RESPONSE');
  });
});

describe('the single 401 interceptor', () => {
  it('fires once per 401 and hands the interceptor the typed error', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'UNAUTHORIZED', message: 'no session' } }, { status: 401 }),
    );

    await apiGet('/auth/me').catch(() => undefined);

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const [received] = onUnauthorized.mock.calls[0] as [ApiError];
    expect(received.code).toBe('UNAUTHORIZED');
  });

  it('does NOT fire for the login call, whose 401 is the answer rather than an expiry', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'INVALID_CREDENTIALS', message: 'nope' } }, { status: 401 }),
    );

    await apiRequest('/auth/login', { method: 'POST', skipAuthInterceptor: true }).catch(
      () => undefined,
    );

    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not fire for a 403, which is authorisation rather than authentication', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'FORBIDDEN', message: 'scope' } }, { status: 403 }),
    );

    await apiGet('/hook-events').catch(() => undefined);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe('parseErrorEnvelope', () => {
  it('rejects shapes that are not the F5.4 envelope', () => {
    expect(parseErrorEnvelope(null)).toBeNull();
    expect(parseErrorEnvelope({ error: 'boom' })).toBeNull();
    expect(parseErrorEnvelope({ error: { message: 'no code' } })).toBeNull();
  });

  it('falls back to the code when the server sends no message', () => {
    expect(parseErrorEnvelope({ error: { code: 'CONFLICT' } })).toEqual({
      code: 'CONFLICT',
      message: 'CONFLICT',
      details: null,
      requestId: null,
    });
  });
});
