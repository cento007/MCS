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
  type Commit,
  DEFAULT_PAGE_LIMIT,
  endpoints,
  fetchCursorPage,
  flattenPages,
  type Message,
  nextPageParam,
  type PageOf,
  type Project,
  queryKeys,
  type Repository,
  type Session,
  type SessionFiles,
  type SessionListFilters,
  type TimelineEntry,
} from '../../lib/api/index.js';

/**
 * The Sessions read surface (TDS 05 §3, §6.1, §6.7; TDS 04 §6).
 *
 * Everything here is TanStack Query — **no delta ever passes through this file**. §6.2 is
 * explicit that the streaming layer bypasses the cache entirely: REST owns state, the socket
 * owns liveness, and a cache write per token would issue a refetch per character.
 */

export function useSession(sessionId: string | null): UseQueryResult<Session, ApiError> {
  return useQuery<Session, ApiError>({
    queryKey: queryKeys.sessions.detail(sessionId ?? 'none'),
    queryFn: ({ signal }) =>
      apiGet<Session>(endpoints.sessions.detail(sessionId as string), { signal }),
    enabled: sessionId !== null,
    retry: false,
  });
}

export interface OpenSessionRow {
  readonly id: string;
  readonly session: Session | null;
  /** True once the Backend has said this Session does not exist (persisted id went stale). */
  readonly missing: boolean;
}

/**
 * Resolve the persisted open-session ids to live Session records.
 *
 * §6.5: "On reload, persisted ids are validated against `['sessions']` and silently dropped
 * if the Session no longer exists." A per-id fetch is the stricter form of that check — the
 * list is cursor-paginated and a Session six pages deep would otherwise look deleted — and
 * it is bounded by the cap of 6.
 */
