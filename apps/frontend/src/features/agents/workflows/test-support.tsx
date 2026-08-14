import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type RenderResult, render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { Toaster } from '../../../components/Toaster.js';
import { SocketProvider } from '../../../lib/ws/context.js';
import { SocketClient, type SocketLike } from '../../../lib/ws/socket-client.js';
import { useSocketStore } from '../../../stores/socket-store.js';
import { useToastStore } from '../../../stores/toast-store.js';
import { WorkflowPage } from './WorkflowPage.js';
import { WorkflowRunPage } from './WorkflowRunPage.js';
import { WorkflowsPage } from './WorkflowsPage.js';

/**
 * Fixtures and harnesses for the Workflows suites.
 *
 * Not a `*.test.tsx` file, so Vitest never collects it. **No database and no network at any point**
 * (TDS 07 §4): `src/test/api-mock.ts` answers every request, so `pnpm test` runs on a bare checkout
 * with no Backend — which is the state these screens are designed to survive in production too.
 *
 * A **data router** (`createMemoryRouter`), not a `MemoryRouter`, because `useBlocker` — the
 * mechanism behind the unsaved-changes guard on the workflow page — requires one.
 */

export const WORKFLOW_ID = '0198a2f3-9c41-7bd2-a10e-00000000f001';
export const RUN_ID = '0198a2f3-9c41-7bd2-a10e-00000000f101';
export const PROJECT_ID = '0198a2f3-9c41-7bd2-a10e-000000000001';
export const DEVELOPER_ID = '0198a2f3-9c41-7bd2-a10e-00000000a001';
export const QA_ID = '0198a2f3-9c41-7bd2-a10e-00000000a002';
export const SESSION_ONE = '0198a2f3-9c41-7bd2-a10e-00000000c001';
export const SESSION_TWO = '0198a2f3-9c41-7bd2-a10e-00000000c002';

/**
 * A **read-only** agent: `repository.read` only, and the `disallowedTools` the Backend derives
 * from it. This is what `POST /agents` produces by default (`read_only`), i.e. the most common row.
 */
export function makeReadOnlyAgent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: QA_ID,
    name: 'QA',
    description: 'Reviews a diff against the tests it should have.',
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
    instructions: 'You are QA.',
    archivedAt: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * An agent with **shell**: the dangerous one, and the reason the pre-run screen exists. `shell`
 * implies read and write (`normalizeAgentPermissions`), and its deny list is empty — nothing is
 * taken away from the runtime at all.
 */
export function makeShellAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...makeReadOnlyAgent(),
    id: DEVELOPER_ID,
    name: 'Developer',
    description: 'Writes the code.',
    permissions: { repository: { read: true, write: true, shell: true } },
    disallowedTools: [],
    instructions: 'You are the Developer.',
    ...overrides,
  };
}

/** The `AgentWorkflow` resource, exactly as `agents/workflows/serialize.ts` produces it. */
export function makeWorkflow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKFLOW_ID,
    name: 'Review chain',
    description: 'Developer then QA.',
    scope: 'global',
    projectId: null,
    steps: [
      {
        ordinal: 0,
        agentId: DEVELOPER_ID,
        agentName: 'Developer',
        agentScope: 'global',
        agentProjectId: null,
        agentArchivedAt: null,
        instructions: 'Implement the change.',
      },
      {
        ordinal: 1,
        agentId: QA_ID,
        agentName: 'QA',
        agentScope: 'global',
        agentProjectId: null,
        agentArchivedAt: null,
        instructions: 'Review the diff for missing tests.',
      },
    ],
    stepCount: 2,
    archivedAt: null,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-12T12:00:00.000Z',
    ...overrides,
  };
}

export function makeRunStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ordinal: 0,
    attempt: 0,
    agentId: DEVELOPER_ID,
    sessionId: SESSION_ONE,
    state: 'completed',
    handoff: { state: 'none', reason: null, promptBytes: 412 },
    promptSentAt: '2026-08-14T09:00:05.000Z',
    error: null,
    startedAt: '2026-08-14T09:00:00.000Z',
    completedAt: '2026-08-14T09:04:00.000Z',
    ...overrides,
  };
}

/** The `AgentWorkflowRun` resource. Defaults to a run in flight at step 2 of 2. */
export function makeRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: RUN_ID,
    workflowId: WORKFLOW_ID,
    projectId: PROJECT_ID,
    repositoryId: null,
    task: 'Add rate limiting to the hook-ingest route.',
    workingDirectory: 'D:\\Repos\\MCS',
    branch: 'DEV',
    model: null,
    state: 'running',
    stepCount: 2,
    currentStepOrdinal: 1,
    maxSessions: 5,
    sessionsLaunched: 2,
    haltReason: null,
    steps: [
      makeRunStep(),
      makeRunStep({
        ordinal: 1,
        agentId: QA_ID,
        sessionId: SESSION_TWO,
        state: 'running',
        handoff: { state: 'full', reason: null, promptBytes: 8_912 },
        completedAt: null,
      }),
    ],
    startedAt: '2026-08-14T09:00:00.000Z',
    completedAt: null,
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:05:00.000Z',
    ...overrides,
  };
}

/** A halted run: step 1 completed, step 2 failed, and nothing after it started. */
export function makeHaltedRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return makeRun({
    state: 'halted',
    stepCount: 3,
    currentStepOrdinal: 1,
    haltReason: 'Step 2 (QA) failed: session ended in state failed (process_crash)',
    steps: [
      makeRunStep(),
      makeRunStep({
        ordinal: 1,
        agentId: QA_ID,
        sessionId: SESSION_TWO,
        state: 'failed',
        error: 'process_crash',
        handoff: { state: 'full', reason: null, promptBytes: 8_912 },
        completedAt: '2026-08-14T09:06:00.000Z',
      }),
    ],
    ...overrides,
  });
}

export function makeSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SESSION_ONE,
    projectId: PROJECT_ID,
    repositoryId: null,
    sessionType: 'managed',
    state: 'completed',
    title: 'Implement the change',
    failureReason: null,
    notes: null,
    branch: 'DEV',
    workingDirectory: 'D:\\Repos\\MCS',
    agentId: DEVELOPER_ID,
    runtime: { runtime: 'claude_code', runtimeSessionId: 'abc', model: null },
    observation: null,
    costUsd: 0.1234,
    tokenUsage: { input: 100, output: 200 },
    startedAt: '2026-08-14T09:00:00.000Z',
    endedAt: '2026-08-14T09:04:00.000Z',
    createdAt: '2026-08-14T09:00:00.000Z',
    updatedAt: '2026-08-14T09:04:00.000Z',
    ...overrides,
  };
}

export function makeProject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
} from '../../../test/api-mock.js';

// ----------------------------------------------------------------------------------- render

export interface Harness extends RenderResult {
  readonly queryClient: QueryClient;
  readonly router: ReturnType<typeof createMemoryRouter>;
}

export function renderWorkflows(initialPath = '/agents/workflows'): Harness {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });

  useToastStore.getState().clear();

  const client = new SocketClient({ socketFactory: () => inertSocket() });

  const router = createMemoryRouter(
    [
      { path: '/agents/workflows', element: <WorkflowsPage /> },
      { path: '/agents/workflows/:workflowId', element: <WorkflowPage /> },
      { path: '/agents/runs/:runId', element: <WorkflowRunPage /> },
      { path: '/agents', element: <div>Agents screen</div> },
      { path: '/sessions/:sessionId', element: <div>Session screen</div> },
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

/** A socket that never opens — `SocketClient` has its own suite; these tests need a provider. */
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
