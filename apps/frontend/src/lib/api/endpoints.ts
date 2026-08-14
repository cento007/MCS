/**
 * Every REST path the SPA knows, in one file (TDS 05 §4: "endpoint paths live in one
 * `endpoints.ts` map so WS2 renames touch one file").
 *
 * Paths are relative to `/api/v1` — the client prefixes the base. Only Phase 1 routes the
 * Backend actually serves today are listed as callable; Phase 2+ paths are recorded here so
 * their feature slice does not invent a second spelling later.
 */
export const endpoints = {
  auth: {
    login: '/auth/login',
    logout: '/auth/logout',
    me: '/auth/me',
    password: '/auth/password',
    tokens: '/auth/tokens',
    token: (id: string) => `/auth/tokens/${id}`,
  },
  projects: {
    list: '/projects',
    detail: (id: string) => `/projects/${id}`,
    /**
     * Which agents a Session in this Project may be launched as, and which of them are on the
     * Project's team (PRD §5.7, `apps/backend/src/agents/teams/availability.ts`).
     *
     * It hangs off the Project because the question is the Project's — *who can work here?* — and
     * it is the read that makes a team mean something: without it a team is a named list nothing
     * consults.
     */
    availableAgents: (id: string) => `/projects/${id}/available-agents`,
  },
  repositories: {
    list: '/repositories',
    detail: (id: string) => `/repositories/${id}`,
    /**
     * The working-tree read model — current branch, uncommitted-file count, ahead/behind, or
     * an `unavailableReason` when the tree cannot be read (`apps/backend/src/repositories/`).
     *
     * ⚠ Not in TDS 04 §5.1; the Backend flags it as additive for the same reason the UI needs
     * it — §5.1 exposes `defaultBranch` and nothing else, so every surface that must state
     * what is *actually* checked out would otherwise have to guess or stay silent.
     */
    status: (id: string) => `/repositories/${id}/status`,
    /** §5.1 — scan the discovery roots configured in Settings → Integrations → GitHub. */
    discover: '/repositories/discover',
    /** §5.1 — refresh commits and pull requests from git + GitHub. `202 { jobId }`. */
    sync: (id: string) => `/repositories/${id}/sync`,
  },
  sessions: {
    list: '/sessions',
    detail: (id: string) => `/sessions/${id}`,
    messages: (id: string) => `/sessions/${id}/messages`,
    timeline: (id: string) => `/sessions/${id}/timeline`,
    commits: (id: string) => `/sessions/${id}/commits`,
    files: (id: string) => `/sessions/${id}/files`,
    prompts: (id: string) => `/sessions/${id}/prompts`,
    /** F5.1 lifecycle sub-actions (TDS 04 §6.3) — POST, never PATCH on `state`. */
    action: (id: string, action: SessionAction) => `/sessions/${id}/${action}`,
    /**
     * §6.7's two documents. They share the `POST /sessions/{id}/{verb}` grammar and nothing
     * else: neither performs an F7 transition, and both answer with a *document* inside the
     * F5.4 envelope rather than the updated Session. They are therefore **not** members of
     * `SESSION_ACTIONS` — `action()` would type-check a call that parses an export as a
     * Session, which is precisely the mistake worth making impossible.
     *
     * Both are `409 CONFLICT` while the Session is in `created`, with the state named in
     * `error.details.state`.
     */
    export: (id: string) => `/sessions/${id}/export`,
    contextPackage: (id: string) => `/sessions/${id}/context-package`,
  },
  settings: {
    all: '/settings',
    category: (category: string) => `/settings/${category}`,
    /** §7.3 — all integrations in one masked document; `integrations` is one DB category. */
    integrations: '/settings/integrations',
    integration: (integration: string) => `/settings/integrations/${integration}`,
    /**
     * §7.4, spelled `test-connection`.
     *
     * This replaces a `…/test` entry that predated the contract and was never called. The
     * shorter path would have 404'd against the route WS2 specified, which is the failure
     * mode this file exists to make impossible.
     */
    testConnection: (integration: string) =>
      `/settings/integrations/${integration}/test-connection`,
  },
  services: {
    health: '/services/health',
  },
  schedule: '/schedule',
  spend: '/spend',
  auditLogEntries: '/audit-log-entries',
  /** Phase 2 (TDS 04 §8–§11) — recorded, not yet called. */
  notifications: {
    list: '/notifications',
    detail: (id: string) => `/notifications/${id}`,
  },
  adrs: {
    list: '/adrs',
    detail: (id: string) => `/adrs/${id}`,
  },
  syncRuns: '/sync-runs',
  search: '/search',
  /**
   * Phase 3 semantic memory (TDS 04 §13.1, `apps/backend/src/memory/routes.ts`).
   *
   * `search` is a **POST** and that is not a REST slip: the query is natural-language prose up
   * to 2 000 characters plus a filter object, which is a body rather than a query string, and
   * the answer is not cacheable because the index moves underneath it.
   *
   * Two of §13.1's four reserved routes are deliberately absent from the Backend — `POST
   * /memory-items` and `DELETE /memory-items/{id}` — because every MemoryItem is a *projection*
   * of a row this database already holds. They are not listed here, so no screen can be written
   * against a route that will never exist.
   */
  memoryItems: {
    search: '/memory-items/search',
    /** `GET` reads the active or most recent run; `POST` triggers one (`202`). */
    backfill: '/memory-items/backfill',
    detail: (id: string) => `/memory-items/${id}`,
  },
  /**
   * Phase 4 agents (TDS 04 §13.2, PRD §5).
   *
   * The Agent CRUD routes the Agents screen calls, plus §13.2's `agent-teams` pair (PRD §5.7),
   * which slice 2 builds against.
   *
   * `POST /agents/{id}/assignments` and `POST /agents/{id}/executions` remain **deliberately
   * absent**, for the same reason two of §13.1's memory routes are: nothing in the SPA can execute
   * an agent, and a path listed here is a path a screen may be written against. Binding an agent
   * to a Session is not an assignment — it happens on the Session's own resource (`agentId` on
   * `POST /sessions` and `PATCH /sessions/{id}`), because the rule that governs it is a Session
   * lifecycle rule.
   */
  agents: {
    list: '/agents',
    detail: (id: string) => `/agents/${id}`,
  },
  /**
   * PRD §5.7 agent teams (TDS 04 §13.2).
   *
   * Two routes, and only two: `GET|POST /agent-teams` and `GET|PATCH /agent-teams/{id}`. There is
   * no `DELETE` here for the same reason there is none on `/agents` — a team is referenced by
   * whatever assigns it, and retirement is archival. No membership sub-route is listed, because
   * the shape of a member is still the Backend's decision and the screens do not edit one.
   */
  agentTeams: {
    list: '/agent-teams',
    detail: (id: string) => `/agent-teams/${id}`,
  },
} as const;

/**
 * The lifecycle sub-actions of TDS 04 §6.3 plus the §6.3.1 turn interrupt. `interrupt` is in
 * this list because it shares the URL grammar, NOT because it is a lifecycle action: it
 * performs no F7 transition and emits no `session.state_changed`.
 */
export const SESSION_ACTIONS = [
  'start',
  'pause',
  'resume',
  'end',
  'archive',
  'clone',
  'interrupt',
] as const;

export type SessionAction = (typeof SESSION_ACTIONS)[number];
