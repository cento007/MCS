import type { WorkingTreeStatus, WorkingTreeUnavailableReason } from './git.js';
import type { RepositoryRow } from './store.js';

/** DB row -> API resource, TDS 04 §5.1 field for field. */

export const REPOSITORY_VISIBILITIES = ['public', 'private', 'unknown'] as const;
export type RepositoryVisibility = (typeof REPOSITORY_VISIBILITIES)[number];

export const REPOSITORY_SYNC_STATUSES = ['ok', 'failed', 'never'] as const;
export type RepositorySyncStatus = (typeof REPOSITORY_SYNC_STATUSES)[number];

export interface RepositoryResource {
  readonly id: string;
  readonly projectId: string | null;
  readonly name: string;
  /** Absolute native path (F8.1 path rules). The launch modal shows this verbatim. */
  readonly localPath: string;
  readonly remoteUrl: string | null;
  readonly visibility: RepositoryVisibility;
  readonly defaultBranch: string;
  readonly lastSyncedAt: string | null;
  readonly syncStatus: RepositorySyncStatus;
  /**
   * ⚠ **Additive to TDS 04 §5.1 — flagged, not silently invented.** WS3 justifies the
   * `last_sync_error` column with a UI requirement the §5.1 resource cannot satisfy: "so the
   * Repositories view can explain a `failed` badge without opening the audit log" (TDS 03
   * §3.6, finding B8). The column exists, the reason for it is written down, and the contract
   * exposes no field carrying it. Serving `syncStatus: 'failed'` with no explanation would
   * implement the letter of §5.1 and defeat the point of B8.
   */
  readonly lastSyncError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeRepository(row: RepositoryRow): RepositoryResource {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    localPath: row.localPath,
    remoteUrl: row.remoteUrl,
    visibility: asVisibility(row.visibility),
    defaultBranch: row.defaultBranch,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    syncStatus: asSyncStatus(row.syncStatus),
    lastSyncError: row.lastSyncError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * `GET /api/v1/repositories/{id}/status` — a **bounded, computed** read model in the sense of
 * TDS 04 §1.2: fixed cardinality (one object), no pagination, no `meta`.
 *
 * Nothing here is persisted. Every field is true as of `checkedAt` and stale immediately after
 * — an operator can commit between the read and the render — so storing it would create a
 * second, wrong copy of a fact the working tree already owns.
 */
export interface RepositoryStatusReadModel {
  readonly repositoryId: string;
  readonly localPath: string;
  readonly isGitWorkingTree: boolean;
  readonly currentBranch: string | null;
  readonly detachedHead: boolean;
  readonly headSha: string | null;
  readonly uncommittedFiles: number | null;
  readonly ahead: number | null;
  readonly behind: number | null;
  /** `null` iff the tree was read. Otherwise why not — an answer, not an error (see `git.ts`). */
  readonly unavailableReason: WorkingTreeUnavailableReason | null;
  readonly detail: string | null;
  readonly checkedAt: string;
}

export function serializeRepositoryStatus(
  row: RepositoryRow,
  status: WorkingTreeStatus,
  checkedAt: Date,
): RepositoryStatusReadModel {
  return {
    repositoryId: row.id,
    localPath: row.localPath,
    isGitWorkingTree: status.isGitWorkingTree,
    currentBranch: status.currentBranch,
    detachedHead: status.detachedHead,
    headSha: status.headSha,
    uncommittedFiles: status.uncommittedFiles,
    ahead: status.ahead,
    behind: status.behind,
    unavailableReason: status.unavailableReason,
    detail: status.detail,
    checkedAt: checkedAt.toISOString(),
  };
}

function asVisibility(value: string): RepositoryVisibility {
  return (REPOSITORY_VISIBILITIES as readonly string[]).includes(value)
    ? (value as RepositoryVisibility)
    : 'unknown';
}

function asSyncStatus(value: string): RepositorySyncStatus {
  return (REPOSITORY_SYNC_STATUSES as readonly string[]).includes(value)
    ? (value as RepositorySyncStatus)
    : 'never';
}
