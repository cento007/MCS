import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type AgentBindingChoices,
  type AgentBindingContext,
  type AgentView,
  partitionAgentsForBinding,
  readAgent,
  readAgentList,
} from '../../lib/agents/index.js';
import { type ApiError, apiGet, apiList, endpoints, queryKeys } from '../../lib/api/index.js';

/**
 * The Agents a Session can be bound to (PRD §5.1, TDS 04 §13.2).
 *
 * ## Why this reads every agent rather than a filtered list
 *
 * `GET /agents` accepts `?projectId=`, and using it looks like the obvious move. It is the wrong
 * one twice over:
 *
 *  - `?projectId=` filters on `agents.project_id`, so it returns *only* the project-scoped agents
 *    and drops every **global** one — which is the majority of what a launch should be offered.
 *  - `?includeArchived=` defaults to **false**, so archived agents would never arrive and the
 *    picker could not say *"3 agents are not offered here, and here is why"* about them. An
 *    absence the screen cannot account for is indistinguishable from an agent that does not exist.
 *
 * So this reads the whole set — bounded at 200, one cheap request on a single-operator instance —
 * and partitions it locally with `partitionAgentsForBinding`, which transcribes the Backend's own
 * refusals. Everything that is missing from the dropdown is therefore something the screen can
 * name.
 *
 * `retry: false` for the reason the Agents screen uses it: on a Backend without `/agents` the
 * route is a 404, and retrying it three times only delays an honest answer. `unavailable` is that
 * answer, and it is a different fact from "this instance has no agents".
 */

const AGENTS_STALE_MS = 30_000;

export interface BindableAgentsRead {
  readonly choices: AgentBindingChoices;
  /** Every agent the Backend served, before the binding rules were applied. */
  readonly all: readonly AgentView[];
  /** Rows served without an id or a name. Counted, never silently dropped. */
  readonly unreadable: number;
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly error: ApiError | null;
  /** The Backend does not serve `/agents` at all — not the same as "no agents yet". */
  readonly unavailable: boolean;
}

/** A 404/501 on a collection route means the route is missing, not that the request was wrong. */
export function isAgentsRouteMissing(error: unknown): boolean {
  const apiError = error as ApiError | null;
  if (apiError === null || apiError === undefined) return false;
  return apiError.status === 404 || apiError.status === 501;
}

export function useBindableAgents(
  context: AgentBindingContext,
  enabled: boolean,
): BindableAgentsRead {
  const query = useQuery<readonly unknown[], ApiError>({
    // The same cache slot the Agents screen fills when it is showing archived rows, so opening the
    // Launch modal after visiting `/agents` costs nothing and vice versa.
    queryKey: queryKeys.agents.list({ limit: 200, includeArchived: true }),
    enabled,
    retry: false,
    staleTime: AGENTS_STALE_MS,
    queryFn: async ({ signal }) => {
      const page = await apiList<unknown>(endpoints.agents.list, {
        query: { limit: 200, includeArchived: true },
        signal,
      });
      return page.data;
    },
  });

  const read = useMemo(() => readAgentList(query.data ?? []), [query.data]);
  const { projectId, sessionId } = context;
  const choices = useMemo(
    () => partitionAgentsForBinding(read.agents, { projectId, sessionId }),
    [read.agents, projectId, sessionId],
  );

  const unavailable = query.isError && isAgentsRouteMissing(query.error);

  return {
    choices,
    all: read.agents,
    unreadable: read.unreadable,
    isPending: enabled && query.isPending,
    isError: query.isError && !unavailable,
    error: unavailable ? null : (query.error ?? null),
    unavailable,
  };
}

/**
 * `GET /projects/{id}/available-agents` — the read that makes PRD §5.7's teams mean something.
 *
 * ## Why this is used for *emphasis* and not as the offer set
 *
 * It is the Backend's positive statement of the same rule `partitionAgentsForBinding` transcribes:
 * every agent it returns can be bound in this Project, and the ones it omits cannot. Using it as
 * the dropdown's contents would be tempting and would be a downgrade, because it returns only what
 * *is* available — so the picker could no longer account for the agent the operator can see on the
 * Agents screen and cannot find here. "Where did my agent go" is the question a filtered picker
 * generates, and the answer is never "it does not exist".
 *
 * What it adds is the thing a local partition cannot know: **which of the available agents are on
 * this Project's team**. That is the whole point of a team — the launch picker leads with the five
 * personas the operator chose to work with rather than an undifferentiated list.
 *
 * It fails soft in every direction. No route, no team, an error: the picker simply has no emphasis,
 * which is exactly how it behaved before teams existed.
 */
