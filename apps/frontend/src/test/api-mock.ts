/**
 * The shared `fetch` mock for the unit tier (TDS 07 §4).
 *
 * **No database and no network at any point** — `pnpm test` has to run on a bare checkout — so
 * `globalThis.fetch` is replaced with an explicit handler table, and anything unmatched answers
 * a real F5.4 error envelope rather than hanging or reaching a socket. Components under test
 * therefore render the same error path they would in production instead of a test-only failure
 * shape.
 *
 * It lives in `src/test/` rather than inside a feature slice because more than one slice needs
 * it and feature slices may not import each other (TDS 05 §2.1). `features/sessions/
 * test-support.tsx` re-exports it so the existing Sessions suites are unchanged.
 */

export interface MockCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export interface MockResponse {
  readonly status?: number;
  readonly body?: unknown;
}

type Handler = (call: MockCall) => MockResponse | undefined;

export interface ApiMock {
  readonly calls: MockCall[];
  /** Register a handler. Later registrations win, so a test can override a default. */
  on(method: string, match: string | RegExp, respond: MockResponse | Handler): void;
  /** Every call whose URL contains `fragment`. */
  callsTo(fragment: string): readonly MockCall[];
  restore(): void;
}

export function mockApi(): ApiMock {
  const calls: MockCall[] = [];
  const handlers: { method: string; match: string | RegExp; respond: MockResponse | Handler }[] =
    [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    const call: MockCall = { method, url, body };
    calls.push(call);

    for (let index = handlers.length - 1; index >= 0; index -= 1) {
      const handler = handlers[index];
      if (handler === undefined) continue;
      if (handler.method !== method) continue;
      const matched =
        typeof handler.match === 'string' ? url.includes(handler.match) : handler.match.test(url);
      if (!matched) continue;
      const result =
        typeof handler.respond === 'function' ? handler.respond(call) : handler.respond;
      if (result === undefined) continue;
      return jsonResponse(result.status ?? 200, result.body ?? null);
    }

    return jsonResponse(404, {
      error: { code: 'NOT_FOUND', message: `No mock for ${method} ${url}`, requestId: 'test-req' },
    });
  }) as typeof fetch;

  return {
    calls,
    on: (method, match, respond) => {
      handlers.push({ method: method.toUpperCase(), match, respond });
    },
    callsTo: (fragment) => calls.filter((call) => call.url.includes(fragment)),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/**
 * `204`/`205`/`304` are null-body statuses: the `Response` constructor **throws** if given any
 * body for them, including `''`. That throw surfaces as a rejected `fetch`, which the client
 * maps to `NETWORK_ERROR` — so a mocked `204` would fail every delete, logout and ingest ack in
 * the suite while looking like a transport problem. The `null` here is not defensive; it is the
 * only legal value.
 */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function jsonResponse(status: number, body: unknown): Response {
  const payload = body === null || NULL_BODY_STATUSES.has(status) ? null : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'test-req' },
  });
}

/** The list envelope, so a test never hand-writes `meta` and gets it subtly wrong. */
export function listBody<T>(data: readonly T[], nextCursor: string | null = null): unknown {
  return { data, meta: { nextCursor, limit: 50 } };
}

export function dataBody(data: unknown): unknown {
  return { data };
}
