import { WORKFLOW_MODES } from '@mc/shared';
import {
  type Assert,
  arrayOf,
  booleanValue,
  type Covers,
  type ExactShape,
  enumSchema,
  inlineObject,
  integerValue,
  nullableEntityId,
  nullableString,
  objectSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import { repositorySchema } from '../repositories/response-schemas.js';
import type {
  DiscoveredRepository,
  DiscoveryReport,
  SkippedCandidate,
  SkipReason,
} from './discover.js';
import type { RootReport, RootStatus } from './discovery.js';

/**
 * `POST /api/v1/repositories/discover` — the discovery report.
 *
 * The route answers `200` with the report rather than §5.1's `202 { jobId }` because **the skip
 * reasons have nowhere else to live**: no table stores "this one points at GitLab". Publishing
 * them as a closed schema is what makes that deviation worth having — a client can render each
 * reason rather than guessing why a repository it expected did not appear.
 */

const SKIP_REASONS = [
  'already_registered',
  'not_a_git_repository',
  'no_remote',
  'remote_not_github',
  'remote_unreadable',
  'invalid_path',
] as const;
export type _SkipReasonsCover = Assert<Covers<SkipReason, typeof SKIP_REASONS>>;

const ROOT_STATUSES = [
  'scanned',
  'scanned_as_repository',
  'path_missing',
  'not_a_directory',
  'not_absolute',
  'unreadable',
  'truncated',
] as const;
export type _RootStatusesCover = Assert<Covers<RootStatus, typeof ROOT_STATUSES>>;

const discoverySkipSchema = objectSchema('DiscoverySkip', {
  localPath: stringValue,
  reason: enumSchema('DiscoverySkipReason', SKIP_REASONS),
  /** Why, in words. Never contains a remote URL — a remote URL can carry a credential. */
  detail: nullableString,
  /** Set only for `already_registered`. */
  repositoryId: nullableEntityId,
});
export type _DiscoverySkipShape = Assert<ExactShape<SkippedCandidate, typeof discoverySkipSchema>>;

const discoveryRootSchema = objectSchema('DiscoveryRoot', {
  path: stringValue,
  status: enumSchema('DiscoveryRootStatus', ROOT_STATUSES),
  /** Working trees found under this root, before classification. */
  found: integerValue,
  detail: nullableString,
});
export type _DiscoveryRootShape = Assert<ExactShape<RootReport, typeof discoveryRootSchema>>;

const discoveredRepositorySchema = objectSchema('DiscoveredRepository', {
  repository: repositorySchema,
  owner: stringValue,
  repo: stringValue,
});
export type _DiscoveredRepositoryShape = Assert<
  ExactShape<DiscoveredRepository, typeof discoveredRepositorySchema>
>;

export const discoveryReportSchema = objectSchema('DiscoveryReport', {
  scannedAt: timestampValue,
  /** A cap or the wall-clock deadline stopped the scan — say so, never imply completeness. */
  truncated: booleanValue,
  roots: arrayOf(discoveryRootSchema),
  registered: arrayOf(discoveredRepositorySchema),
  skipped: arrayOf(discoverySkipSchema),
  counts: inlineObject({
    workingTreesFound: integerValue,
    registered: integerValue,
    skipped: integerValue,
  }),
  /** The effective global Workflow Mode (PRD §4.3). Reported, never acted on (deviation D8). */
  workflowMode: enumSchema('GithubWorkflowMode', WORKFLOW_MODES),
  /** `read_only` in Phase 1 for both modes. */
  capability: stringEnum(['read_only']),
});
export type _DiscoveryReportShape = Assert<
  ExactShape<DiscoveryReport, typeof discoveryReportSchema>
>;
