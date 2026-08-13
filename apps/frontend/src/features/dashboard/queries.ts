import { type UseQueryResult, useQueries, useQuery } from '@tanstack/react-query';
import {
  type ApiError,
  apiGet,
  apiList,
  endpoints,
  type Notification,
  type Project,
  queryKeys,
  type ScheduleEntry,
  type Session,
  type Spend,
} from '../../lib/api/index.js';

/**
 * The Dashboard's read surface (TDS 06 §5.2, TDS 04 §6.2/§7.7/§7.8/§8).
 *
 * Every query here is deliberately keyed to match an existing key elsewhere in the app where
 * one exists — `['sessions','list',{state:'running',limit:50}]` is the same slot the sidebar
 * running-count uses, `['projects','list',{archived:false}]` the same slot the launch modal
 * uses — so opening the Dashboard warms the caches the rest of the shell reads instead of
 * duplicating them.
 *
 * Freshness comes from F6 events, not from polling: the shell holds the `sessions`,
 * `settings` and `notifications` channels for the whole authenticated lifetime, and
 * `lib/ws/invalidation.ts` already maps those channels onto `['sessions']`, `['spend']`,
 * `['schedule']` and `['notifications']`. The one exception is service health, which polls on
 * purpose (`lib/service-health.ts`).
 */

/** §5.2: "Shows only `running` + `paused` (that is what 'active' means here)… max 6". */
export const MAX_ACTIVE_SESSION_ROWS = 6;

/** §5.2: the Needs Attention widget caps at 8 rows. */
const FAILED_PAGE_LIMIT = 50;

export interface SessionsSlice {
  readonly sessions: readonly Session[];
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly refetch: () => void;
}

function sessionsByState(state: 'running' | 'paused' | 'failed', limit: number) {
  return {
    queryKey: queryKeys.sessions.list({ state, limit }),
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<readonly Session[]> => {
      const page = await apiList<Session>(endpoints.sessions.list, {
        query: { state, limit, order: 'desc' },
        signal,
      });
      return page.data;
    },
    retry: false,
    staleTime: 15_000,
  };
}

/**
 * `running` + `paused`, newest first.
 *
 * Two requests rather than one, because §6.2's filter set takes a single `state` and offers
 * no `in` operator. Fetching unfiltered and filtering client-side would be one request but
 * would also mean a page full of `completed` Sessions could push every active one off the
 * first cursor page — the widget would go empty on exactly the busy instance that needs it.
 */
export function useActiveSessions(): SessionsSlice {
  return useQueries({
    queries: [sessionsByState('running', 50), sessionsByState('paused', 50)],
    combine: (results): SessionsSlice => {
      const sessions = results
        .flatMap((result) => (result.data as readonly Session[] | undefined) ?? [])
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

      return {
        sessions,
        isPending: results.some((result) => result.isPending),
        isError: results.some((result) => result.isError),
        error: (results.find((result) => result.isError)?.error as ApiError | undefined) ?? null,
        refetch: () => {
          for (const result of results) void result.refetch();
        },
      };
    },
  });
}

/**
 * Sessions in `failed`, newest first — the first source of the Needs Attention widget.
 *
 * **The 24 h window is applied client-side, per contract** (TDS 04 §6.2, WS7 N16): there is
 * no `?since=` filter in V1 and adding one would want an index no other read path needs. The
 * list is newest-first, so one page contains every recent failure at single-operator
 * volumes; the documented trigger for revisiting is "more than `limit` Sessions can plausibly
 * fail inside 24 h".
 */
export function useFailedSessions(): SessionsSlice {
  const query = useQuery<readonly Session[], ApiError>(
    sessionsByState('failed', FAILED_PAGE_LIMIT),
  );

  return {
    sessions: query.data ?? [],
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    refetch: () => void query.refetch(),
  };
}

/** Non-archived Projects, sharing the launch modal's cache slot. */
export function useActiveProjects(): UseQueryResult<readonly Project[], ApiError> {
  return useQuery<readonly Project[], ApiError>({
    queryKey: queryKeys.projects.list({ archived: false }),
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

/** `id → name`, for the `project · branch` secondary line (§9.3). */
export function projectNames(
  projects: readonly Project[] | undefined,
): ReadonlyMap<string, string> {
  return new Map((projects ?? []).map((project) => [project.id, project.name]));
}

/**
 * `GET /spend` (§7.8).
 *
 * The interval is 60 s because TDS 04 §14.7 fixes that floor: there is no `spend.*` event —
 * a total is a derived aggregate, not an entity change — so the client refetches on
 * `session.completed` / `session.failed` from the `sessions` channel (already wired in
 * `invalidation.ts`) and otherwise "on an interval no tighter than 60 s".
 */
export function useSpend(): UseQueryResult<Spend, ApiError> {
  return useQuery<Spend, ApiError>({
    queryKey: queryKeys.spend(),
    queryFn: ({ signal }) => apiGet<Spend>(endpoints.spend, { signal }),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * `GET /schedule` (§7.7) — a computed read model, **not a Task list** (arbitration A1).
 *
 * Fixed cardinality, so no cursor and no `meta`. Values change only when Settings change or
 * a run completes, both of which invalidate this key through the `settings` / `sync`
 * channels, so there is no interval here at all.
 */
export function useSchedule(): UseQueryResult<readonly ScheduleEntry[], ApiError> {
  return useQuery<readonly ScheduleEntry[], ApiError>({
    queryKey: queryKeys.schedule(),
    queryFn: ({ signal }) => apiGet<readonly ScheduleEntry[]>(endpoints.schedule, { signal }),
    staleTime: 60_000,
    retry: false,
  });
}

/**
 * The newest Notifications (§8), cursor list, newest first.
 *
 * Phase 1 has no producer for most types yet, so this legitimately answers an empty list —
 * which is why the widget renders "No notifications" rather than a phase placeholder: the
 * endpoint is real, the answer is honest, and rows appear the moment a worker writes one.
 */
export function useNotifications(limit = 5): UseQueryResult<readonly Notification[], ApiError> {
  return useQuery<readonly Notification[], ApiError>({
    queryKey: queryKeys.notifications.list({ limit }),
    queryFn: async ({ signal }) => {
      const page = await apiList<Notification>(endpoints.notifications.list, {
        query: { limit },
        signal,
      });
      return page.data;
    },
    staleTime: 30_000,
    retry: false,
  });
}
