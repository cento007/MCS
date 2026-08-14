import { type UseQueryResult, useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type ApiError,
  apiGet,
  apiList,
  endpoints,
  queryKeys,
  type Repository,
  type Session,
} from '../../../lib/api/index.js';
import { type CostEstimateView, readCostEstimate } from './estimate.js';
import {
  readWorkflow,
  readWorkflowList,
  readWorkflowRun,
  readWorkflowRunList,
  type WorkflowListRead,
  type WorkflowRunListRead,
  type WorkflowRunView,
  type WorkflowView,
} from './shape.js';

/**
 * The Workflows read surface (PRD §5.6).
 *
 * Written the way `features/agents/teams/queries.ts` was written, and for a sharper version of the
 * same reason: those screens were built while `/agent-teams` did not exist, and these are built
 * while **no workflow route exists at all**. So every read declares `unavailable` separately from
 * `isError`, and every screen behind it says *"this Backend does not serve …"* rather than
 * rendering an empty list. "No workflows" and "no workflows API" have different fixes and only one
 * of them is solved by pressing New workflow.
 *
 * `retry: false` throughout: a 404 retried three times is only a slower 404.
 */

/** A definition changes when a person edits it. */
const WORKFLOW_STALE_MS = 30_000;

/**
 * A run does not.
 *
 * Zero, deliberately: a run advances on its own, and every screen that shows one is watching
 * something that is spending money. Freshness here comes from the WebSocket (`lib/ws/invalidation`
 * routes both the workflow events and, more importantly, the **session** state changes that a step
 * advancing produces), and this only makes sure a refetch triggered by any of them is not served
 * from cache.
 */
const RUN_STALE_MS = 0;

export function isRouteMissing(error: unknown): boolean {
  const apiError = error as ApiError | null;
  if (apiError === null || apiError === undefined) return false;
  return apiError.status === 404 || apiError.status === 501;
}

export interface WorkflowsQuery {
  readonly read: WorkflowListRead;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  /** The Backend serves no `/agent-workflows` — different from "no workflows yet". */
  readonly unavailable: boolean;
  refetch(): void;
}

/**
 * `includeArchived` goes **on the wire**, not through a local filter, for the reason the Agents
 * list states: the Backend excludes archived rows by default, so no amount of client-side filtering
 * can produce them — and archival is the only retirement a workflow has.
 */
export function useWorkflows(includeArchived = false): WorkflowsQuery {
  const query = useQuery<readonly unknown[], ApiError>({
    queryKey: queryKeys.agentWorkflows.list({ limit: 200, includeArchived }),
    retry: false,
    staleTime: WORKFLOW_STALE_MS,
    queryFn: async ({ signal }) => {
      const page = await apiList<unknown>(endpoints.agentWorkflows.list, {
        // `buildUrl` drops `''`/`null`/`undefined` but keeps `false`, so the parameter is sent
        // either way and the Backend's default is never relied on implicitly.
        query: { limit: 200, includeArchived },
        signal,
      });
      return page.data;
    },
  });

  const read = useMemo(() => readWorkflowList(query.data ?? []), [query.data]);
  const unavailable = query.isError && isRouteMissing(query.error);

  return {
    read,
    isPending: query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
    refetch: () => void query.refetch(),
  };
}

export interface WorkflowQuery {
  readonly workflow: WorkflowView | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly unavailable: boolean;
  /** The Backend answered, and the document was not a workflow this build can read. */
  readonly unreadable: boolean;
  refetch(): void;
}

export function useWorkflow(workflowId: string | null): WorkflowQuery {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.agentWorkflows.detail(workflowId ?? 'none'),
    enabled: workflowId !== null,
    retry: false,
    staleTime: WORKFLOW_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.agentWorkflows.detail(workflowId as string), { signal }),
  });

  const workflow = useMemo(
    () => (query.data === undefined ? null : readWorkflow(query.data)),
    [query.data],
  );
  const unavailable = query.isError && isRouteMissing(query.error);

  return {
    workflow,
    isPending: workflowId !== null && query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
    unreadable: query.isSuccess && workflow === null,
    refetch: () => void query.refetch(),
  };
}

export interface WorkflowRunsQuery {
  readonly read: WorkflowRunListRead;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly unavailable: boolean;
  refetch(): void;
}

/**
 * How many runs the workflow page lists. A constant, so it stays out of the cache key.
 *
 * Exported because the screen **says so** when it hits the cap: the route is cursor-paginated and
 * this reads one page, so a chain with more than fifty runs would otherwise show its newest fifty
 * and look complete. There is no "load more" here yet — that is a real gap, disclosed rather than
 * hidden.
 */
export const RUN_PAGE_LIMIT = 50;

/**
 * The runs of one workflow, newest first — `order=desc` is the Backend's default for this
 * collection and the only order it is ever read in.
 */
export function useWorkflowRuns(workflowId: string | null): WorkflowRunsQuery {
  const query = useQuery<readonly unknown[], ApiError>({
    queryKey: queryKeys.agentWorkflowRuns.list({ workflowId: workflowId ?? 'none' }),
    enabled: workflowId !== null,
    retry: false,
    staleTime: RUN_STALE_MS,
    queryFn: async ({ signal }) => {
      const page = await apiList<unknown>(endpoints.agentWorkflowRuns.list, {
        query: { workflowId: workflowId ?? undefined, limit: RUN_PAGE_LIMIT, order: 'desc' },
        signal,
      });
      return page.data;
    },
  });

  const read = useMemo(() => readWorkflowRunList(query.data ?? []), [query.data]);
  const unavailable = query.isError && isRouteMissing(query.error);

  return {
    read,
    isPending: workflowId !== null && query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
    refetch: () => void query.refetch(),
  };
}