export function useOpenSessions(sessionIds: readonly string[]): readonly OpenSessionRow[] {
  return useQueries({
    queries: sessionIds.map((id) => ({
      queryKey: queryKeys.sessions.detail(id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        apiGet<Session>(endpoints.sessions.detail(id), { signal }),
      retry: false,
      staleTime: 30_000,
    })),
    combine: (results): readonly OpenSessionRow[] =>
      results.map((result, index) => ({
        id: sessionIds[index] as string,
        session: (result.data as Session | undefined) ?? null,
        missing: result.isError && (result.error as ApiError | null)?.status === 404,
      })),
  });
}

/** §3.1 sidebar footer: the live count of `running` Sessions. */
export function useRunningSessions(): UseQueryResult<readonly Session[], ApiError> {
  return useQuery<readonly Session[], ApiError>({
    queryKey: queryKeys.sessions.list({ state: 'running', limit: 50 }),
    queryFn: async ({ signal }) => {
      // The list envelope carries no total (F5.3 is cursor-based, deliberately), so the
      // count is `data.length` against a bounded page. On a single-operator instance more
      // than 50 concurrently-running Sessions is not a real condition, and the display caps
      // anyway.
      const page = await apiList<Session>(endpoints.sessions.list, {
        query: { state: 'running', limit: 50 },
        signal,
      });
      return page.data;
    },
    retry: false,
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------- list (§5.4)

/**
 * The Sessions list, cursor-paginated (F5.3). "Load more", never page numbers — a page
 * number over a live-inserting collection points at different rows every time it is clicked.
 */
export function useSessionsList(
  filters: SessionListFilters,
): UseInfiniteQueryResult<readonly Session[], ApiError> {
  return useInfiniteQuery<
    PageOf<Session>,
    ApiError,
    readonly Session[],
    ReturnType<typeof queryKeys.sessions.list>,
    string | undefined
  >({
    queryKey: queryKeys.sessions.list(filters),
    initialPageParam: undefined,
    queryFn: ({ pageParam, signal }) =>
      fetchCursorPage<Session>(endpoints.sessions.list, pageParam, {
        limit: filters.limit ?? DEFAULT_PAGE_LIMIT,
        query: {
          ...(filters.state === undefined ? {} : { state: filters.state }),
          ...(filters.projectId === undefined ? {} : { projectId: filters.projectId }),
          ...(filters.sessionType === undefined ? {} : { sessionType: filters.sessionType }),
          ...(filters.repositoryId === undefined ? {} : { repositoryId: filters.repositoryId }),
          ...(filters.order === undefined ? {} : { order: filters.order }),
        },
        signal,
      }),
    getNextPageParam: nextPageParam,
    select: (data) => flattenPages(data),
    retry: false,
  });
}

// ------------------------------------------------------------------------ messages (§6.6)

export interface MessagePages {
  /** Committed Messages in **ascending `ordinal`** — the only conversation-order key (A5). */
  readonly messages: readonly Message[];
  readonly hasOlder: boolean;
  readonly isFetchingOlder: boolean;
  readonly fetchOlder: () => void;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly refetch: () => void;
}

/**
 * Committed history for one Session, fetched **newest page first** (`order=desc`) and
 * reversed for rendering.
 *
 * That direction is what makes §6.3's reverse infinite scroll a one-liner rather than an
 * index computation: the transcript opens at the bottom (where the operator's attention is),
 * and `fetchNextPage` walks *backwards* in time, prepending older history. Fetching `asc`
 * would open the transcript at the oldest message of a 400-message session — the one place
 * nobody wants to start.
 */
export function useSessionMessages(sessionId: string | null, pageSize = 50): MessagePages {
  const query = useInfiniteQuery<
    PageOf<Message>,
    ApiError,
    readonly Message[],
    ReturnType<typeof queryKeys.sessions.messages>,
    string | undefined
  >({
    queryKey: queryKeys.sessions.messages(sessionId ?? 'none'),
    initialPageParam: undefined,
    enabled: sessionId !== null,
    queryFn: ({ pageParam, signal }) =>
      fetchCursorPage<Message>(endpoints.sessions.messages(sessionId as string), pageParam, {
        limit: pageSize,
        query: { order: 'desc' },
        signal,
      }),
    getNextPageParam: nextPageParam,
    select: (data) => sortByOrdinal(flattenPages(data)),
    retry: false,
  });

  return {
    messages: query.data ?? [],
    hasOlder: query.hasNextPage,
    isFetchingOlder: query.isFetchingNextPage,
    fetchOlder: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
    },
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/**
 * Ascending `ordinal`, de-duplicated by id.
 *
 * The de-duplication is not defensive padding: a Message's `status` advances
 * `pending → complete | interrupted` and **re-emits `session.message.appended` for the same
 * id** (§6.6), so a refetch that straddles that advance can legitimately return the same
 * Message in two pages. Last write wins, which is the newer status.
 */
export function sortByOrdinal(messages: readonly Message[]): readonly Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.ordinal - b.ordinal);
}

// ------------------------------------------------------------------- right panel (§6.7)

/**
 * Panel queries fetch **lazily on first activation** and then stay mounted (§6.7) — which is
 * what `enabled` expresses here. A collapsed panel costs nothing; an expanded one that the
 * operator has looked at once keeps refreshing with the rest of the view.
 */
export function useSessionTimeline(
  sessionId: string | null,
  enabled: boolean,
): UseInfiniteQueryResult<readonly TimelineEntry[], ApiError> {
  return useInfiniteQuery<
    PageOf<TimelineEntry>,
    ApiError,
    readonly TimelineEntry[],
    ReturnType<typeof queryKeys.sessions.timeline>,
    string | undefined
  >({
    queryKey: queryKeys.sessions.timeline(sessionId ?? 'none'),
    initialPageParam: undefined,
    enabled: enabled && sessionId !== null,
    queryFn: ({ pageParam, signal }) =>
      fetchCursorPage<TimelineEntry>(endpoints.sessions.timeline(sessionId as string), pageParam, {
        limit: 50,
        signal,
      }),
    getNextPageParam: nextPageParam,
    select: (data) => flattenPages(data),
    retry: false,
  });
}

export function useSessionCommits(
  sessionId: string | null,
  enabled: boolean,
): UseInfiniteQueryResult<readonly Commit[], ApiError> {
  return useInfiniteQuery<
    PageOf<Commit>,
    ApiError,
    readonly Commit[],
    ReturnType<typeof queryKeys.sessions.commits>,
    string | undefined
  >({
    queryKey: queryKeys.sessions.commits(sessionId ?? 'none'),
    initialPageParam: undefined,
    enabled: enabled && sessionId !== null,
    queryFn: ({ pageParam, signal }) =>
      fetchCursorPage<Commit>(endpoints.sessions.commits(sessionId as string), pageParam, {
        limit: 50,
        signal,
      }),
    getNextPageParam: nextPageParam,
    select: (data) => flattenPages(data),
    retry: false,
  });
}

/** §6.10.2 — bounded read model: `{ data }` with no cursor and no `meta`. */
export function useSessionFiles(
  sessionId: string | null,
  enabled: boolean,
): UseQueryResult<SessionFiles, ApiError> {
  return useQuery<SessionFiles, ApiError>({
    queryKey: queryKeys.sessions.files(sessionId ?? 'none'),
    enabled: enabled && sessionId !== null,
    queryFn: ({ signal }) =>
      apiGet<SessionFiles>(endpoints.sessions.files(sessionId as string), { signal }),
    retry: false,
  });
}

// ------------------------------------------------------------- launch modal sources (§5.4.1)

/**
 * Projects and Repositories for the Launch modal.
 *
 * **These endpoints are not served by the Backend yet** (`/projects`, `/repositories` — the
 * Session domain shipped ahead of them). The queries are written to the §4/§5.1 contract and
 * `retry: false`, so the modal renders the F5.4 envelope with its `requestId` and disables
 * `[Create]` rather than presenting an empty picker that looks like "no projects exist".
 */
export function useProjects(enabled: boolean): UseQueryResult<readonly Project[], ApiError> {
  return useQuery<readonly Project[], ApiError>({
    queryKey: queryKeys.projects.list({ archived: false }),
    enabled,
    retry: false,
    queryFn: async ({ signal }) => {
      const page = await apiList<Project>(endpoints.projects.list, {
        query: { archived: false, limit: 100 },
        signal,
      });
      return page.data;
    },
  });
}

export function useRepositories(
  projectId: string | null,
  enabled: boolean,
): UseQueryResult<readonly Repository[], ApiError> {
  return useQuery<readonly Repository[], ApiError>({
    queryKey: queryKeys.repositories.list({ projectId: projectId ?? '' }),
    enabled: enabled && projectId !== null,
    retry: false,
    queryFn: async ({ signal }) => {
      const page = await apiList<Repository>(endpoints.repositories.list, {
        query: { projectId: projectId ?? undefined, limit: 100 },
        signal,
      });
      return page.data;
    },
  });
}
