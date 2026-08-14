import { type UseMutationResult, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ApiError,
  apiRequest,
  apiSend,
  endpoints,
  errorMessage,
  queryKeys,
} from '../../../lib/api/index.js';
import { toast } from '../../../stores/toast-store.js';

/**
 * Workflow writes, and the two that actually do something to the world (PRD §5.6).
 *
 * **Never optimistic.** The rule the Agent Builder and the team writes already follow, with a
 * sharper reason here: starting a run creates real Sessions that spend real money. Painting a run
 * as started before the server answered would show a chain that a `400` refused — and the operator
 * would have no way to tell whether four sessions are running somewhere or none are.
 *
 * Failures surface with `code` and `requestId`, which on a contract this young is the only route
 * from a red toast to the Backend log line that explains it.
 */

export interface CreateWorkflowVariables {
  readonly body: Record<string, unknown>;
}

export function useCreateWorkflow(): UseMutationResult<unknown, ApiError, CreateWorkflowVariables> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, CreateWorkflowVariables>({
    retry: false,
    mutationFn: ({ body }) => apiSend<unknown>('POST', endpoints.agentWorkflows.list, { body }),
    onSuccess: (workflow) => {
      const id = idOf(workflow);
      if (id !== null) queryClient.setQueryData(queryKeys.agentWorkflows.detail(id), workflow);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentWorkflows.root() });
      toast({ kind: 'success', message: 'Workflow created' });
    },
    onError: (error) => reportFailure(error, 'Could not create the workflow'),
  });
}

export interface UpdateWorkflowVariables {
  readonly workflowId: string;
  readonly body: Record<string, unknown>;
}

export function useUpdateWorkflow(): UseMutationResult<unknown, ApiError, UpdateWorkflowVariables> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, UpdateWorkflowVariables>({
    retry: false,
    mutationFn: ({ workflowId, body }) =>
      apiSend<unknown>('PATCH', endpoints.agentWorkflows.detail(workflowId), { body }),
    onSuccess: (workflow, variables) => {
      queryClient.setQueryData(queryKeys.agentWorkflows.detail(variables.workflowId), workflow);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentWorkflows.list() });
      toast({ kind: 'success', message: 'Workflow saved' });
    },
    onError: (error) => reportFailure(error, 'Could not save the workflow'),
  });
}

export interface StartRunVariables {
  readonly workflowId: string;
  readonly body: Record<string, unknown>;
}

/**
 * `POST /agent-workflow-runs` — the button that spends money.
 *
 * No confirmation lives here: it lives in `PreRunDialog`, which is the *only* caller, because a
 * confirmation attached to a mutation would be a confirmation some future caller forgets to show.
 * What lives here is the part that must be true at every call site — the write is not optimistic,
 * the run list and the spend total are invalidated, and the failure is named with its `requestId`.
 *
 * The most likely refusal is a `409`: one `running` run per Project
 * (`ux_agent_workflow_runs_active`), because two chains editing one working tree is a merge
 * conflict with a bill attached. It surfaces as the Backend's own message rather than as a retry.
 */
export function useStartWorkflowRun(): UseMutationResult<unknown, ApiError, StartRunVariables> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, StartRunVariables>({
    retry: false,
    mutationFn: ({ body }) => apiSend<unknown>('POST', endpoints.agentWorkflowRuns.list, { body }),
    onSuccess: (run, variables) => {
      const id = idOf(run);
      if (id !== null) queryClient.setQueryData(queryKeys.agentWorkflowRuns.detail(id), run);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.agentWorkflowRuns.list({ workflowId: variables.workflowId }),
      });
      // A run creates Sessions, so the Sessions list and the spend total both moved.
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.root() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.spend() });
      toast({ kind: 'success', message: 'Run started' });
    },
    onError: (error) => reportFailure(error, 'The run did not start'),
  });
}

/** What stopping did to the Session that was in flight — the Backend's word, not this client's. */
export type StoppedSessionOutcome = 'ended' | 'left_unstarted' | 'already_terminal';

export interface StopRunResult {
  readonly run: unknown;
  /** `null` when no step was running. */
  readonly stoppedSession: {
    readonly sessionId: string;
    readonly outcome: StoppedSessionOutcome | string;
  } | null;
}

/**
 * `POST /agent-workflow-runs/{id}/stop` — the kill switch.
 *
 * Two things make this honest rather than hopeful.
 *
 * **It reads `meta`, not just `data`.** The route answers
 * `{ data: run, meta: { stoppedSession: { sessionId, outcome } } }`, and `outcome` is the answer to
 * the only question the operator actually asked: *did the Claude Code session stop?* `ended` means
 * the runtime was disposed; `left_unstarted` means the launch was still queued, so there was no
 * process to end and there never will be; `already_terminal` means it had finished on its own
 * first. This is reported verbatim in the toast — `apiSend` would have thrown the `meta` away.
 *
 * **It invalidates the Sessions group.** Whatever stopping did to those Sessions, the next render
 * reads it from the server rather than from a 15-second-old cache — which is what lets the run
 * screen contradict a stop that did not reach the process.
 */
export function useStopWorkflowRun(): UseMutationResult<
  StopRunResult,
  ApiError,
  { runId: string }
