import {
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQueries,
  useQuery,
} from '@tanstack/react-query';
import {
  type ApiError,
  apiGet,
  apiList,
  DEFAULT_PAGE_LIMIT,
  endpoints,
  fetchCursorPage,
  flattenPages,
  nextPageParam,
  type PageOf,
  type Project,
  queryKeys,
  type Repository,
  type RepositoryStatus,
  type Session,
} from '../../lib/api/index.js';

/**
 * The Projects read surface (TDS 04 §4/§5.1, TDS 05 §3, TDS 06 §5.3).
 *
 * Query keys reuse the slots the rest of the app already writes to — `['projects','list',…]`
 * is the Dashboard's and the Launch modal's slot, `['sessions','list',{state,limit}]` is the
 * Dashboard's — so opening this screen warms those caches instead of duplicating them, and one
 * `repository.discovered` event invalidates every reader at once (`lib/ws/invalidation.ts`).
 */

// --------------------------------------------------------------------------- projects (§4)

export interface ProjectListFilters {
  /**
   * §4's filter is `?archived=false` (the default) and it is **exclusive, not additive**: the
   * Backend filters `archived_at IS NULL` or `IS NOT NULL`, so `archived=true` returns *only*
   * archived Projects. The UI renders it as a two-state segmented filter for that reason —
   * a "Show archived" checkbox would promise a combined list the API cannot produce.
   */
  readonly archived: boolean;
  readonly limit?: number | undefined;
}

export function useProjectsList(
  filters: ProjectListFilters,
): UseInfiniteQueryResult<readonly Project[], ApiError> {
  const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;

  return useInfiniteQuery<
    PageOf<Project>,
    ApiError,
    readonly Project[],
    ReturnType<typeof queryKeys.projects.list>,
    string | undefined
  >({
    queryKey: queryKeys.projects.list({ archived: filters.archived, limit }),
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchCursorPage<Project>(endpoints.projects.list, pageParam, {
        limit,
        query: { archived: filters.archived },
        signal,
      }),
    getNextPageParam: nextPageParam,
    select: (data) => flattenPages(data),
    retry: false,
  });
}

export function useProject(projectId: string | null): UseQueryResult<Project, ApiError> {
  return useQuery<Project, ApiError>({
    queryKey: queryKeys.projects.detail(projectId ?? 'none'),
    enabled: projectId !== null,
    queryFn: ({ signal }) =>
      apiGet<Project>(endpoints.projects.detail(projectId as string), { signal }),
    retry: false,
  });
}

// ---------------------------------------------------------------------- repositories (§5.1)

/**
 * Every Repository, in one request, grouped client-side.
 *
 * The list page needs a repository *count* per Project and there is no aggregate endpoint;
 * one `?projectId=` request per row would be N requests that all go stale together. A single
 * bounded page is the cheaper and more consistent answer at single-operator volumes, and it
 * shares its cache slot with the per-project read below through the `['repositories']` prefix.
 */
export function useAllRepositories(limit = 200): UseQueryResult<readonly Repository[], ApiError> {
  return useQuery<readonly Repository[], ApiError>({
    queryKey: queryKeys.repositories.list({ limit }),
    queryFn: async ({ signal }) => {
      const page = await apiList<Repository>(endpoints.repositories.list, {
        query: { limit },
        signal,
      });
      return page.data;
    },
    retry: false,
  });
}

export function useProjectRepositories(
  projectId: string | null,
): UseQueryResult<readonly Repository[], ApiError> {
  return useQuery<readonly Repository[], ApiError>({
    queryKey: queryKeys.repositories.list({ projectId: projectId ?? '', limit: 200 }),
    enabled: projectId !== null,
    queryFn: async ({ signal }) => {
      const page = await apiList<Repository>(endpoints.repositories.list, {
        query: { projectId: projectId ?? undefined, limit: 200 },
        signal,
      });
      return page.data;
    },
    retry: false,
  });
}

export interface RepositoryStatusRow {
  readonly repositoryId: string;
  readonly status: RepositoryStatus | null;
  readonly isPending: boolean;
  /** The status route itself failed (not the same as the tree being unreadable — see below). */
  readonly error: ApiError | null;
}

/**
 * Working-tree status for a set of repositories (`GET /repositories/{id}/status`).
 *
 * One request per repository because the read model is per-repository and there is no batch
 * form; bounded by the number of repositories a single operator registers. Each call runs a
 * real `git status` on the server, so the results are given a `staleTime` and are **not** put
 * on an interval — the tab offers an explicit recheck instead of polling a subprocess.
 *
 * A *failed request* and an *unreadable tree* are different things and stay different here: the
 * second arrives as a `200` with `unavailableReason` set and flows into `describeWorkingTree`,
 * while the first is a transport/API failure the row reports as such. Both render as "cannot
 * verify" — neither is ever allowed to render as clean.
 */