export interface ProjectTeamRead {
  /** Agent ids on the Project's assigned team, or an empty set when there is none. */
  readonly onTeam: ReadonlySet<string>;
  /** The team's name, for the group label. `null` when no team is assigned or none was read. */
  readonly teamName: string | null;
  /** Roster seats held by an archived agent — the difference between "5 members" and 4 offered. */
  readonly archivedMemberCount: number;
}

const NO_TEAM: ProjectTeamRead = {
  onTeam: new Set<string>(),
  teamName: null,
  archivedMemberCount: 0,
};

export function useProjectTeam(projectId: string | null, enabled: boolean): ProjectTeamRead {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.projects.availableAgents(projectId ?? 'none'),
    enabled: enabled && projectId !== null,
    retry: false,
    staleTime: AGENTS_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.projects.availableAgents(projectId as string), { signal }),
  });

  return useMemo(() => readProjectTeam(query.data), [query.data]);
}

/** Projected defensively: this read is younger than everything else the modal calls. */
export function readProjectTeam(document: unknown): ProjectTeamRead {
  if (typeof document !== 'object' || document === null) return NO_TEAM;
  const record = document as Record<string, unknown>;

  const onTeam = new Set<string>();
  const agents = record['agents'];
  if (Array.isArray(agents)) {
    for (const entry of agents) {
      if (typeof entry !== 'object' || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (row['onTeam'] === true && typeof row['id'] === 'string') onTeam.add(row['id']);
    }
  }

  const team = record['team'];
  const teamRecord =
    typeof team === 'object' && team !== null ? (team as Record<string, unknown>) : null;
  const teamName = typeof teamRecord?.['name'] === 'string' ? (teamRecord['name'] as string) : null;
  const archivedMemberCount =
    typeof teamRecord?.['archivedMemberCount'] === 'number'
      ? (teamRecord['archivedMemberCount'] as number)
      : 0;

  return { onTeam, teamName, archivedMemberCount };
}

/**
 * `agentId` → Agent, for a **list** of Sessions.
 *
 * One request for the whole table rather than one per row: the Sessions list can hold fifty rows
 * bound to a handful of agents, and `useSessionAgent` per row would issue a request per *distinct*
 * agent on a screen whose job is to load fast. It shares the cache slot the picker fills, so a
 * table rendered after the Launch modal has been opened costs nothing at all.
 *
 * The trade is stated rather than hidden: this reads one bounded page, so a Session bound to an
 * agent outside it resolves to `null` and the row renders the id tail. The **detail** header uses
 * `useSessionAgent`, which reads the agent directly and is always right — which is the surface
 * where being right matters.
 *
 * `settled` exists because "still loading" and "could not be read" render differently and must not
 * be conflated: a row that says `agent 00a001` while the request is in flight is telling the
 * operator that this agent is unreadable, which is a claim about their data rather than about the
 * clock.
 */
export type AgentLookup = (agentId: string) => AgentView | null;

export function useAgentNames(enabled: boolean): {
  readonly lookup: AgentLookup;
  /** False while the read is still in flight — a `null` before this is "not yet", not "missing". */
  readonly settled: boolean;
} {
  const read = useBindableAgents({ projectId: null, sessionId: null }, enabled);

  const byId = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const agent of read.all) map.set(agent.id, agent);
    return map;
  }, [read.all]);

  const lookup = useMemo<AgentLookup>(() => (agentId: string) => byId.get(agentId) ?? null, [byId]);

  return { lookup, settled: !enabled || !read.isPending };
}

/**
 * One Agent by id, for a Session that is already bound to one.
 *
 * Separate from `useBindableAgents` on purpose: a Session may run as an **archived** agent (it was
 * bound before it was retired, and archival deliberately does not rewrite history), and it may run
 * as one scoped to a project the operator is not currently looking at. Deriving the name from the
 * bindable list would make exactly those two agents display as nothing at all — the two cases where
 * knowing which persona ran matters most.
 */
export function useSessionAgent(agentId: string | null): {
  readonly agent: AgentView | null;
  readonly isPending: boolean;
  /** The Backend answered, and it was not an Agent this build can read. */
  readonly unreadable: boolean;
  /** No such agent, or no `/agents` route. Either way the name cannot be shown. */
  readonly unavailable: boolean;
} {
  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.agents.detail(agentId ?? 'none'),
    enabled: agentId !== null,
    retry: false,
    staleTime: AGENTS_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.agents.detail(agentId as string), { signal }),
  });

  const agent = useMemo(
    () => (query.data === undefined ? null : readAgent(query.data)),
    [query.data],
  );

  return {
    agent,
    isPending: agentId !== null && query.isPending,
    unreadable: query.isSuccess && agent === null,
    unavailable: query.isError,
  };
}
