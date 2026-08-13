/**
 * Commit -> Session attribution (`commits.session_id`, TDS 03 §3.7; consumed by §6.10.1's
 * Commits panel and §6.10.2's Files panel). Pure — no clock, no I/O — so every branch of the
 * rule below is a unit test with no database.
 *
 * ## The rule, stated exactly
 *
 * A commit is attributed to Session `S` **if and only if all five hold**:
 *
 *  1. `S.repository_id` equals the commit's repository. A Session that declared no Repository
 *     is not a candidate at all.
 *  2. `S.branch` and the commit's branch are both non-null and **equal, case-sensitively**.
 *     Git refs are case-sensitive; folding them would attribute a commit on `Feature/x` to a
 *     Session on `feature/x`, which are two different branches.
 *  3. `S.started_at` is set — a Session that never launched cannot have produced anything.
 *  4. `commit.committed_at` falls within `[S.started_at, S.endedAt]`, inclusive, where
 *     `endedAt` is `completed_at ?? archived_at ?? now` (a still-running Session's window is
 *     open-ended). **No skew tolerance is applied**: a commit two seconds after a Session ended
 *     is exactly as likely to be the operator's own as the Session's, and there is no evidence
 *     that separates them.
 *  5. **Exactly one** Session satisfies 1–4. Two Sessions running concurrently on the same
 *     branch of the same repository are indistinguishable from a commit's point of view, so
 *     the commit is attributed to neither.
 *
 * ## What is deliberately *not* used
 *
 * - **Author identity.** Claude Code commits with the operator's own git identity, so
 *   `author_email` is the same for a Session's commits and for the operator's. Matching on it
 *   would attribute every commit the operator made by hand to whichever Session was open.
 * - **Working-directory containment.** A Session's `working_dir` is frequently the repository
 *   root, so it discriminates nothing.
 * - **Commit message conventions** (`Co-Authored-By`, trailers). They are a *convention*, not a
 *   fact: they are configurable, frequently absent, and trivially present on a commit the
 *   Session did not make (a cherry-pick, a rebase, a squash of somebody else's work).
 *
 * ## Why a null is the right answer when in doubt
 *
 * The Commits panel is evidence. A commit shown under the wrong Session is a false statement
 * about what an AI agent did to a repository, and there is no visible signal that it is wrong;
 * a commit shown under no Session is merely incomplete, and the Repository's own commit list
 * still has it. **`attributeCommit` therefore declines by default and attributes only on
 * unambiguous evidence** — and `github/store.ts` never rewrites an existing `session_id`, so a
 * later sync cannot turn a decline into a claim.
 *
 * ## The honest limits of this rule in Phase 1
 *
 * The commit's branch is *the branch the poller asked GitHub for* — the repository's default
 * branch (see `sync.ts`). GitHub's commit API does not report which branch a commit was
 * originally made on, and once a feature branch is squash-merged the original commits do not
 * appear on the default branch at all. So in practice this rule attributes commits for Sessions
 * that worked **directly on the default branch**, and declines for Sessions that worked on a
 * feature branch. That is a real limitation and it is stated rather than papered over; the
 * alternative — attributing merged work to whichever Session was open when the merge landed —
 * is the exact class of wrong claim this module exists to avoid.
 */

export interface AttributionCandidate {
  readonly sessionId: string;
  readonly repositoryId: string | null;
  readonly branch: string | null;
  readonly startedAt: Date | null;
  /** `completed_at ?? archived_at`; `null` for a Session that is still running. */
  readonly endedAt: Date | null;
}

export interface AttributableCommit {
  readonly repositoryId: string;
  /** The branch the commit was observed on; `null` when unknown. */
  readonly branch: string | null;
  readonly committedAt: Date;
}

export type AttributionDeclineReason =
  /** The commit has no branch, so rule 2 cannot be evaluated. */
  | 'commit_branch_unknown'
  /** No Session names this repository *and* this branch *and* covers this instant. */
  | 'no_candidate'
  /** More than one Session does, and nothing distinguishes them. */
  | 'ambiguous';

export type AttributionOutcome =
  | { readonly decision: 'attributed'; readonly sessionId: string }
  | { readonly decision: 'declined'; readonly reason: AttributionDeclineReason };

/**
 * Apply the rule above.
 *
 * `now` is a parameter rather than a `Date.now()` call so a running Session's open-ended window
 * is deterministic in tests, and so the whole module stays pure.
 */
export function attributeCommit(
  commit: AttributableCommit,
  candidates: readonly AttributionCandidate[],
  now: Date,
): AttributionOutcome {
  if (commit.branch === null || commit.branch.length === 0) {
    return { decision: 'declined', reason: 'commit_branch_unknown' };
  }

  const committedAt = commit.committedAt.getTime();
  const matches: string[] = [];

  for (const candidate of candidates) {
    if (candidate.repositoryId !== commit.repositoryId) continue;
    if (candidate.branch === null || candidate.branch !== commit.branch) continue;
    if (candidate.startedAt === null) continue;
    if (committedAt < candidate.startedAt.getTime()) continue;

    const endedAt = candidate.endedAt?.getTime() ?? now.getTime();
    if (committedAt > endedAt) continue;

    matches.push(candidate.sessionId);
    // Two is all the information the decision needs; a third changes nothing.
    if (matches.length > 1) break;
  }

  if (matches.length === 0) return { decision: 'declined', reason: 'no_candidate' };
  if (matches.length > 1) return { decision: 'declined', reason: 'ambiguous' };

  const sessionId = matches[0];
  /* c8 ignore next */
  if (sessionId === undefined) return { decision: 'declined', reason: 'no_candidate' };
  return { decision: 'attributed', sessionId };
}
