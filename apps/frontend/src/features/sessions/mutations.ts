import {
  type QueryClient,
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  ApiError,
  apiRequest,
  apiSend,
  endpoints,
  errorMessage,
  type InterruptResult,
  type LaunchMeta,
  queryKeys,
  type Session,
  type SessionAction,
} from '../../lib/api/index.js';
import { toast } from '../../stores/toast-store.js';
import { endpointActionOf, type SessionActionId } from './actions.js';

/**
 * Session mutations (TDS 05 §4, §11.3).
 *
 * **Nothing here is optimistic.** §11.3 lists session lifecycle actions and the `[Stop]`
 * interrupt in the "never optimistic" column, and the reason is F7: `INVALID_STATE_TRANSITION`
 * is a real server outcome, so a UI that moved the badge first would routinely show a state
 * the Backend rejected. Every mutation awaits the server and then invalidates.
 */

export interface SessionActionVariables {
  readonly action: SessionActionId;
  /** Clone/resume-as-new accept a title (§6.3). */
  readonly title?: string;
}

export interface SessionActionOutcome {
  readonly session: Session;
  /** §6.2.1 — present on `start` and in-place `resume`. */
  readonly launch: LaunchMeta['launch'] | null;
  /** True when `resume` created a NEW Session record (201) rather than resuming in place. */
  readonly createdNewSession: boolean;
  readonly action: SessionActionId;
}

/**
 * One request path for every lifecycle sub-action (F5.1: `POST /sessions/{id}/{action}`, never
 * a `PATCH` on `state`).
 *
 * A plain function rather than only a hook, because §9.4 requires the `Ctrl+K` palette to run
 * the *same* actions through the *same* non-optimistic path as the header. A palette with its
 * own copy would be the one that drifts.
 *
 * The 200-vs-201 distinction is load-bearing and is why this reads the raw response rather
 * than using `apiSend`: `resume` from `paused` resumes **in place**, while `resume` from
 * `completed`/`failed`/`archived` returns a **new** Session (§6.3). The caller navigates in
 * the second case; conflating them would strand the operator on the old record.
 */
export async function performSessionAction(
  sessionId: string,
  { action, title }: SessionActionVariables,
): Promise<SessionActionOutcome> {
  const wire: SessionAction = endpointActionOf(action);
  const body = title === undefined ? undefined : { title };
  const decoded = (await apiRequest(endpoints.sessions.action(sessionId, wire), {
    method: 'POST',
    ...(body === undefined ? {} : { body }),
  })) as { data: Session; meta?: LaunchMeta } | null;

  if (decoded === null || typeof decoded !== 'object' || !('data' in decoded)) {
    throw new ApiError({
      code: 'MALFORMED_RESPONSE',
      message: `Unexpected response from ${wire}`,
      status: 200,
    });
  }

  const session = decoded.data;
  return {
    session,
    launch: decoded.meta?.launch ?? null,
    // A resume that produced a different id is the F7 "resume creates a NEW Session" rule
    // made visible; there is no other signal in the body.
    createdNewSession: action === 'resume-new' || session.id !== sessionId,
    action,
  };
}

/** Everything a completed lifecycle action makes stale (§5.3's event table, applied eagerly). */
export function invalidateAfterAction(
  queryClient: QueryClient,
  sessionId: string,
  outcome: SessionActionOutcome,
): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.timeline(sessionId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.root() });
  if (outcome.session.id !== sessionId) {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.sessions.detail(outcome.session.id),
    });
  }
}

export function useSessionActionMutation(
  sessionId: string,
): UseMutationResult<SessionActionOutcome, ApiError, SessionActionVariables> {
  const queryClient = useQueryClient();

  return useMutation<SessionActionOutcome, ApiError, SessionActionVariables>({
    mutationFn: (variables) => performSessionAction(sessionId, variables),
    onSuccess: (outcome) => invalidateAfterAction(queryClient, sessionId, outcome),
    onError: (error) => reportMutationFailure(error),
  });
}

