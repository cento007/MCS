import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
import { Toaster } from '../../components/Toaster.js';
import type { Project, Repository, RepositoryStatus } from '../../lib/api/index.js';
import { useSocketStore } from '../../stores/socket-store.js';
import { useToastStore } from '../../stores/toast-store.js';

/**
 * Fixtures and a render harness for the Projects suites.
 *
 * Not a `*.test.tsx` file, so Vitest never collects it. **No database and no network** — the
 * whole unit tier has to run on a bare checkout (TDS 07 §4), so `fetch` is replaced with the
 * shared explicit handler table and anything unmatched answers a real F5.4 error envelope.
 *
 * No `SocketProvider` here, unlike the Sessions harness: nothing on these screens subscribes to
 * a channel — they read REST and are invalidated by the shell's subscriptions — so the harness
 * only needs the socket *store* set live, otherwise the §3.3 liveness rules mute every badge.
 */

export const PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000001';
export const OTHER_PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000002';
export const REPOSITORY_ID = '0198a2f3-9c41-7bd2-a10e-0000000000a1';

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    workspaceId: '0198a2f3-9c41-7bd2-a10e-00000000000f',
    name: 'mission-control',
    description: 'Self-hosted AI engineering OS',
    // `null` is the honest default: a Project inherits the global workflow mode until an
    // operator deliberately overrides it (TDS 04 §4).
    workflowMode: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

export function makeRepository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: REPOSITORY_ID,
    projectId: PROJECT_ID,
    name: 'MCS',
    localPath: 'D:\\Repos\\MCS',
    remoteUrl: null,
    visibility: 'unknown',
    defaultBranch: 'main',
    lastSyncedAt: null,
    // Phase 1 registers by local path and touches no remote, so `never` is the truthful
    // starting value for every repository on a real instance.
    syncStatus: 'never',
    lastSyncError: null,
    createdAt: '2026-08-10T09:00:00.000Z',
    updatedAt: '2026-08-10T09:00:00.000Z',
    ...overrides,
  };
}

export function makeStatus(overrides: Partial<RepositoryStatus> = {}): RepositoryStatus {
  return {
    repositoryId: REPOSITORY_ID,
    localPath: 'D:\\Repos\\MCS',
    isGitWorkingTree: true,
    currentBranch: 'DEV',
    detachedHead: false,
    headSha: '4b4d17e0f0c1a2b3c4d5e6f708192a3b4c5d6e7f',
    uncommittedFiles: 0,
    ahead: 0,
    behind: 0,
    unavailableReason: null,
    detail: null,
    checkedAt: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

/** The F5.4 envelope a rejected registration actually returns, so tests exercise the real path. */
export function validationBody(
  message: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return { error: { code: 'VALIDATION_FAILED', message, details, requestId: 'test-req' } };
}

export function conflictBody(
  message: string,
  details: Record<string, unknown>,
): Record<string, unknown> {
  return { error: { code: 'CONFLICT', message, details, requestId: 'test-req' } };
}

export {
  type ApiMock,
  dataBody,
  listBody,
  type MockCall,
  type MockResponse,
  mockApi,
} from '../../test/api-mock.js';

export interface Harness extends RenderResult {
  readonly queryClient: QueryClient;
}

export function renderWithProviders(
  ui: ReactElement,
  options: { initialEntries?: string[] } = {},
): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  // Toasts left over from a previous test would be asserted against by the next one.
  useToastStore.getState().clear();

  // The `Toaster` is mounted here because §11.1 makes a toast the *contract* for a failed
  // mutation that has no more specific inline surface — a harness without one would let a
  // mutation fail silently in the suite while the operator would have seen an error.
  const result = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={options.initialEntries ?? ['/projects']}>
        {ui}
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
