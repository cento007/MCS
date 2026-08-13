import type { CommitFile } from '@mc/shared';

/**
 * GitHub JSON -> the shapes `commits` / `pull_requests` / `repositories` actually store
 * (TDS 03 §3.6–§3.8). Pure and **tolerant**: every field is validated, every unexpected shape
 * degrades to a stated default, and nothing here throws.
 *
 * Tolerance is not laziness. A response body is untrusted input from a service that adds fields
 * continuously, and a single missing `commit.committer.date` must not be able to fail a whole
 * sync — much less 500 a request. Anything that cannot be mapped into a row the database will
 * accept is dropped and *counted*, so the sync reports "42 of 43" rather than pretending.
 *
 * The one thing that is NOT tolerant is `sha`: `ck_commits_sha` accepts 40 or 64 lower-case hex
 * characters and nothing else, so a commit whose sha fails that test is dropped here rather
 * than allowed to abort the insert of the 49 commits around it.
 */

export const REPOSITORY_VISIBILITIES = ['public', 'private', 'unknown'] as const;
export type RepositoryVisibility = (typeof REPOSITORY_VISIBILITIES)[number];

export const PULL_REQUEST_STATES = ['open', 'merged', 'closed', 'draft'] as const;
/**
 * **GitHub truth, not the PRD's lifecycle words** (arbitration A3 / TDS 03 §3.8). A reviewed PR
 * is still `open` on GitHub and "rejected" is `closed` with no `merged_at`; those words are
 * event names (§15.2 #17–#20), never stored states.
 */
export type PullRequestState = (typeof PULL_REQUEST_STATES)[number];

const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** `commits.message` and `pull_requests.title` are `text`, but a runaway body helps nobody. */
const MAX_MESSAGE_LENGTH = 20_000;
const MAX_TITLE_LENGTH = 1_000;
const MAX_DESCRIPTION_LENGTH = 20_000;
/** `ck_repositories_name_length` is 1..200; branch names are bounded for the same reason. */
const MAX_BRANCH_LENGTH = 255;
/** One commit with 5 000 changed files is a vendor drop, not a code change. */
const MAX_FILES_PER_COMMIT = 1_000;

// -------------------------------------------------------------------------------- repository

export interface GithubRepositoryMetadata {
  readonly fullName: string | null;
  readonly defaultBranch: string | null;
  readonly visibility: RepositoryVisibility;
  /** GitHub's own canonical browse URL. Credential-free by construction. */
  readonly htmlUrl: string | null;
  readonly archived: boolean;
}

export function mapRepository(raw: unknown): GithubRepositoryMetadata | null {
  const object = asObject(raw);
  if (object === null) return null;

  const isPrivate = object['private'];

  return {
    fullName: boundedString(object['full_name'], 200),
    defaultBranch: boundedString(object['default_branch'], MAX_BRANCH_LENGTH),
    // `private` is the field GitHub has always sent; the newer `visibility` string adds
    // `internal` (Enterprise), which for a self-hosted single-operator install is not
    // distinguishable from private and must never read as public.
    visibility: typeof isPrivate === 'boolean' ? (isPrivate ? 'private' : 'public') : 'unknown',
    htmlUrl: boundedString(object['html_url'], 2_000),
    archived: object['archived'] === true,
  };
}

// ------------------------------------------------------------------------------------ commit

export interface GithubCommitSummary {
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  /**
   * `commit.committer.date` — **when the commit object was created**, not when it was authored.
   * A rebase or an amend rewrites the committer date and leaves the author date alone, so the
   * committer date is the one that answers "was this made while the Session was running",
   * which is the only question `attribution.ts` asks of it. Falls back to the author date when
   * GitHub omits it.
   */
  readonly committedAt: Date;
}

export interface GithubCommitDetail extends GithubCommitSummary {
  readonly files: CommitFile[];
}

/** One element of `GET /repos/{o}/{r}/commits`. `null` when it cannot become a valid row. */
export function mapCommitSummary(raw: unknown): GithubCommitSummary | null {
  const object = asObject(raw);
  if (object === null) return null;

  const sha = typeof object['sha'] === 'string' ? object['sha'].toLowerCase() : null;
  if (sha === null || !SHA_PATTERN.test(sha)) return null;

  const commit = asObject(object['commit']);
  const committer = asObject(commit?.['committer']);
  const author = asObject(commit?.['author']);

  const committedAt = asDate(committer?.['date']) ?? asDate(author?.['date']);
  if (committedAt === null) return null;

  // `commits.author_name` is NOT NULL. Prefer the git identity (what actually made the commit),
  // fall back to the GitHub login, and only then to a stated placeholder — a dropped commit
  // would be worse than a commit whose author we could not name.
  const authorName =
    boundedString(author?.['name'], 300) ??
    boundedString(asObject(object['author'])?.['login'], 300) ??
    'unknown';

  return {
    sha,
    message: boundedString(commit?.['message'], MAX_MESSAGE_LENGTH) ?? '',
    authorName,
    authorEmail: boundedString(author?.['email'], 320),
    committedAt,
  };
}

