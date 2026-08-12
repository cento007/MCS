import { type DbTransaction, newId, schema } from '@mc/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import { ApiError } from '../../http/errors.js';
import { type DbLike, INITIAL_SESSION_STATE, type SessionRow } from '../repository.js';

/**
 * Runtime session id -> Mission Control Session (TDS 04 §6.8, TDS 02 §5.2).
 *
 * Observed Sessions are created **only** by the system, on first sight of a runtime session id
 * we have never seen (§6.2). That leaves ingest with a question the managed path never has to
 * ask — *whose* Session is this? — because the operator started `claude` in a terminal and told
 * Mission Control nothing.
 *
 * The answer, in order:
 *
 *   1. the Repository whose `local_path` is the longest prefix of the hook's `cwd` — which also
 *      fills `repository_id` and gives the Session its Commits panel for free (§6.10.1);
 *   2. failing that, the oldest Project (UUIDv7 ids are time-ordered, so "oldest" needs no extra
 *      column) — a Session in an unregistered directory still has to land somewhere findable;
 *   3. failing *that*, nothing: with no Project and no user there is no row to write, and the
 *      endpoint says so rather than inventing domain data from an ingest credential.
 */

export interface SessionOwner {
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly userId: string;
}

export interface BindResult {
  readonly session: SessionRow;
  /** `true` when this call created the row — the caller's cue to confirm the attach (§5.2). */
  readonly created: boolean;
}

/**
 * Find the Session for a runtime session id, creating one when it is first seen.
 *
 * Runs inside the caller's transaction so creation, the `created -> running` transition and the
 * first Message are one atomic unit. Creation is idempotent through
 * `ux_sessions_runtime_session_id`: **the conflict target repeats the index predicate**, because
 * that index is partial and omitting `WHERE runtime_session_id IS NOT NULL` makes PostgreSQL
 * reject the statement outright rather than silently skip the de-duplication (TDS 03 §3.11's
 * rule, which applies to every partial unique index in this schema).
 */
export async function bindObservedSession(
  tx: DbTransaction,
  input: {
    readonly runtimeSessionId: string;
    readonly workingDirectory: string | null;
    readonly transcriptPath: string | null;
  },
): Promise<BindResult> {
  const existing = await findByRuntimeSessionId(tx, input.runtimeSessionId);
  if (existing !== null) return { session: existing, created: false };

  const owner = await resolveSessionOwner(tx, input.workingDirectory);
  if (owner === null) {
    throw new ApiError(
      'INTEGRATION_NOT_CONFIGURED',
      'Cannot attach an observed session: Mission Control has no local account and Project to ' +
        'attach it to. Create the account and at least one Project first.',
      { runtimeSessionId: input.runtimeSessionId },
    );
  }

  await tx
    .insert(schema.sessions)
    .values({
      id: newId(),
      projectId: owner.projectId,
      repositoryId: owner.repositoryId,
      userId: owner.userId,
      sessionType: 'observed',
      // Not a parameter and not a transition: F7's `[*] --> created`. The attach confirmation
      // that follows is what moves it to `running`, system-triggered (TDS 02 §5.2).
      state: INITIAL_SESSION_STATE,
      runtime: 'claude_code',
      runtimeSessionId: input.runtimeSessionId,
      workingDir: input.workingDirectory,
      transcriptPath: input.transcriptPath,
    })
    .onConflictDoNothing({
      target: [schema.sessions.runtime, schema.sessions.runtimeSessionId],
      // The partial index's predicate, repeated (TDS 03 §3.11).
      where: sql`${schema.sessions.runtimeSessionId} IS NOT NULL`,
    });

  const session = await findByRuntimeSessionId(tx, input.runtimeSessionId);
  /* c8 ignore next 3 — the insert above guarantees the row unless it was deleted concurrently */
  if (session === null) {
    throw new ApiError('INTERNAL', 'Observed session insert produced no row');
  }

  // `created` is decided by the row's own state rather than by the insert's return value: an
  // `ON CONFLICT DO NOTHING` that collapsed and a fresh insert are indistinguishable here, and
  // "still `created`" is the condition the attach confirmation actually cares about.
  return { session, created: session.state === INITIAL_SESSION_STATE };
}

export async function findByRuntimeSessionId(
  db: DbLike,
  runtimeSessionId: string,
): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.runtime, 'claude_code'),
        eq(schema.sessions.runtimeSessionId, runtimeSessionId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Project / Repository / User for a first-seen observed Session.
 *
 * Exported for its own tests: getting this wrong files somebody's session under the wrong
 * project, which is annoying to notice and annoying to fix.
 */
export async function resolveSessionOwner(
  db: DbLike,
  workingDirectory: string | null,
): Promise<SessionOwner | null> {
  const userRows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .orderBy(asc(schema.users.id))
    .limit(1);

  const userId = userRows[0]?.id;
  if (userId === undefined) return null;

  const repository = await matchRepository(db, workingDirectory);
  if (repository !== null && repository.projectId !== null) {
    return { projectId: repository.projectId, repositoryId: repository.id, userId };
  }

  // V1 has a single default workspace and the operator's Projects inside it (TDS 03 §3.4).
  // Oldest-first is deterministic and, on a single-project install, exactly right.
  const projectRows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .orderBy(asc(schema.projects.id))
    .limit(1);

  const projectId = projectRows[0]?.id;
  if (projectId === undefined) return null;

  return { projectId, repositoryId: repository?.id ?? null, userId };
}

/**
 * The Repository whose `local_path` contains `cwd`, longest match first.
 *
 * `repositories` holds tens of rows in V1 and the Repositories view reads all of them anyway
 * (TDS 03 §3.6 says the sequential scan is by design), so the prefix test runs in memory where
 * it can be a real path comparison rather than a `LIKE` that would mis-handle separators.
 *
 * Exact match first, then case-insensitive: a case-sensitive-only test misses every Windows
 * install where the operator typed `d:\repos\mcs`, and a case-insensitive-only test would make
 * matching depend on which OS the Backend runs on — the coupling §6.10.2 rejects.
 */
async function matchRepository(
  db: DbLike,
  workingDirectory: string | null,
): Promise<{ id: string; projectId: string | null } | null> {
  if (workingDirectory === null || workingDirectory.length === 0) return null;

  const rows = await db
    .select({
      id: schema.repositories.id,
      projectId: schema.repositories.projectId,
      localPath: schema.repositories.localPath,
    })
    .from(schema.repositories);

  const cwd = normalizePath(workingDirectory);
  let best: { id: string; projectId: string | null; length: number } | null = null;

  for (const pass of ['exact', 'insensitive'] as const) {
    for (const row of rows) {
      const root = normalizePath(row.localPath);
      const contains =
        pass === 'exact' ? isUnder(cwd, root) : isUnder(cwd.toLowerCase(), root.toLowerCase());

      if (!contains) continue;
      if (best === null || root.length > best.length) {
        best = { id: row.id, projectId: row.projectId, length: root.length };
      }
    }
    if (best !== null) break;
  }

  return best === null ? null : { id: best.id, projectId: best.projectId };
}

function normalizePath(value: string): string {
  return value.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
}

function isUnder(candidate: string, root: string): boolean {
  if (root.length === 0) return false;
  return candidate === root || candidate.startsWith(`${root}/`);
}
