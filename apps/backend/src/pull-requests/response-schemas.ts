import {
  type Assert,
  type ExactShape,
  entityId,
  enumSchema,
  integerValue,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { PullRequestDetailResource, PullRequestResource } from './serialize.js';
import { PULL_REQUEST_STATES } from './serialize.js';

/**
 * The `PullRequest` response shapes (TDS 04 §5.3).
 *
 * `state` is **GitHub truth** (arbitration A3) — four values, not the PRD's five lifecycle words.
 * A reviewed PR is still `open`; "rejected" is `closed` with no `mergedAt`.
 */
export const pullRequestSchema = objectSchema('PullRequest', {
  id: entityId,
  repositoryId: entityId,
  /** GitHub's own PR number, unique per repository. */
  number: integerValue,
  title: stringValue,
  url: nullableString,
  state: enumSchema('PullRequestState', PULL_REQUEST_STATES),
  authorLogin: nullableString,
  sourceBranch: nullableString,
  targetBranch: nullableString,
  openedAt: nullableTimestamp,
  /** Additive to §5.3 — "Reviewed" is a fact with a time rather than a state (`serialize.ts`). */
  reviewedAt: nullableTimestamp,
  mergedAt: nullableTimestamp,
  closedAt: nullableTimestamp,
  createdAt: timestampValue,
  updatedAt: timestampValue,
});
export type _PullRequestShape = Assert<ExactShape<PullRequestResource, typeof pullRequestSchema>>;

/** The detail fetch adds the body; fifty PR bodies in one page is a megabyte no list renders. */
export const pullRequestDetailSchema = objectSchema('PullRequestDetail', {
  ...pullRequestSchema.properties,
  description: nullableString,
});
export type _PullRequestDetailShape = Assert<
  ExactShape<PullRequestDetailResource, typeof pullRequestDetailSchema>
>;
