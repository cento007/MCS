import { type CommitFile, type Db, type DbTransaction, newId, schema } from '@mc/shared';
import { and, asc, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import type { AttributionCandidate } from './attribution.js';
import type { PullRequestState } from './map.js';

/**
 * All `commits` and `pull_requests` access, in one module (TDS 03 §3.7–§3.8).
 *
 * `github/` is the only writer of these two tables in Phase 1, which is why the writes live
 * here rather than in `repositories/store.ts` — that module owns the `repositories` row and its
 * operator-facing fields, and a sync must not be able to reach into them except through
 * `updateRepositorySync`.
 *
 * **Idempotence is enforced by the database, not by a read-then-write.** `insertNewCommits`
 * inserts with `ON CONFLICT (repository_id, sha) DO NOTHING … RETURNING`, so the rows it
 * returns are exactly the rows that did not exist a moment ago — even if two syncs of the same
 * repository ever raced. That returned set, and nothing else, is what emits `commit.recorded`.
 * A "check then insert" would emit the event for a commit another transaction had already
 * recorded, and `commit.recorded` on every poll is precisely what would make the Dashboard
 * useless.
 */

export type CommitRow = typeof schema.commits.$inferSelect;
export type PullRequestRow = typeof schema.pullRequests.$inferSelect;
export type DbLike = Db | DbTransaction;

export interface InsertCommitInput {
  readonly repositoryId: string;
  readonly sessionId: string | null;
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  readonly message: string;
  readonly branch: string | null;
  readonly files: CommitFile[];
  readonly committedAt: Date;
}

/**
 * Insert the commits that are new, and return only those.
 *
 * A conflict is not an error here: re-polling a branch necessarily re-reads commits already
 * stored, and that is the steady state rather than the exception. `session_id` is written once,
 * at insert; nothing in this module ever updates it (see `attribution.ts` for why a later sync
 * must not be able to turn a declined attribution into a claimed one).
 */
export async function insertNewCommits(
  tx: DbTransaction,
  inputs: readonly InsertCommitInput[],
): Promise<CommitRow[]> {
  if (inputs.length === 0) return [];

  return tx
    .insert(schema.commits)
    .values(
      inputs.map((input) => ({
        id: newId(),
        repositoryId: input.repositoryId,
        sessionId: input.sessionId,
        sha: input.sha,
        authorName: input.authorName,
        authorEmail: input.authorEmail,
        message: input.message,
        branch: input.branch,
        files: input.files,
        committedAt: input.committedAt,
      })),
    )
    .onConflictDoNothing({
      target: [schema.commits.repositoryId, schema.commits.sha],
    })
    .returning();
}

export interface InsertDiscoveredRepositoryInput {
  readonly name: string;
  readonly localPath: string;
  readonly remoteUrl: string;
  readonly remoteName: string;
}

/**
 * Register the working trees discovery found that are not registered yet, and return only the
 * rows that were actually created.
 *
 * Same shape of guarantee as `insertNewCommits`, and for the same reason: re-running discovery
 * is the normal thing to do, so "already registered" is the steady state rather than an error.
 * `ux_repositories_local_path` — not a prior `SELECT` — is what decides, so two discovery runs
 * racing cannot produce two rows for one directory, and only genuinely new rows emit
 * `repository.discovered`.
 *
 * `default_branch`, `visibility` and `sync_status` are left at their table defaults (`main`,
 * `unknown`, `never`). Discovery makes no GitHub API call (see `discover.ts`), so it does not
 * know the real default branch; the first sync reads it from GitHub, which is the authority.
 */
export async function insertDiscoveredRepositories(
  tx: DbTransaction,
  inputs: readonly InsertDiscoveredRepositoryInput[],
): Promise<(typeof schema.repositories.$inferSelect)[]> {
  if (inputs.length === 0) return [];

  return tx
    .insert(schema.repositories)
    .values(
      inputs.map((input) => ({
        id: newId(),
        projectId: null,
        name: input.name,
        localPath: input.localPath,
        remoteUrl: input.remoteUrl,
        remoteName: input.remoteName,
      })),
    )
    .onConflictDoNothing({ target: schema.repositories.localPath })
    .returning();
}

/** Existing registrations for a set of paths, keyed by `local_path`. */
export async function findRepositoriesByLocalPaths(
  db: DbLike,
  localPaths: readonly string[],
): Promise<Map<string, { id: string; localPath: string }>> {
  if (localPaths.length === 0) return new Map();

  const rows = await db
    .select({ id: schema.repositories.id, localPath: schema.repositories.localPath })
    .from(schema.repositories)
    .where(inArray(schema.repositories.localPath, [...localPaths]));

  return new Map(rows.map((row) => [row.localPath, row]));
}

/** The shas already stored for a repository, out of a candidate set. The poll cursor's backup. */
export async function findKnownCommitShas(
  db: DbLike,
  repositoryId: string,
  shas: readonly string[],
): Promise<ReadonlySet<string>> {
  if (shas.length === 0) return new Set();

  const rows = await db
    .select({ sha: schema.commits.sha })
    .from(schema.commits)
    .where(and(eq(schema.commits.repositoryId, repositoryId), inArray(schema.commits.sha, shas)));

  return new Set(rows.map((row) => row.sha));
}

/**
 * Sessions that could plausibly own a commit in this repository, for `attributeCommit`.
 *
 * Filtered as narrowly as SQL can express the rule without duplicating it: same Repository, a
 * branch to compare, and actually launched. The window test and the uniqueness test stay in the
 * pure function, which is where they can be read and tested. Capped because an unbounded read
 * here would grow with the Session table forever; a repository with more than 500 launched
 * Sessions whose windows all reach one commit does not exist in a single-operator install.
 */
export async function findAttributionCandidates(
  db: DbLike,
  repositoryId: string,
  options: { readonly startedBefore: Date; readonly limit: number },
): Promise<AttributionCandidate[]> {
  const rows = await db
    .select({
      sessionId: schema.sessions.id,
      repositoryId: schema.sessions.repositoryId,
      branch: schema.sessions.branch,
      startedAt: schema.sessions.startedAt,
      completedAt: schema.sessions.completedAt,
      archivedAt: schema.sessions.archivedAt,
    })
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.repositoryId, repositoryId),
        isNotNull(schema.sessions.branch),
        isNotNull(schema.sessions.startedAt),
        lte(schema.sessions.startedAt, options.startedBefore),
      ),
    )
    .orderBy(desc(schema.sessions.startedAt))
    .limit(options.limit);

  return rows.map((row) => ({
    sessionId: row.sessionId,
    repositoryId: row.repositoryId,
    branch: row.branch,
    startedAt: row.startedAt,
    // A Session that was archived without completing still stopped producing commits then.
    endedAt: row.completedAt ?? row.archivedAt,
  }));
}

