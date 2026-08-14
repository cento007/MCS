/**
 * Typed query keys (TDS 05 §3): "Query-key convention mirrors REST paths (F5.2)".
 *
 * The shape is deliberately hierarchical so that a prefix invalidation does the right
 * thing without an explicit list — invalidating `['sessions']` reaches every list page,
 * every detail, and every nested panel query for every Session, which is exactly what the
 * §5.3 event table asks for.
 *
 * One divergence from a naive path mirror, and it is load-bearing: list queries are keyed
 * `['sessions', 'list', filters]` rather than `['sessions', filters]`, because the latter
 * would occupy the same slot as `['sessions', id]` and two different resources sharing a
 * cache key is a bug that only shows up under load. `'list'` is not a valid UUIDv7, so the
 * two namespaces cannot collide.
 */

export interface SessionListFilters {
  readonly projectId?: string | undefined;
  readonly state?: string | undefined;
  readonly sessionType?: string | undefined;
  readonly repositoryId?: string | undefined;
  readonly order?: 'asc' | 'desc' | undefined;
  readonly limit?: number | undefined;
}

export interface ListFilters {
  readonly [key: string]: string | number | boolean | undefined;
}

export const queryKeys = {
  auth: {
    me: () => ['auth', 'me'] as const,
    tokens: () => ['auth', 'tokens'] as const,
  },
  sessions: {
    root: () => ['sessions'] as const,
    list: (filters: SessionListFilters = {}) => ['sessions', 'list', filters] as const,
    /**
     * The command palette's flat snapshot (§9.4).
     *
     * It cannot share `list()`'s slot even with identical filters: the list screen stores
     * `InfiniteData` (`{ pages, pageParams }`) there and the palette stores a plain array, and
     * TanStack Query hashes keys structurally — so `list({ limit: 50, order: 'desc' })` from
     * the palette and from an unfiltered list screen are the *same* key with two incompatible
     * shapes. That collision crashed the palette on `Ctrl+K` the moment both existed; it is
     * exactly the failure the note at the top of this file warns about, one level deeper.
     * Still under the `['sessions']` prefix, so §5.3's channel invalidation reaches it.
     */
    palette: () => ['sessions', 'palette'] as const,
    detail: (id: string) => ['sessions', id] as const,
    messages: (id: string) => ['sessions', id, 'messages'] as const,
    timeline: (id: string) => ['sessions', id, 'timeline'] as const,
    commits: (id: string) => ['sessions', id, 'commits'] as const,
    files: (id: string) => ['sessions', id, 'files'] as const,
  },
  projects: {
    root: () => ['projects'] as const,
    list: (filters: ListFilters = {}) => ['projects', 'list', filters] as const,
    detail: (id: string) => ['projects', id] as const,
    /**
     * `GET /projects/{id}/available-agents`.
     *
     * Nested under the Project's detail slot, not under `['agents']`, because it is a *Project*
     * read model. `agent.assigned` names a `projectId` and invalidates this slot specifically —
     * routing it through `['agents']` instead would refetch every agent list on every assignment,
     * and still not reach this key.
     */
    /**
     * Every availability answer for one Project, whatever Session it was asked about.
     *
     * **This is what invalidation must target.** TanStack matches by prefix, so this reaches both
     * the create-time entry and every per-Session one; targeting a single entry would refresh the
     * launch modal on `agent.assigned` and leave the bind surface serving a roster the operator
     * has just changed.
     */
    availableAgentsRoot: (id: string) => ['projects', id, 'available-agents'] as const,
    /**
     * `sessionId` is part of the key, not a detail of the request: asked about a Session, the
     * answer differs — a `session`-scoped agent becomes offerable, and `session_not_yet` becomes
     * `session_elsewhere`. Sharing one entry would let the create-time answer be served to the
     * bind surface, which is exactly the refusal that surface exists to lift.
     */
    availableAgents: (id: string, sessionId?: string) =>
      ['projects', id, 'available-agents', sessionId ?? null] as const,
  },
  repositories: {
    root: () => ['repositories'] as const,
    list: (filters: ListFilters = {}) => ['repositories', 'list', filters] as const,
    detail: (id: string) => ['repositories', id] as const,
    /**
     * The working-tree read model. Nested under the detail slot so `repository.synced` and the
     * `repositories` channel reach it — a sync can move HEAD, which is exactly the fact this
     * key holds.
     */
    status: (id: string) => ['repositories', id, 'status'] as const,
  },
  commits: {
    root: () => ['commits'] as const,
  },
  pullRequests: {
    root: () => ['pull-requests'] as const,
  },
  settings: {
    root: () => ['settings'] as const,
    category: (category: string) => ['settings', category] as const,
    /**
     * Deliberately identical to `category('integrations')`: the API keeps every integration
     * in one document under one DB category, and `setting.updated` carries that category name
     * — so one slot is correct and two would leave the event invalidating only half of them.
     */
    integrations: () => ['settings', 'integrations'] as const,
    /** Nested under the integrations slot, so a category-level invalidation reaches it. */
    integration: (integration: string) => ['settings', 'integrations', integration] as const,
  },
  services: {
    health: () => ['services', 'health'] as const,
  },
  schedule: () => ['schedule'] as const,
  spend: () => ['spend'] as const,
  auditLogEntries: {
    root: () => ['audit-log-entries'] as const,
  },
  notifications: {
    root: () => ['notifications'] as const,
    /**
     * Under the `['notifications']` prefix, so the always-on `notifications` channel
     * invalidation (§5.3) reaches every filtered list without naming them.
     */
    list: (filters: ListFilters = {}) => ['notifications', 'list', filters] as const,
  },
  adrs: {
    root: () => ['adrs'] as const,
    detail: (id: string) => ['adrs', id] as const,
  },
  syncRuns: {
    root: () => ['sync-runs'] as const,
  },
  /**
   * Phase 3 semantic memory (TDS 04 §13.1).
   *
   * `search` is keyed by the whole request object because that IS the identity of the answer:
   * the same prose under a different scope is a different question, and TanStack Query hashes
   * the key structurally so the object works as-is.
   *
   * **`backfill` deliberately does not sit under a prefix that memory events invalidate wholesale.**
   * A `memory.item_stored` fires once per indexed source, and invalidating `['memory-items']`
   * root on each one would re-POST the operator's query — an embedding call and a vector search
   * per event, up to hundreds during a backfill. `lib/ws/invalidation.ts` therefore targets this
   * slot specifically and leaves cached searches alone; the screen tells the operator the index
   * moved and offers to run the search again, rather than doing it behind their back.
   */
  memoryItems: {
    root: () => ['memory-items'] as const,
    search: (request: object) => ['memory-items', 'search', request] as const,
    backfill: () => ['memory-items', 'backfill'] as const,
    detail: (id: string) => ['memory-items', id] as const,
  },
  /**
   * Phase 4 agents (TDS 04 §13.2).
   *
   * The ordinary hierarchy — unlike `memoryItems`, nothing here is expensive to refetch, so a
   * prefix invalidation on `['agents']` is exactly the right blunt instrument when an
   * `agent.created` / `agent.updated` event arrives on the `agents` channel.
   */
  agents: {
    root: () => ['agents'] as const,
    list: (filters: ListFilters = {}) => ['agents', 'list', filters] as const,
    detail: (id: string) => ['agents', id] as const,
  },
  /**
   * PRD §5.7 agent teams.
   *
   * A **sibling** of `agents`, not a child, even though the screens share a tab bar: the `agents`
   * WebSocket channel invalidates `['agents']` wholesale on `agent.created`/`agent.updated`, and
   * nesting teams under that prefix would refetch every team list on every agent edit. A team's
   * membership can reference an agent, but the team document does not change when the agent does.
   */
  agentTeams: {
    root: () => ['agent-teams'] as const,
    list: (filters: ListFilters = {}) => ['agent-teams', 'list', filters] as const,
    detail: (id: string) => ['agent-teams', id] as const,
  },
  /**
   * PRD §5.6 workflows, and the runs of them.
   *
   * **Two roots, not one**, and the split is the same argument `agentTeams` makes against nesting
   * under `agents`: a workflow *definition* changes when a person edits it — rarely — while a
   * *run* changes every time a step advances, which on a four-step chain is a dozen invalidations
   * inside an hour. Nesting runs under `['agent-workflows']` would refetch every definition and
   * every list on every step transition, and the definition did not move.
   *
   * The run list is keyed by workflow id because that is the only way it is ever read (a
   * workflow's own history), and `'list'` keeps it out of `detail`'s namespace for the reason at
   * the top of this file.
   */
  agentWorkflows: {
    root: () => ['agent-workflows'] as const,
    list: (filters: ListFilters = {}) => ['agent-workflows', 'list', filters] as const,
    detail: (id: string) => ['agent-workflows', id] as const,
    /**
     * `GET /agent-workflows/{id}/cost-estimate`.
     *
     * Nested under the workflow's detail slot because that is what it is derived from — editing the
     * chain changes it — and because `agent_workflow.updated` should therefore invalidate it along
     * with the definition, which a prefix invalidation on `['agent-workflows', id]` does for free.
     */
    costEstimate: (id: string) => ['agent-workflows', id, 'cost-estimate'] as const,
  },
  agentWorkflowRuns: {
    root: () => ['agent-workflow-runs'] as const,
    list: (filters: ListFilters = {}) => ['agent-workflow-runs', 'list', filters] as const,
    detail: (id: string) => ['agent-workflow-runs', id] as const,
  },
} as const;

/** A query key as the invalidation machinery passes it around. */
export type QueryKey = readonly unknown[];