/** `GET /repos/{o}/{r}/commits/{sha}` — the same fields plus `files[]`. */
export function mapCommitDetail(raw: unknown): GithubCommitDetail | null {
  const summary = mapCommitSummary(raw);
  if (summary === null) return null;
  return { ...summary, files: mapCommitFiles(asObject(raw)?.['files']) };
}

/**
 * `files[]` -> `commits.files` (TDS 03 §3.7).
 *
 * GitHub's `status` vocabulary is wider than §5.2's (`added | modified | deleted | renamed`):
 * `removed` is §5.2's `deleted`, and `copied` / `changed` / `unchanged` have no §5.2 spelling.
 * They are folded to `modified` rather than passed through, because §6.10.2's Files panel
 * renders this field and an unrecognised status there is a blank badge.
 */
export function mapCommitFiles(raw: unknown): CommitFile[] {
  if (!Array.isArray(raw)) return [];

  const files: CommitFile[] = [];
  for (const entry of raw.slice(0, MAX_FILES_PER_COMMIT)) {
    const object = asObject(entry);
    const path = boundedString(object?.['filename'], 4_096);
    if (path === null) continue;

    files.push({
      path,
      status: mapFileStatus(object?.['status']),
      additions: nonNegativeInteger(object?.['additions']),
      deletions: nonNegativeInteger(object?.['deletions']),
    });
  }
  return files;
}

function mapFileStatus(raw: unknown): string {
  switch (raw) {
    case 'added':
      return 'added';
    case 'removed':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

// ------------------------------------------------------------------------------ pull request

export interface GithubPullRequest {
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: PullRequestState;
  readonly author: string | null;
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
  readonly url: string | null;
  readonly openedAt: Date | null;
  readonly mergedAt: Date | null;
  readonly closedAt: Date | null;
  /** GitHub's own `updated_at`. Used to decide whether a PR is worth re-reading; never stored. */
  readonly updatedAt: Date | null;
}

export function mapPullRequest(raw: unknown): GithubPullRequest | null {
  const object = asObject(raw);
  if (object === null) return null;

  const number = object['number'];
  // `ck_pull_requests_number` requires > 0.
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number <= 0) return null;

  const mergedAt = asDate(object['merged_at']);
  const closedAt = asDate(object['closed_at']);

  return {
    number,
    title: boundedString(object['title'], MAX_TITLE_LENGTH) ?? `#${String(number)}`,
    description: boundedString(object['body'], MAX_DESCRIPTION_LENGTH),
    state: mapPullRequestState(object['state'], object['draft'] === true, mergedAt),
    author: boundedString(asObject(object['user'])?.['login'], 300),
    headBranch: boundedString(asObject(object['head'])?.['ref'], MAX_BRANCH_LENGTH),
    baseBranch: boundedString(asObject(object['base'])?.['ref'], MAX_BRANCH_LENGTH),
    url: boundedString(object['html_url'], 2_000),
    openedAt: asDate(object['created_at']),
    mergedAt,
    closedAt,
    updatedAt: asDate(object['updated_at']),
  };
}

/**
 * GitHub's `state` is only ever `open` or `closed`; `merged` and `draft` are separate flags.
 * The precedence below is the one GitHub's own UI uses:
 *
 *   merged (`merged_at` set) > closed (`state: 'closed'`) > draft (`draft: true`) > open
 *
 * A merged PR is `state: 'closed'` **and** has `merged_at`; checking `merged_at` first is what
 * keeps a merge from being recorded as a rejection. A draft that is closed is closed, not draft.
 */
export function mapPullRequestState(
  state: unknown,
  draft: boolean,
  mergedAt: Date | null,
): PullRequestState {
  if (mergedAt !== null) return 'merged';
  if (state === 'closed') return 'closed';
  return draft ? 'draft' : 'open';
}

/**
 * The first *submitted* review on a PR -> `pull_requests.reviewed_at` (TDS 03 §3.8: "First
 * review submitted — the PRD 'Reviewed' lifecycle fact, not a state").
 *
 * `PENDING` reviews are excluded: they are drafts visible only to their author and have not
 * been submitted at all. `COMMENTED` counts — a reviewer who left comments has reviewed.
 */
export function mapFirstReviewAt(raw: unknown): Date | null {
  if (!Array.isArray(raw)) return null;

  let earliest: Date | null = null;
  for (const entry of raw) {
    const object = asObject(entry);
    if (object === null) continue;
    if (object['state'] === 'PENDING') continue;

    const submittedAt = asDate(object['submitted_at']);
    if (submittedAt === null) continue;
    if (earliest === null || submittedAt.getTime() < earliest.getTime()) earliest = submittedAt;
  }
  return earliest;
}

// ------------------------------------------------------------------------------------ shared

export function asObject(raw: unknown): Record<string, unknown> | null {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function asArray(raw: unknown): readonly unknown[] {
  return Array.isArray(raw) ? raw : [];
}

function boundedString(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed.slice(0, max);
}

function asDate(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function nonNegativeInteger(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}
