import { type Db, schema } from '@mc/shared';
import { asc, count, eq } from 'drizzle-orm';
import type {
  RepositoryNotificationFacts,
  SessionNotificationFacts,
  SyncNotificationFacts,
} from './render.js';

/**
 * The reads that turn an F6 event payload into notification text.
 *
 * F6.1 is why this file exists at all: "payloads always carry entity IDs, never full entities;
 * consumers fetch current state via the API". `session.completed` carries a `sessionId` and a
 * `trigger`, so the producer that wants to say "3 commits, 1h 04m, in project Mission Control"
 * has to go and read them.
 *
 * Every read here happens **outside** the production transaction (the same rule
 * `github/sync.ts` follows: reads outside, writes inside one), and every one of them tolerates
 * a missing row — a Session deleted between the event and the notification is a `null`, not an
 * exception that strands the queue job.
 */

export async function readSessionFacts(
  db: Db,
  sessionId: string,
): Promise<SessionNotificationFacts | null> {
  const rows = await db
    .select({
      id: schema.sessions.id,
      title: schema.sessions.title,
      sessionType: schema.sessions.sessionType,
      durationMs: schema.sessions.durationMs,
      startedAt: schema.sessions.startedAt,
      completedAt: schema.sessions.completedAt,
      totalCostUsd: schema.sessions.totalCostUsd,
      failureReason: schema.sessions.failureReason,
      projectName: schema.projects.name,
    })
    .from(schema.sessions)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) return null;

  const commits = await db
    .select({ total: count() })
    .from(schema.commits)
    .where(eq(schema.commits.sessionId, sessionId));

  return {
    sessionId: row.id,
    title: row.title,
    projectName: row.projectName,
    sessionType: row.sessionType,
    durationMs: resolveDuration(row.durationMs, row.startedAt, row.completedAt),
    commitCount: Number(commits[0]?.total ?? 0),
    // `numeric` arrives as a string (F4.2: money is never a float in the database).
    totalCostUsd: row.totalCostUsd === null ? null : Number(row.totalCostUsd),
    failureReason: row.failureReason,
  };
}

/**
 * Prefer the runtime's own duration, fall back to the wall clock.
 *
 * `durationMs` is what the SDK `ResultMessage` reported and is the honest "how long did this
 * actually run"; `completedAt - startedAt` includes any time the Session sat paused. Observed
 * Sessions have no runtime duration at all, which is exactly when the fallback earns its keep.
 */
function resolveDuration(
  durationMs: number | null,
  startedAt: Date | null,
  completedAt: Date | null,
): number | null {
  if (durationMs !== null) return durationMs;
  if (startedAt === null || completedAt === null) return null;
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

export async function readRepositoryFacts(
  db: Db,
  repositoryId: string,
  reason: string | null,
): Promise<RepositoryNotificationFacts> {
  const rows = await db
    .select({
      name: schema.repositories.name,
      localPath: schema.repositories.localPath,
      lastSyncError: schema.repositories.lastSyncError,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);

  const row = rows[0];

  return {
    repositoryId,
    name: row?.name ?? null,
    localPath: row?.localPath ?? null,
    // The event's own `reason` is the short discriminator; the row carries the operator-facing
    // sentence `github/sync.ts` already wrote. Prefer the sentence, keep the discriminator as
    // the fallback so a notification is never blank just because the row moved on.
    reason: row?.lastSyncError ?? reason,
  };
}

export async function readSyncRunFacts(
  db: Db,
  syncRunId: string,
  reason: string | null,
): Promise<SyncNotificationFacts> {
  const rows = await db
    .select({ error: schema.syncRuns.error })
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.id, syncRunId))
    .limit(1);

  return { syncRunId, reason: rows[0]?.error ?? reason };
}

/**
 * The single local account (F4.1), which owns every Notification.
 *
 * `notifications.user_id` is `NOT NULL` with an FK, so a Notification cannot exist without a
 * recipient. V1 has exactly one account; ordering by `(created_at, id)` makes "the account"
 * deterministic anyway rather than dependent on physical row order, so the day a second one
 * exists this returns the original operator instead of whichever row the planner found first.
 */
export async function readNotificationRecipientId(db: Db): Promise<string | null> {
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .orderBy(asc(schema.users.createdAt), asc(schema.users.id))
    .limit(1);

  return rows[0]?.id ?? null;
}
