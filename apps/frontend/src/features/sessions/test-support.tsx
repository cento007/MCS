import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import type { Message, Session } from '../../lib/api/index.js';
import { SocketProvider } from '../../lib/ws/context.js';
import { SocketClient, type SocketLike } from '../../lib/ws/socket-client.js';
import type { LiveTurn } from '../../stores/live-session-store.js';
import { useSocketStore } from '../../stores/socket-store.js';

/**
 * Shared fixtures and a render harness for the Sessions suites.
 *
 * Not a `*.test.ts` file, so Vitest never collects it. **No database and no network** — the
 * whole unit tier has to run on a bare checkout (TDS 07 §4), so `fetch` is replaced with an
 * explicit handler table and anything unmatched answers a real F5.4 error envelope rather
 * than hanging or reaching a socket.
 */

export const SESSION_ID = '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1';

export function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID,
    projectId: '0198a2f3-9c41-7bd2-a10e-000000000001',
    repositoryId: null,
    sessionType: 'managed',
    state: 'running',
    title: 'Refactor queue port to batch enqueue',
    notes: null,
    branch: 'DEV',
    workingDirectory: 'D:\\Repos\\MCS',
    runtime: {
      kind: 'claude_code',
      runtimeSessionId: 'c0ffee00-0000-4000-8000-000000000000',
      claudeVersion: '1.0.0',
      model: 'claude-sonnet-4',
      machine: 'mc-dev-win11',
      environment: 'dev',
    },
    observation: null,
    costUsd: 0.4821,
    tokenUsage: { input: 100_000, output: 28_400, cacheRead: 0, cacheWrite: 0 },
    durationSeconds: 2530,
    resumedFromSessionId: null,
    clonedFromSessionId: null,
    createdAt: '2026-08-12T12:00:00.000Z',
    startedAt: '2026-08-12T12:00:05.000Z',
    completedAt: null,
    archivedAt: null,
    updatedAt: '2026-08-12T12:42:15.000Z',
    ...overrides,
  };
}

export function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: `m-${overrides.ordinal ?? 1}`,
    sessionId: SESSION_ID,
    ordinal: 1,
    role: 'assistant',
    status: 'complete',
    content: [{ type: 'text', text: 'canonical message body' }],
    model: 'claude-sonnet-4',
    tokenUsage: { input: 10, output: 20 },
    runtimeUuid: null,
    occurredAt: '2026-08-12T12:01:00.000Z',
    createdAt: '2026-08-12T12:01:00.000Z',
    ...overrides,
  };
}

export function makeTurn(overrides: Partial<LiveTurn> = {}): LiveTurn {
  return {
    sessionId: SESSION_ID,
    messageId: 'm-live',
    blocks: [{ index: 0, kind: 'text', text: 'partial output', partialJson: '', complete: false }],
    status: 'streaming',
    termination: null,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

// ------------------------------------------------------------------------------ fetch mock

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

    // Unmatched calls answer the real envelope, so a component under test renders the same
    // error path it would in production rather than a bespoke test-only failure.
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === null ? '' : JSON.stringify(body), {
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

// --------------------------------------------------------------------------------- render

export interface Harness extends RenderResult {
  readonly queryClient: QueryClient;
}

/**
 * Render inside the providers the Sessions screens actually require.
 *
 * The socket client is real but its transport never opens — the point of the harness is that
 * `SocketClient`'s own behaviour is covered by its own suite, and these tests care only that
 * `useSessionChannel` has a provider to talk to. The socket *store* is set to `open` so the
 * liveness rules (§3.3) do not mute every badge and freeze every duration.
 */
export function renderWithProviders(ui: ReactElement, options: { live?: boolean } = {}): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  const client = new SocketClient({ socketFactory: () => inertSocket() });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SocketProvider client={client}>{ui}</SocketProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  if (options.live !== false) setSocketLive();

  return { ...result, queryClient };
}

export function setSocketLive(): void {
  useSocketStore.getState().applySnapshot({
    state: 'open',
    attempt: 0,
    connectionId: 'test-connection',
    lastConnectedAt: Date.now(),
    lastFrameAt: Date.now(),
    nextAttemptAt: null,
    authFailed: false,
    channels: [],
  });
}

export function setSocketOffline(): void {
  useSocketStore.getState().applySnapshot({
    state: 'backoff',
    attempt: 1,
    connectionId: null,
    lastConnectedAt: Date.now() - 5_000,
    lastFrameAt: null,
    nextAttemptAt: Date.now() + 1_000,
    authFailed: false,
    channels: [],
  });
}

function inertSocket(): SocketLike {
  return {
    readyState: 0,
    send: () => {},
    close: () => {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
}