export function useRepositoryStatuses(
  repositoryIds: readonly string[],
  enabled: boolean,
): readonly RepositoryStatusRow[] {
  return useQueries({
    queries: repositoryIds.map((id) => ({
      queryKey: queryKeys.repositories.status(id),
      enabled,
      retry: false,
      staleTime: 30_000,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiGet<RepositoryStatus>(endpoints.repositories.status(id), { signal }),
    })),
    combine: (results): readonly RepositoryStatusRow[] =>
      results.map((result, index) => ({
        repositoryId: repositoryIds[index] as string,
        status: (result.data as RepositoryStatus | undefined) ?? null,
        isPending: result.isPending && result.fetchStatus !== 'idle',
        error: (result.error as ApiError | null) ?? null,
      })),
  });
}

// ------------------------------------------------------------------ session counts (§5.3.1)

/**
 * The F7 states the Projects list counts, in the priority order §5.3.1 fixes:
 * `running` → `paused` → `failed`. The cell shows the highest-priority two.
 */
export const PROJECT_SESSION_STATES = ['running', 'paused', 'failed'] as const;

export type ProjectSessionState = (typeof PROJECT_SESSION_STATES)[number];

export interface ProjectSessionCounts {
  /** `projectId → state → count`. Absent states mean zero and are not rendered (§5.3.1). */
  readonly byProject: ReadonlyMap<string, ReadonlyMap<ProjectSessionState, number>>;
  readonly isPending: boolean;
  /** True when at least one state query failed — the cell then says so instead of showing 0. */
  readonly isError: boolean;
}

/**
 * Session counts per Project, from three filtered list reads.
 *
 * Three requests rather than one because §6.2's filter set takes a single `state` and has no
 * `in` operator (the Dashboard's Active Sessions widget resolves the same constraint the same
 * way, and shares these exact cache slots). Fetching unfiltered and counting client-side would
 * be one request whose first cursor page could be entirely `completed` Sessions — the counts
 * would silently go to zero on the busiest instance.
 */
export function useProjectSessionCounts(limit = 50): ProjectSessionCounts {
  return useQueries({
    queries: PROJECT_SESSION_STATES.map((state) => ({
      queryKey: queryKeys.sessions.list({ state, limit }),
      retry: false,
      staleTime: 15_000,
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<readonly Session[]> => {
        const page = await apiList<Session>(endpoints.sessions.list, {
          query: { state, limit, order: 'desc' },
          signal,
        });
        return page.data;
      },
    })),
    combine: (results): ProjectSessionCounts => {
      const byProject = new Map<string, Map<ProjectSessionState, number>>();

      results.forEach((result, index) => {
        const state = PROJECT_SESSION_STATES[index] as ProjectSessionState;
        for (const session of (result.data as readonly Session[] | undefined) ?? []) {
          const counts = byProject.get(session.projectId) ?? new Map<ProjectSessionState, number>();
          counts.set(state, (counts.get(state) ?? 0) + 1);
          byProject.set(session.projectId, counts);
        }
      });

      return {
        byProject,
        isPending: results.some((result) => result.isPending),
        isError: results.some((result) => result.isError),
      };
    },
  });
}

// ------------------------------------------------------- the global workflow-mode default (§7.2)

/**
 * `integrations.github.workflowMode` — the global default a Project's `null` inherits.
 *
 * Read here as a **narrow projection** rather than by importing the Settings feature's
 * `IntegrationsSettings` type: TDS 05 §2.1 forbids cross-feature imports, and this screen needs
 * exactly one string out of that document. It shares the Settings cache slot
 * (`['settings','integrations']`), so a `setting.updated` event refreshes the name shown beside
 * the "Follow global default" option without this feature knowing anything about Settings.
 *
 * When the read fails the caller must say the default is **unknown** — labelling the inherit
 * option "Follow global default (Manual)" on a guess would tell the operator their Project
 * behaves in a way nobody verified.
 */
interface IntegrationsWorkflowProjection {
  readonly github?: { readonly workflowMode?: string | null } | null;
}

export type GlobalWorkflowMode = 'manual' | 'assisted' | null;

export interface GlobalWorkflowModeRead {
  /** `null` when the settings document could not be read, or carries an unexpected value. */
  readonly mode: GlobalWorkflowMode;
  readonly isPending: boolean;
  readonly isError: boolean;
}

export function useGlobalWorkflowMode(): GlobalWorkflowModeRead {
  const query = useQuery<IntegrationsWorkflowProjection, ApiError>({
    queryKey: queryKeys.settings.integrations(),
    queryFn: ({ signal }) =>
      apiGet<IntegrationsWorkflowProjection>(endpoints.settings.integrations, { signal }),
    retry: false,
    staleTime: 60_000,
  });

  const raw = query.data?.github?.workflowMode ?? null;

  return {
    mode: raw === 'manual' || raw === 'assisted' ? raw : null,
    isPending: query.isPending,
    isError: query.isError,
  };
}
