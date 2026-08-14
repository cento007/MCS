import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type ApiError, apiGet, apiList, endpoints, queryKeys } from '../../../lib/api/index.js';
import {
  type AgentTeamListRead,
  type AgentTeamView,
  readAgentTeam,
  readAgentTeamList,
} from './shape.js';

/**
 * The AgentTeams read surface (PRD §5.7, TDS 04 §13.2).
 *
 * `retry: false` plus an explicit `unavailable` state, the same shape `features/agents/queries.ts`
 * uses — and not as a precaution: this screen was written while `/agent-teams` did not exist, and
 * the two apps ship separately, so a Backend without the route is a state a real operator will
 * see. "No route" and "no teams" have different fixes and only one of them is solved by pressing
 * New team.
 *
 * **No `includeArchived` parameter, and that is a contract difference worth stating.** Teams are
 * not archived — they are deleted (`DELETE /agent-teams/{id}`, `409` while assigned), because
 * nothing outside a team's own rows references it. Sending `includeArchived` here would be a
 * parameter the route does not declare, which Fastify's `removeAdditional` drops **silently** —
 * a filter that reads as applied and is not.
 */

const TEAMS_STALE_MS = 30_000;

export function isRouteMissing(error: unknown): boolean {
  const apiError = error as ApiError | null;
  if (apiError === null || apiError === undefined) return false;
  return apiError.status === 404 || apiError.status === 501;
}

export interface AgentTeamsQuery {
  readonly read: AgentTeamListRead;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly unavailable: boolean;
  refetch(): void;
}

export function useAgentTeams(): AgentTeamsQuery {
  const query = useQuery<readonly unknown[], ApiError>({
    queryKey: queryKeys.agentTeams.list({ limit: 200 }),
    retry: false,
    staleTime: TEAMS_STALE_MS,
    queryFn: async ({ signal }) => {
      const page = await apiList<unknown>(endpoints.agentTeams.list, {
        query: { limit: 200 },
        signal,
      });
      return page.data;
    },
  });

  const read = useMemo(() => readAgentTeamList(query.data ?? []), [query.data]);
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

export interface AgentTeamQuery {
  readonly team: AgentTeamView | null;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  readonly unavailable: boolean;
  /** The Backend answered, and the document was not a team this build can read. */
  readonly unreadable: boolean;
  refetch(): void;
}

export function useAgentTeam(teamId: string | null): AgentTeamQuery {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.agentTeams.detail(teamId ?? 'none'),
    enabled: teamId !== null,
    retry: false,
    staleTime: TEAMS_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.agentTeams.detail(teamId as string), { signal }),
  });

  const team = useMemo(
    () => (query.data === undefined ? null : readAgentTeam(query.data)),
    [query.data],
  );
  const unavailable = query.isError && isRouteMissing(query.error);

  return {
    team,
    isPending: teamId !== null && query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
    unreadable: query.isSuccess && team === null,
    refetch: () => void query.refetch(),
  };
}
