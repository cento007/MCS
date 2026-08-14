import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  type AgentView,
  NO_AVAILABILITY,
  type ProjectAgentAvailability,
  readAgent,
  readAgentList,
  readProjectAgentAvailability,
} from '../../lib/agents/index.js';
import { type ApiError, apiGet, apiList, endpoints, queryKeys } from '../../lib/api/index.js';

/**
 * The two agent reads the Sessions slice makes, and they answer different questions.
 *
 *  - **`useAgentAvailability`** — *which agents may be bound to a Session in this Project, and why
 *    the others may not.* One request, `GET /projects/{id}/available-agents`, and the whole answer
 *    is the server's.
 *  - **`useAgentDirectory` / `useSessionAgent`** — *what is this agent called.* A lookup over
 *    `GET /agents`, used to name an agent a Session is **already** bound to. It says nothing about
 *    bindability and must not: a running Session may be bound to an archived agent, or to one
 *    scoped to a project the operator is not looking at, and those are exactly the two cases where
 *    knowing which persona ran matters most.
 *
 * ## What this file used to do
 *
 * `useBindableAgents` read the *whole* agents table (`?limit=200&includeArchived=true`) and
 * partitioned it in the browser with `partitionAgentsForBinding` — a hand-maintained transcription
 * of the Backend's refusals. It was written that way for a good reason: the availability route
 * returned only what *was* available, so using it would have left the picker unable to account for
 * an agent the operator could see on the Agents screen and not find here.
 *
 * The Backend now returns both halves from one function — the same `agentBindingRefusal` that
 * `POST /sessions` enforces — so the reason for the local partition is gone and with it the risk
 * that paid for it: a refusal added server-side reaches this picker on the same commit, or it
 * reaches nothing. The exclusion sentences rendered under the field are the server's own strings,
 * identical to the ones its `400`/`409` would have carried.
 *
 * `useProjectTeam` is gone for the same reason: it read this very document for `onTeam` while the
 * offer set came from somewhere else. One document, one read, one answer.
 */

const AGENTS_STALE_MS = 30_000;

/**
 * Whether the question could be asked, and whether it was answered.
 *
 * Five states rather than a `boolean` plus a `null`, because *not offered* and *cannot tell
 * whether it would be offered* are different facts and the picker renders them differently — the
 * Memory screen's four-empty-states doctrine, applied to a dropdown.
 */
export type AgentAvailabilityStatus =
  /** No Project chosen yet, so the question has no subject. Nothing was asked. */
  | 'unasked'
  | 'pending'
  /** This Backend does not serve the route at all — different from "no agents". */
  | 'route_missing'
  /** The read failed. Nothing can be offered and nothing can be explained. */
  | 'failed'
  | 'ready';

export interface AgentAvailabilityRead extends ProjectAgentAvailability {
  readonly status: AgentAvailabilityStatus;
  readonly error: ApiError | null;
}

/** A 404/501 means the route is missing, not that the request was wrong. */
export function isRouteMissing(error: unknown): boolean {
  const apiError = error as ApiError | null;
  if (apiError === null || apiError === undefined) return false;
  return apiError.status === 404 || apiError.status === 501;
}

/**
 * `GET /projects/{id}/available-agents` — bindability, asked rather than derived.
 *
 * `retry: false` for the reason the Agents screen uses it: on a Backend without the route this is
 * a 404, and retrying it three times only delays an honest answer.
 */
export function useAgentAvailability(
  projectId: string | null,
  enabled: boolean,
): AgentAvailabilityRead {
  const asked = enabled && projectId !== null;

  const query = useQuery<unknown, ApiError>({
    queryKey: queryKeys.projects.availableAgents(projectId ?? 'none'),
    enabled: asked,
    retry: false,
    staleTime: AGENTS_STALE_MS,
    queryFn: ({ signal }) =>
      apiGet<unknown>(endpoints.projects.availableAgents(projectId as string), { signal }),
  });

  const availability = useMemo(
    () => (query.data === undefined ? NO_AVAILABILITY : readProjectAgentAvailability(query.data)),
    [query.data],
  );

  const status: AgentAvailabilityStatus = !asked
    ? 'unasked'
    : query.isError
      ? isRouteMissing(query.error)
        ? 'route_missing'
        : 'failed'
      : query.isSuccess
        ? 'ready'
        : 'pending';

  return {
    ...availability,
    status,
    error: query.isError && !isRouteMissing(query.error) ? query.error : null,
  };
}

/**
 * Every Agent this instance has, for **naming** one — never for deciding what may be bound.
 *
 * Archived rows are included deliberately: a Session bound before its agent was retired still has
 * to render a name, because archival does not rewrite the sessions that ran as it.
 */
export function useAgentDirectory(enabled: boolean): {
  readonly agents: readonly AgentView[];
  readonly isPending: boolean;
} {
  const query = useQuery<readonly unknown[], ApiError>({
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

  return { agents: read.agents, isPending: enabled && query.isPending };
}

/**
 * `agentId` → Agent, for a **list** of Sessions.
 *
 * One request for the whole table rather than one per row: the Sessions list can hold fifty rows
 * bound to a handful of agents, and `useSessionAgent` per row would issue a request per *distinct*
 * agent on a screen whose job is to load fast.
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
  const directory = useAgentDirectory(enabled);

  const byId = useMemo(() => {
    const map = new Map<string, AgentView>();
    for (const agent of directory.agents) map.set(agent.id, agent);
    return map;
  }, [directory.agents]);

  const lookup = useMemo<AgentLookup>(() => (agentId: string) => byId.get(agentId) ?? null, [byId]);

  return { lookup, settled: !enabled || !directory.isPending };
}

/**
 * One Agent by id, for a Session that is already bound to one.
 *
 * Separate from the availability read on purpose: a Session may run as an **archived** agent (it
 * was bound before it was retired, and archival deliberately does not rewrite history), and it may
 * run as one scoped to a project the operator is not currently looking at. Deriving the name from
 * the bindable set would make exactly those two agents display as nothing at all.
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