// ------------------------------------------------------------------------------ pull requests

export interface UpsertPullRequestInput {
  readonly repositoryId: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: PullRequestState;
  readonly author: string | null;
  readonly headBranch: string | null;
  readonly baseBranch: string | null;
  readonly url: string | null;
  readonly openedAt: Date | null;
  readonly reviewedAt: Date | null;
  readonly mergedAt: Date | null;
  readonly closedAt: Date | null;
}

/** Every PR already stored for a repository, keyed by GitHub number. */
export async function findPullRequestsByRepository(
  db: DbLike,
  repositoryId: string,
): Promise<Map<number, PullRequestRow>> {
  const rows = await db
    .select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.repositoryId, repositoryId))
    .orderBy(asc(schema.pullRequests.number));

  return new Map(rows.map((row) => [row.number, row]));
}

/**
 * Insert or update one PR, keyed on `(repository_id, number)` — the GitHub number is the
 * identity (TDS 03 §3.8's `ux_pull_requests_repository_number`), never our own id.
 *
 * `reviewed_at` is **latched**: once set it is never cleared, because "the first review was
 * submitted at T" does not stop being true when the reviews are later dismissed. The `COALESCE`
 * lives in the `DO UPDATE` arm so a sync that did not spend a request on reviews cannot erase a
 * value an earlier one paid for.
 */
export async function upsertPullRequest(
  tx: DbTransaction,
  input: UpsertPullRequestInput,
): Promise<PullRequestRow> {
  const rows = await tx
    .insert(schema.pullRequests)
    .values({
      id: newId(),
      repositoryId: input.repositoryId,
      number: input.number,
      title: input.title,
      description: input.description,
      state: input.state,
      author: input.author,
      headBranch: input.headBranch,
      baseBranch: input.baseBranch,
      url: input.url,
      openedAt: input.openedAt,
      reviewedAt: input.reviewedAt,
      mergedAt: input.mergedAt,
      closedAt: input.closedAt,
    })
    .onConflictDoUpdate({
      target: [schema.pullRequests.repositoryId, schema.pullRequests.number],
      set: {
        title: input.title,
        description: input.description,
        state: input.state,
        author: input.author,
        headBranch: input.headBranch,
        baseBranch: input.baseBranch,
        url: input.url,
        openedAt: input.openedAt,
        reviewedAt: input.reviewedAt ?? schema.pullRequests.reviewedAt,
        mergedAt: input.mergedAt,
        closedAt: input.closedAt,
        updatedAt: new Date(),
      },
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('Pull request upsert returned no row');
  return row;
}