> {
  const queryClient = useQueryClient();

  return useMutation<StopRunResult, ApiError, { runId: string }>({
    retry: false,
    mutationFn: async ({ runId }) => {
      const response = await apiRequest(endpoints.agentWorkflowRuns.stop(runId), {
        method: 'POST',
      });
      return readStopResult(response);
    },
    onSuccess: (result, variables) => {
      if (result.run !== null && typeof result.run === 'object') {
        queryClient.setQueryData(queryKeys.agentWorkflowRuns.detail(variables.runId), result.run);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentWorkflowRuns.root() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.root() });
      toast({ kind: 'success', message: 'Run stopped', detail: stopDetail(result) });
    },
    onError: (error) => reportFailure(error, 'The run was not stopped'),
  });
}

export function readStopResult(response: unknown): StopRunResult {
  if (typeof response !== 'object' || response === null) return { run: null, stoppedSession: null };
  const envelope = response as Record<string, unknown>;
  const meta = envelope['meta'];
  const stopped =
    typeof meta === 'object' && meta !== null
      ? (meta as Record<string, unknown>)['stoppedSession']
      : null;

  if (typeof stopped !== 'object' || stopped === null) {
    return { run: envelope['data'] ?? null, stoppedSession: null };
  }
  const record = stopped as Record<string, unknown>;
  const sessionId = record['sessionId'];
  const outcome = record['outcome'];

  return {
    run: envelope['data'] ?? null,
    stoppedSession:
      typeof sessionId === 'string' && typeof outcome === 'string' ? { sessionId, outcome } : null,
  };
}

/** The one line that says what happened to the process, in the Backend's own vocabulary. */
export function stopDetail(result: StopRunResult): string {
  if (result.stoppedSession === null) {
    return 'No step was running, so no session had to be ended.';
  }
  switch (result.stoppedSession.outcome) {
    case 'ended':
      return 'The step’s session was ended and its runtime disposed.';
    case 'left_unstarted':
      return 'The step’s session had not started yet — its launch was still queued, so there was no process to end and it will never be prompted.';
    case 'already_terminal':
      return 'The step’s session had already finished on its own.';
    default:
      return `The Backend reported the session outcome as ‹${result.stoppedSession.outcome}›, which this build does not recognise. Open the session to see its state.`;
  }
}

/**
 * `POST /agent-workflow-runs/{id}/resume` — pick a halted chain up where it broke.
 *
 * This is the action that makes `halted` a state rather than an ending. It launches a **new**
 * Session for a new attempt at the failed step (F7 states never move backward), which is why it
 * spends from the run's `maxSessions` budget and why the confirmation says so.
 */
export function useResumeWorkflowRun(): UseMutationResult<unknown, ApiError, { runId: string }> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, { runId: string }>({
    retry: false,
    mutationFn: ({ runId }) => apiSend<unknown>('POST', endpoints.agentWorkflowRuns.resume(runId)),
    onSuccess: (run, variables) => {
      if (run !== null && typeof run === 'object') {
        queryClient.setQueryData(queryKeys.agentWorkflowRuns.detail(variables.runId), run);
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentWorkflowRuns.root() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.root() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.spend() });
      toast({ kind: 'success', message: 'Run resumed' });
    },
    onError: (error) => reportFailure(error, 'The run was not resumed'),
  });
}

/**
 * `PATCH /agent-workflows/{id} { archived }` — retirement, which for a workflow is archival.
 *
 * The Agent rule, not the team rule, and the Backend argues which side is history:
 * `agent_workflow_runs.workflow_id` records *which chain this run executed*, exactly as
 * `sessions.agent_id` records which persona a conversation ran as, so the FK is `RESTRICT` and
 * there is no delete path at all. An archived workflow cannot be started; every run it already
 * produced is untouched.
 */
export function useArchiveWorkflow(): UseMutationResult<
  unknown,
  ApiError,
  { workflowId: string; archived: boolean }
> {
  const queryClient = useQueryClient();

  return useMutation<unknown, ApiError, { workflowId: string; archived: boolean }>({
    retry: false,
    mutationFn: ({ workflowId, archived }) =>
      apiSend<unknown>('PATCH', endpoints.agentWorkflows.detail(workflowId), {
        body: { archived },
      }),
    onSuccess: (workflow, variables) => {
      queryClient.setQueryData(queryKeys.agentWorkflows.detail(variables.workflowId), workflow);
      void queryClient.invalidateQueries({ queryKey: queryKeys.agentWorkflows.root() });
      toast({
        kind: 'success',
        message: variables.archived ? 'Workflow archived' : 'Workflow restored',
      });
    },
    onError: (error, variables) =>
      reportFailure(
        error,
        variables.archived ? 'Could not archive the workflow' : 'Could not restore the workflow',
      ),
  });
}

export function idOf(document: unknown): string | null {
  if (typeof document !== 'object' || document === null) return null;
  const id = (document as Record<string, unknown>)['id'];
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function reportFailure(error: ApiError, title: string): void {
  const detail = error.requestId === null ? error.code : `${error.code} · ${error.requestId}`;
  toast({ kind: 'danger', message: `${title}: ${errorMessage(error)}`, detail });
}
