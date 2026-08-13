import type { PullRequestRow } from './store.js';

/**
 * DB row -> the TDS 04 §5.3 `PullRequest` resource.
 *
 * Three column names are renamed on the way out, and that is the mapping TDS 03 §3.9 hands to
 * `packages/shared` ("the API field names left exactly as WS2 has them and the translation
 * living in" the serializer, findings N2/N3):
 *
 *   `author`      -> `authorLogin`
 *   `head_branch` -> `sourceBranch`
 *   `base_branch` -> `targetBranch`
 *
 * Nullability follows the **column**, not §5.3's type sketch: TDS 03 §3.8 makes `author`,
 * `head_branch`, `base_branch`, `url` and `opened_at` nullable, and `github/map.ts` will not
 * invent a value to fill one. A resource that promised `string` and served `""` would be a
 * worse lie than a documented `null`.
 */

/**
 * **GitHub truth (arbitration A3 / finding B4)** — four states, not the PRD's five lifecycle
 * words. A reviewed PR is still `open`; "rejected" is `closed` with no `mergedAt`. `draft` is
 * the fourth because GitHub can return it and the CHECK constraint stores it (TDS 03 §3.8),
 * and TDS 06 §5.3.2 renders all four verbatim.
 */
export const PULL_REQUEST_STATES = ['open', 'merged', 'closed', 'draft'] as const;
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

export interface PullRequestResource {
  readonly id: string;
  readonly repositoryId: string;
  /** GitHub's own PR number, unique per repository (`ux_pull_requests_repository_number`). */
  readonly number: number;
  readonly title: string;
  readonly url: string | null;
  readonly state: PullRequestState;
  readonly authorLogin: string | null;
  readonly sourceBranch: string | null;
  readonly targetBranch: string | null;
  readonly openedAt: string | null;
  /**
   * ⚠ **Additive to §5.3 — flagged, not silently invented.** TDS 03 §3.8 adds `reviewed_at`
   * precisely because the PRD's "Reviewed" is a fact with a time rather than a state, and A3
   * removed it from `state` on that basis. The column is written by the sync
   * (`github/map.ts::mapFirstReviewAt`) and, without this field, is unreadable — which is the
   * class of gap this whole module exists to close. Same treatment as `Repository.lastSyncError`
   * (§5.1): a column with a stated UI purpose gets a field, and the deviation is written down.
   */
  readonly reviewedAt: string | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * `GET /api/v1/pull-requests/{id}` — the resource plus the PR body.
 *
 * ⚠ **`description` is additive to §5.3 — flagged.** `pull_requests.description` is stored
 * (TDS 03 §3.8), is bounded at 20 000 characters by `github/map.ts`, and is rank-class `B` in
 * the Phase 2 search index (§4.6) — a search hit that cannot open the text it matched is not a
 * search result. It is on the **detail fetch only**, for the same reason `files[]` is on the
 * single-commit fetch (§5.2): fifty PR bodies in one page is a megabyte no list renders.
 */
export interface PullRequestDetailResource extends PullRequestResource {
  readonly description: string | null;
}

export function serializePullRequest(row: PullRequestRow): PullRequestResource {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    number: Number(row.number),
    title: row.title,
    url: row.url,
    state: asState(row.state),
    authorLogin: row.author,
    sourceBranch: row.headBranch,
    targetBranch: row.baseBranch,
    openedAt: row.openedAt?.toISOString() ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    mergedAt: row.mergedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializePullRequestDetail(row: PullRequestRow): PullRequestDetailResource {
  return { ...serializePullRequest(row), description: row.description };
}

/**
 * `ck_pull_requests_state` already restricts the column to the four values, so this can only
 * fire for a row written before that constraint existed. It reads as `open` rather than
 * throwing: a list of pull requests must not be 500-able by one unrecognised string, and `open`
 * is the state that keeps the row visible where an operator can see it and act.
 */
function asState(value: string): PullRequestState {
  return (PULL_REQUEST_STATES as readonly string[]).includes(value)
    ? (value as PullRequestState)
    : 'open';
}
