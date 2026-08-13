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
  },
  repositories: {
    list: '/repositories',
    detail: (id: string) => `/repositories/${id}`,
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
