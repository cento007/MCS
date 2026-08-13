import type { RepositoryStatus, WorkingTreeUnavailableReason } from '../../lib/api/index.js';

/**
 * How a working tree is described on screen (TDS 04 §5.1 status read model, TDS 06 §5.3.2).
 *
 * **The rule this file exists to enforce: an unreadable tree is never rendered as a clean one.**
 * `GET /repositories/{id}/status` answers `200` with an `unavailableReason` when it cannot read
 * the tree — a deliberate design, because "the directory was deleted" is a fact about the
 * repository rather than a fault in the request. That makes it very easy for a UI to treat the
 * absence of a dirty-file count as "nothing uncommitted", which is the one reading that is
 * actively dangerous: the Launch modal already treats an unverifiable tree as a branch change
 * requiring acknowledgement (TDS 06 §5.4.1 / WC11), and this screen must be equally honest.
 *
 * Pure functions of the read model, so every reason is testable without a DOM or a server.
 */

export type WorkingTreeKind = 'clean' | 'dirty' | 'unverifiable';

export interface WorkingTreeSummary {
  readonly kind: WorkingTreeKind;
  /** Branch, or the honest substitute when there isn't one. Rendered mono. */
  readonly branchLabel: string;
  /** One short phrase: `clean`, `3 uncommitted files`, `cannot verify`. */
  readonly headline: string;
  /** Why it cannot be verified, or the ahead/behind detail. `null` when there is nothing to add. */
  readonly detail: string | null;
  /** `↑2 ↓1`, or `null` when there is no upstream or no readable tree. */
  readonly divergence: string | null;
}

/**
 * One sentence per reason, each naming something the operator can actually do something about.
 * Never "invalid" and never a bare error code — these mirror the Backend's own registration
 * messages so the same condition reads the same way whether it is met on registration or on a
 * later status read.
 */
export function unavailableSentence(reason: WorkingTreeUnavailableReason): string {
  switch (reason) {
    case 'path_missing':
      return 'the path no longer exists on the Mission Control host';
    case 'not_a_directory':
      return 'the path is not a directory';
    case 'not_a_git_repository':
      return 'the directory is no longer a git working tree';
    case 'git_unavailable':
      return 'git could not be run on the Mission Control host';
    case 'timed_out':
      return 'git did not answer in time';
    case 'git_failed':
      return 'git could not read the working tree';
  }
}

/**
 * `null` means the status has not been read yet **or** the read itself failed — both of which
 * are "cannot verify", never "clean". A caller that has a pending query should render a
 * skeleton rather than calling this, but the total function is what keeps a forgotten branch
 * from silently rendering as safe.
 */
export function describeWorkingTree(
  status: RepositoryStatus | null | undefined,
): WorkingTreeSummary {
  if (status === null || status === undefined) {
    return {
      kind: 'unverifiable',
      branchLabel: '—',
      headline: 'cannot verify',
      detail: 'Mission Control has not read this working tree.',
      divergence: null,
    };
  }

  if (status.unavailableReason !== null) {
    const because = unavailableSentence(status.unavailableReason);
    return {
      kind: 'unverifiable',
      branchLabel: '—',
      headline: 'cannot verify',
      detail:
        status.detail === null
          ? `Mission Control cannot read this working tree — ${because}.`
          : `Mission Control cannot read this working tree — ${because}. git said: ${status.detail}`,
      divergence: null,
    };
  }

  const branchLabel = status.detachedHead
    ? 'detached HEAD'
    : (status.currentBranch ?? 'unnamed branch');

  const uncommitted = status.uncommittedFiles;
  if (uncommitted === null) {
    // A tree the server called readable but could not count is still not a clean tree.
    return {
      kind: 'unverifiable',
      branchLabel,
      headline: 'cannot verify',
      detail: 'git reported no file count for this working tree.',
      divergence: divergenceOf(status),
    };
  }

  return {
    kind: uncommitted === 0 ? 'clean' : 'dirty',
    branchLabel,
    headline:
      uncommitted === 0
        ? 'clean'
        : `${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'}`,
    detail:
      status.headSha === null && !status.detachedHead ? 'no commits on this branch yet' : null,
    divergence: divergenceOf(status),
  };
}

/**
 * `↑2 ↓1` against the upstream branch. `null` when the branch has no upstream — which is a real,
 * common state (a freshly-created local branch) and must not read as "in sync with the remote".
 */
function divergenceOf(status: RepositoryStatus): string | null {
  if (status.ahead === null || status.behind === null) return null;
  if (status.ahead === 0 && status.behind === 0) return 'up to date with upstream';
  return `↑${status.ahead} ↓${status.behind}`;
}

/** Colour token for the summary. `unverifiable` is a warning, not a neutral. */
export function workingTreeColorVar(kind: WorkingTreeKind): string {
  switch (kind) {
    case 'clean':
      return '--color-success';
    case 'dirty':
      return '--color-warning';
    case 'unverifiable':
      // Amber, not muted grey: an unverifiable tree is a condition the operator must weigh
      // before launching a session into it, not a missing optional field.
      return '--color-warning';
  }
}
