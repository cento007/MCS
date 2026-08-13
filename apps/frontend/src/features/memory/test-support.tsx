import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { Toaster } from '../../components/Toaster.js';
import type { Project } from '../../lib/api/index.js';
import { SocketProvider } from '../../lib/ws/context.js';
import { SocketClient, type SocketLike } from '../../lib/ws/socket-client.js';
import { useSocketStore } from '../../stores/socket-store.js';
import { useToastStore } from '../../stores/toast-store.js';
import type {
  MemoryBackfillStatus,
  MemoryEmptyReason,
  MemorySearchResponse,
  MemorySearchResult,
} from './types.js';

/**
 * Fixtures and a render harness for the Memory suites.
 *
 * Not a `*.test.tsx` file, so Vitest never collects it. **No database and no network at any
 * point** (TDS 07 §4) — which for this screen means more than the usual: there is no Qdrant, no
 * Ollama and no embedding call anywhere in the unit tier. Every one of the five outcomes is
 * driven by a canned `emptyReason`, which is exactly why the Backend returns it as data rather
 * than as an HTTP status.
 */

export const PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000001';
export const OTHER_PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000002';
export const SESSION_ID = '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1';
export const REPOSITORY_ID = '0198a2f3-9c41-7bd2-a10e-0000000000a1';
export const ADR_ID = '0198a2f3-9c41-7bd2-a10e-0000000000c1';
export const COMMIT_ID = '0198a2f3-9c41-7bd2-a10e-0000000000d1';
export const PR_ID = '0198a2f3-9c41-7bd2-a10e-0000000000e1';

export function makeResult(overrides: Partial<MemorySearchResult> = {}): MemorySearchResult {
  return {
    memoryItemId: '0198a2f3-9c41-7bd2-a10e-00000000f001',
    score: 0.65,
    tier: 'project',
    sourceType: 'adr',
    sourceId: ADR_ID,
    sourceRef: null,
    title: 'ADR-0007 — Use pg-boss instead of Redis',
    content: 'Redis has no official native Windows build, so the job queue is pg-boss.',
    chunkOrdinal: 0,
    chunkCount: 1,
    occurredAt: '2026-08-12T12:00:00.000Z',
    context: { projectId: PROJECT_ID, repositoryId: null, sessionId: null },
    ...overrides,
  };
}

/**
 * A search response. The default is the *populated* case; every empty case is one field away,
 * which is the shape of the contract and the reason this helper takes `emptyReason` at all.
 */
export function makeSearchResponse(
  overrides: Partial<MemorySearchResponse> = {},
): MemorySearchResponse {
  return {
    results: [makeResult()],
    emptyReason: 'none',
    detail: null,
    minScore: 0.52,
    embeddingModel: 'nomic-embed-text',
    candidatesConsidered: 5,
    ...overrides,
  };
}

/** An empty answer with its reason and the Backend's own sentence, which is rendered verbatim. */
export function makeEmptyResponse(
  reason: MemoryEmptyReason,
  detail: string,
  overrides: Partial<MemorySearchResponse> = {},
): MemorySearchResponse {
  return makeSearchResponse({
    results: [],
    emptyReason: reason,
    detail,
    ...overrides,
  });
}

/**
 * `GET /memory-items/backfill`.
 *
 * The default is **configured and empty** — an instance where an embedding model is set and no
 * backfill has run yet — because that is the state every empty-outcome test wants underneath it.
 * `configured` is what makes it distinguishable from an instance with no model at all; the two
 * are identical in every other field, which is why the field was added.
 */
export function makeBackfillStatus(
  overrides: Partial<MemoryBackfillStatus> = {},
): MemoryBackfillStatus {
  return {
    runId: null,
    state: null,
    mode: null,
    trigger: null,
    startedAt: null,
    completedAt: null,
    error: null,
    progress: null,
    summary: null,
    indexedModels: [],
    rowsFromOtherModels: 0,
    configured: true,
    runtime: 'ready',
    runtimeReason: null,
    ...overrides,
  };
}

/**
 * A backfill document from a Backend that predates the A18 additions — the three fields absent.
 *
 * Worth a fixture of its own: the frontend and the Backend ship separately, and "the field is not
 * there yet" must render as *silence*, never as "memory is not configured".
 */
export function makeLegacyBackfillStatus(
  overrides: Partial<MemoryBackfillStatus> = {},
): Omit<MemoryBackfillStatus, 'configured' | 'runtime' | 'runtimeReason'> {
  const {
    configured: _configured,
    runtime: _runtime,
    runtimeReason: _runtimeReason,
    ...rest
  } = makeBackfillStatus(overrides);
  return rest;
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    workspaceId: '0198a2f3-9c41-7bd2-a10e-00000000000f',
    name: 'mission-control',
    description: null,
    workflowMode: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

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
 * Render inside the providers the Memory screen requires.
 *
 * A `SocketProvider` is mandatory here, unlike the Projects harness: the page subscribes to the
 * `memory` channel itself rather than relying on the shell, because nothing outside this screen
 * reads the index state. The client is real and its transport never opens — `SocketClient` has
 * its own suite, and these tests only need `useChannel` to have a provider to talk to.
 */
export function renderWithProviders(
  ui: ReactElement,
  options: { initialEntries?: string[] } = {},
): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  useToastStore.getState().clear();

  const client = new SocketClient({ socketFactory: () => inertSocket() });

  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={options.initialEntries ?? ['/memory']}>
        <SocketProvider client={client}>{ui}</SocketProvider>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  setSocketLive();

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

/** A socket that never opens. Duplicated per harness rather than shared — each slice owns the
 *  providers its own screens need, and a shared one would couple two suites' setups together. */
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
