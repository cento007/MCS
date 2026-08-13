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
    // `null` is the honest default: this fixture is `running`, and the column is populated
    // only on the transition to `failed`. Failure suites pass it explicitly.
    failureReason: null,
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

/**
 * The `fetch` mock moved to `src/test/api-mock.ts` when a second feature slice (Settings)
 * needed it — feature slices may not import each other (TDS 05 §2.1), so a shared test helper
 * belongs outside them. Re-exported here so every existing Sessions suite keeps its imports.
 */
export {
  type ApiMock,
  dataBody,
  listBody,
  type MockCall,
  type MockResponse,
  mockApi,
} from '../../test/api-mock.js';

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
