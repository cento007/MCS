import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from '../../components/Toaster.js';
import type { Project } from '../../lib/api/index.js';
import { SocketProvider } from '../../lib/ws/context.js';
import { SocketClient, type SocketLike } from '../../lib/ws/socket-client.js';
import { useSocketStore } from '../../stores/socket-store.js';
import { useToastStore } from '../../stores/toast-store.js';
import { AgentBuilderPage } from './AgentBuilderPage.js';
import { AgentsListPage } from './AgentsListPage.js';

/**
 * Fixtures and render harnesses for the Agents suites.
 *
 * Not a `*.test.tsx` file, so Vitest never collects it. **No database and no network at any point**
 * (TDS 07 §4) — `src/test/api-mock.ts` answers everything, so `pnpm test` still runs on a bare
 * checkout with no Backend, which is exactly the state the Agents routes were in while this screen
 * was written.
 *
 * `renderAgents` builds a **data router** (`createMemoryRouter`), not a `MemoryRouter`, and that is
 * load-bearing rather than incidental: `useBlocker` — the mechanism behind the unsaved-changes
 * guard — requires one, which is what `app/router.tsx` creates in production. A harness on the
 * non-data router could not exercise the guard at all, leaving the highest-consequence behaviour
 * on this screen untestable. It is the same reason `features/settings/test-support.tsx` does it.
 */

export const AGENT_ID = '0198a2f3-9c41-7bd2-a10e-00000000a001';
export const OTHER_AGENT_ID = '0198a2f3-9c41-7bd2-a10e-00000000a002';
export const PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000001';
export const OTHER_PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000002';

/**
 * The Agent resource, exactly as `apps/backend/src/agents/serialize.ts` produces it — including
 * `disallowedTools`, which is the field that lets this screen say "enforced" about anything.
 *
 * The default is a `read_only` agent, because that is what `POST /agents` produces when the body
 * names no permissions (`DEFAULT_AGENT_PERMISSION_TEMPLATE`), i.e. the most common real row.
 */
export function makeAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: AGENT_ID,
    name: 'Architect',
    description: 'Reviews designs against the Foundation Contract.',
    scope: 'global',
    projectId: null,
    sessionId: null,
    runtime: 'claude_code',
    permissions: { repository: { read: true, write: false, shell: false } },
    disallowedTools: [
      'Agent',
      'Bash',
      'BashOutput',
      'Edit',
      'KillBash',
      'KillShell',
      'MultiEdit',
      'NotebookEdit',
      'Task',
      'Write',
    ],
    instructions: 'You are the Architect for this repository.',
    archivedAt: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * An Agent from a Backend that predates `disallowedTools`.
 *
 * Worth a fixture of its own: it is the only shape in which this screen has *no evidence* that a
 * permission switch reaches the runtime, and it must render "enforcement not stated" rather than
 * quietly implying the switches work.
 */
export function makeAgentWithoutTools(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const { disallowedTools: _dropped, ...rest } = makeAgent(overrides);
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
  /** The live data router, so a test can drive a real navigation past the guard. */
  readonly router: ReturnType<typeof createMemoryRouter>;
}

/**
 * The whole Agents area on a data router: list, create and edit, plus a destination outside it so
 * "navigate away while dirty" is a real navigation rather than a same-screen param change.
 */
export function renderAgents(initialPath = '/agents'): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  useToastStore.getState().clear();

  const client = new SocketClient({ socketFactory: () => inertSocket() });

  const router = createMemoryRouter(
    [
      { path: '/agents', element: <AgentsListPage /> },
      { path: '/agents/new', element: <AgentBuilderPage /> },
      { path: '/agents/:agentId', element: <AgentBuilderPage /> },
      { path: '/sessions', element: <div>Sessions screen</div> },
    ],
    { initialEntries: [initialPath] },
  );

  const result = render(
    <QueryClientProvider client={queryClient}>
      <SocketProvider client={client}>
        <RouterProvider router={router} />
      </SocketProvider>
      <Toaster />
    </QueryClientProvider>,
  );

  setSocketLive();

  return { ...result, queryClient, router };
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

/** A socket that never opens — `SocketClient` has its own suite; these tests only need a provider. */
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
