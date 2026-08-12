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
  },
  repositories: {
    root: () => ['repositories'] as const,
    list: (filters: ListFilters = {}) => ['repositories', 'list', filters] as const,
    detail: (id: string) => ['repositories', id] as const,
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
  },
  adrs: {
    root: () => ['adrs'] as const,
    detail: (id: string) => ['adrs', id] as const,
  },
  syncRuns: {
    root: () => ['sync-runs'] as const,
  },
} as const;

/** A query key as the invalidation machinery passes it around. */
export type QueryKey = readonly unknown[];
