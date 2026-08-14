import {
  type Assert,
  booleanValue,
  type Covers,
  describe,
  type ExactShape,
  entityId,
  enumSchema,
  nullable,
  nullableEntityId,
  nullableInteger,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { WorkingTreeUnavailableReason } from './git.js';
import type { RepositoryResource, RepositoryStatusReadModel } from './serialize.js';
import { REPOSITORY_SYNC_STATUSES, REPOSITORY_VISIBILITIES } from './serialize.js';

/** The `Repository` response shapes (TDS 04 §5.1) plus the working-tree read model. */

export const repositorySchema = objectSchema('Repository', {
  id: entityId,
  projectId: nullableEntityId,
  name: stringValue,
  /** Absolute native path (F8.1). The launch modal shows this verbatim — never a nickname. */
  localPath: stringValue,
  remoteUrl: nullableString,
  visibility: enumSchema('RepositoryVisibility', REPOSITORY_VISIBILITIES),
  defaultBranch: stringValue,
  lastSyncedAt: nullableTimestamp,
  syncStatus: enumSchema('RepositorySyncStatus', REPOSITORY_SYNC_STATUSES),
  lastSyncError: describe(
    nullableString,
    'Why the last sync failed. Additive to TDS 04 5.1 and served so the Repositories view can explain a `failed` badge without sending the operator to the audit log.',
  ),
  createdAt: timestampValue,
  updatedAt: timestampValue,
});
export type _RepositoryShape = Assert<ExactShape<RepositoryResource, typeof repositorySchema>>;

/**
 * Why a working tree could not be read.
 *
 * These are **answers, not errors**: the route returns `200` with one of them set rather than
 * failing, because "the path was deleted" is a fact about the repository and not a fault in the
 * request. Every one of them must render as *unverifiable*, never as clean.
 */
const WORKING_TREE_UNAVAILABLE_REASONS = [
  'path_missing',
  'not_a_directory',
  'not_a_git_repository',
  'git_unavailable',
  'timed_out',
  'git_failed',
] as const;
export type _WorkingTreeReasonsCover = Assert<
  Covers<WorkingTreeUnavailableReason, typeof WORKING_TREE_UNAVAILABLE_REASONS>
>;

export const workingTreeUnavailableReasonSchema = enumSchema(
  'WorkingTreeUnavailableReason',
  WORKING_TREE_UNAVAILABLE_REASONS,
);

export const repositoryStatusSchema = objectSchema('RepositoryStatus', {
  repositoryId: entityId,
  localPath: stringValue,
  isGitWorkingTree: booleanValue,
  /** `null` when detached, unnamed, or unreadable. */
  currentBranch: nullableString,
  detachedHead: booleanValue,
  headSha: nullableString,
  uncommittedFiles: nullableInteger,
  ahead: nullableInteger,
  behind: nullableInteger,
  /** `null` iff the tree was read. */
  unavailableReason: describe(
    nullable(workingTreeUnavailableReasonSchema),
    'null iff the tree was read. Otherwise why not - an answer, not an error. Every value must render as *unverifiable*, never as clean.',
  ),
  /** git's own first line of complaint, truncated. Never invented by the server. */
  detail: nullableString,
  checkedAt: timestampValue,
});
export type _RepositoryStatusShape = Assert<
  ExactShape<RepositoryStatusReadModel, typeof repositoryStatusSchema>
>;