/**
 * `[Stop]` — `POST /sessions/{id}/interrupt` (§6.3.1).
 *
 * Deliberately **not** part of `useSessionActionMutation`'s invalidation set: an interrupt
 * performs no F7 transition and emits no `session.state_changed`, so refetching the Session
 * as though it had changed state would be modelling a transition that did not happen. What
 * *does* change is the transcript — the partial assistant turn is persisted with
 * `status: 'interrupted'` — and the timeline, which records the interruption.
 */
export function useInterruptMutation(
  sessionId: string,
): UseMutationResult<InterruptResult, ApiError, void> {
  const queryClient = useQueryClient();

  return useMutation<InterruptResult, ApiError, void>({
    mutationFn: () =>
      apiSend<InterruptResult>('POST', endpoints.sessions.action(sessionId, 'interrupt')),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.messages(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.timeline(sessionId) });
    },
    onError: (error) => reportMutationFailure(error, 'Could not stop the turn'),
  });
}

export interface PromptVariables {
  readonly content: string;
}

/**
 * `POST /sessions/{id}/prompts` (§6.4) — the canonical prompt transport.
 *
 * The WebSocket `prompt` frame is transport-equivalent, but REST is used here on purpose:
 * the frame's only advantage is saving a round trip on a loopback connection, while REST
 * gives a real HTTP status and a `requestId` for the failure path — and the failure path is
 * the one the operator has to be able to act on (§5.5 "Send failure").
 */
export function useSubmitPrompt(
  sessionId: string,
): UseMutationResult<{ messageId: string }, ApiError, PromptVariables> {
  const queryClient = useQueryClient();

  return useMutation<{ messageId: string }, ApiError, PromptVariables>({
    mutationFn: ({ content }) =>
      apiSend<{ messageId: string }>('POST', endpoints.sessions.prompts(sessionId), {
        body: { content },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.messages(sessionId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.detail(sessionId) });
    },
    // No toast: a failed prompt renders inline under its own pending entry (§5.5), where the
    // operator can retry or discard the exact text. A toast would name the failure somewhere
    // other than where the recovery affordance lives.
  });
}

export interface SessionPatch {
  readonly title?: string | null;
  readonly notes?: string | null;
}

/** `PATCH /sessions/{id}` — the operator title override (§6.11.4) and Notes (§6.1). */
export function useUpdateSession(
  sessionId: string,
): UseMutationResult<Session, ApiError, SessionPatch> {
  const queryClient = useQueryClient();

  return useMutation<Session, ApiError, SessionPatch>({
    mutationFn: (patch) =>
      apiSend<Session>('PATCH', endpoints.sessions.detail(sessionId), {
        body: patch,
      }),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.sessions.detail(sessionId), session);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.root() });
    },
    onError: (error) => reportMutationFailure(error, 'Could not save'),
  });
}

export interface CreateSessionVariables {
  readonly projectId: string;
  readonly workingDirectory: string;
  readonly repositoryId?: string;
  readonly branch?: string;
  readonly model?: string;
}

/** `POST /sessions` — creates in `created`; starting is a separate, later gesture (§5.4.1). */
export function useCreateSession(): UseMutationResult<Session, ApiError, CreateSessionVariables> {
  const queryClient = useQueryClient();

  return useMutation<Session, ApiError, CreateSessionVariables>({
    mutationFn: (input) => apiSend<Session>('POST', endpoints.sessions.list, { body: input }),
    onSuccess: (session) => {
      queryClient.setQueryData(queryKeys.sessions.detail(session.id), session);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions.root() });
    },
  });
}

/**
 * Mutation failures always surface (§11.1: "toasts never swallow errors silently"), and the
 * `requestId` rides along in the detail line because it is the operator's only bridge from a
 * red rectangle to the Backend log line that explains it.
 */
function reportMutationFailure(error: ApiError, title?: string): void {
  const detail = error.requestId === null ? error.code : `${error.code} · ${error.requestId}`;
  toast({
    kind: 'danger',
    message: title === undefined ? errorMessage(error) : `${title}: ${errorMessage(error)}`,
    detail,
  });
}