export interface WorkflowRunQuery {
  readonly run: WorkflowRunView | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly unavailable: boolean;
  readonly unreadable: boolean;
  /** When this client last had an answer from the server — the run view prints it. */
  readonly updatedAt: number | null;
  readonly isFetching: boolean;
  refetch(): void;
}

export function useWorkflowRun(runId: string | null): WorkflowRunQuery {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.agentWorkflowRuns.detail(runId ?? 'none'),
    enabled: runId !== null,
    retry: false,
    staleTime: RUN_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.agentWorkflowRuns.detail(runId as string), { signal }),
  });

  const run = useMemo(
    () => (query.data === undefined ? null : readWorkflowRun(query.data)),
    [query.data],
  );
  const unavailable = query.isError && isRouteMissing(query.error);

  return {
    run,
    isPending: runId !== null && query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
    unreadable: query.isSuccess && run === null,
    updatedAt: query.dataUpdatedAt === 0 ? null : query.dataUpdatedAt,
    isFetching: query.isFetching,
    refetch: () => void query.refetch(),
  };
}

// ------------------------------------------------------------------------- what a run will cost

export interface CostEstimateQuery {
  readonly estimate: CostEstimateView | null;
  readonly isPending: boolean;
  /** The estimate could not be read. Not an error the operator must clear — the dialog says so. */
  readonly isUnavailable: boolean;
}

/**
 * `GET /agent-workflows/{id}/cost-estimate` — read by the pre-run dialog and nowhere else.
 *
 * It **fails soft**, deliberately: an operator must never be blocked from starting a run because
 * the *estimate* endpoint is missing on an older Backend. The dialog then says the cost history
 * could not be read, which is a different sentence from "this run is free".
 */
export function useWorkflowCostEstimate(
  workflowId: string | null,
  enabled: boolean,
): CostEstimateQuery {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.agentWorkflows.costEstimate(workflowId ?? 'none'),
    enabled: enabled && workflowId !== null,
    retry: false,
    staleTime: WORKFLOW_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.agentWorkflows.costEstimate(workflowId as string), { signal }),
  });

  const estimate = useMemo(
    () => (query.data === undefined ? null : readCostEstimate(query.data)),
    [query.data],
  );

  return {
    estimate,
    isPending: enabled && workflowId !== null && query.isPending,
    isUnavailable: query.isError || (query.isSuccess && estimate === null),
  };
}

// ------------------------------------------------------------------- the steps' own Sessions

export interface StepSessionsRead {
  readonly sessionOf: (sessionId: string) => Session | null;
  /** Ids the Backend answered `404` for — a step pointing at a Session that is not there. */
  readonly missing: ReadonlySet<string>;
  readonly isPending: boolean;
}

/**
 * The Sessions the run's steps *are*.
 *
 * Read directly rather than through `features/sessions/` — TDS 05 §2.1 forbids one feature slice
 * from importing another — but into **exactly the same cache slot and with exactly the same
 * shape** as `features/sessions/queries.ts#useSession`: `queryKeys.sessions.detail(id)` holding a
 * `Session`. That is not a coincidence to be tidied away later; it is what makes the `sessions`
 * WebSocket channel keep these rows fresh, and what makes opening a step's session from here
 * instant. Two different shapes in one key is the collision documented at the top of
 * `lib/api/query-keys.ts`.
 *
 * Why fetch them at all, when the run already reports a state per step: because the run's account
 * and the Session's own F7 state can disagree, and after pressing **Stop** that disagreement is the
 * whole question. See `stepSessionDisagreement`.
 */
export function useStepSessions(sessionIds: readonly string[]): StepSessionsRead {
  const results = useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: queryKeys.sessions.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiGet<Session>(endpoints.sessions.detail(id), { signal }),
      retry: false,
      staleTime: 15_000,
    })),
  });

  /**
   * Built on every render rather than memoised, and that is deliberate: the natural memo key here
   * is one entry per result, which makes the dependency array change length whenever a step is
   * added — and React throws on a dependency array that changes size. A run has single-digit steps,
   * so the map costs nothing; correctness beats a memo that would crash the screen.
   */
  const byId = new Map<string, Session>();
  const missing = new Set<string>();
  let pending = false;

  results.forEach((result, index) => {
    const id = sessionIds[index];
    if (id === undefined) return;
    const session = result.data as Session | undefined;
    if (session !== undefined) byId.set(id, session);
    if (result.isError && (result.error as ApiError | null)?.status === 404) missing.add(id);
    if (result.isPending) pending = true;
  });

  return {
    sessionOf: (sessionId: string) => byId.get(sessionId) ?? null,
    missing,
    isPending: pending,
  };
}

// -------------------------------------------------------------------- pre-run: where it runs

/**
 * Repositories of the workflow's project, for the pre-run dialog's working-directory field.
 *
 * Same slot and same shape as `features/sessions/queries.ts#useRepositories`, for the reason above.
 * The path is what the runtime is given write access to, so it is offered from server truth and
 * still typed over freely — a run may legitimately work somewhere other than a repository root.
 */
export function useWorkflowRepositories(
  projectId: string | null,
  enabled: boolean,
): UseQueryResult<readonly Repository[], ApiError> {
  return useQuery<readonly Repository[], ApiError>({
    queryKey: queryKeys.repositories.list({ projectId: projectId ?? '' }),
    enabled: enabled && projectId !== null,
    retry: false,
    staleTime: 60_000,
    queryFn: async ({ signal }) => {
      const page = await apiList<Repository>(endpoints.repositories.list, {
        query: { projectId: projectId ?? undefined, limit: 100 },
        signal,
      });
      return page.data;
    },
  });
}
