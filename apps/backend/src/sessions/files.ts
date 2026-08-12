import { isAbsolute, relative, sep } from 'node:path';
import { type Db, schema } from '@mc/shared';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { SessionRow } from './repository.js';
import type { SessionObservation } from './serialize.js';

/**
 * `GET /api/v1/sessions/{id}/files` — the de-duplicated set of files a Session touched
 * (TDS 04 §6.10.2).
 *
 * Two sources, two path dialects, and reconciling them *is* the problem: `commits.files`
 * carries repository-relative POSIX paths (git's own form) while `messages.tool_file_path`
 * carries whatever absolute native path the runtime reported. Ignoring that would list every
 * edited file twice.
 *
 * Bounded read model, so `{ data: … }` with no cursor and no `meta` (§1.2). The ordering key is
 * a computed aggregate with heavy ties, so a keyset cursor over it would be neither stable nor
 * cheap, and the aggregate has to be computed in full before it can be ranked at all. The
 * server caps at 500 and reports `totalFiles` + `truncated` instead.
 */

/** A Session that touched more than this has a problem the Files tab was never going to solve. */
export const SESSION_FILES_CAP = 500;

export interface SessionFileTouch {
  /** Root-relative with `/` separators — or the absolute native path when `outsideRoot`. */
  readonly path: string;
  readonly outsideRoot: boolean;
  readonly touchCount: number;
  readonly toolTouchCount: number;
  readonly commitCount: number;
  readonly sources: readonly ('tool' | 'commit')[];
  readonly status: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly lastTouchedAt: string;
}

export interface SessionFilesReadModel {
  readonly root: string;
  readonly files: readonly SessionFileTouch[];
  readonly totalFiles: number;
  readonly truncated: boolean;
  readonly commitsAsOf: string | null;
  readonly completeness: 'complete' | 'partial';
  readonly completenessReason: 'observation_degraded' | 'hooks_not_installed' | null;
}

interface Accumulator {
  path: string;
  outsideRoot: boolean;
  toolTouchCount: number;
  commitCount: number;
  additions: number | null;
  deletions: number | null;
  status: string | null;
  statusAt: number;
  lastTouchedAt: number;
}

export async function buildSessionFiles(
  db: Db,
  session: SessionRow,
  observation: SessionObservation | null,
): Promise<SessionFilesReadModel> {
  const repository = await findRepository(db, session.repositoryId);
  // §6.10.2 step 1: repository local path when the Session names one, otherwise its working
  // directory. Echoed in the response so the UI labels the list from server truth.
  const root = repository?.localPath ?? session.workingDir ?? '';

  const accumulators = new Map<string, Accumulator>();

  for (const file of await readCommitFiles(db, session.id)) {
    // §6.10.2 step 3: git cannot report a path outside its own tree, so commit paths are used
    // verbatim and are never `outsideRoot`.
    const entry = upsert(accumulators, file.path, false);
    entry.commitCount += 1;
    entry.additions = (entry.additions ?? 0) + file.additions;
    entry.deletions = (entry.deletions ?? 0) + file.deletions;
    const committedAt = file.committedAt.getTime();
    if (committedAt >= entry.statusAt) {
      entry.status = file.status;
      entry.statusAt = committedAt;
    }
    entry.lastTouchedAt = Math.max(entry.lastTouchedAt, committedAt);
  }

  for (const touch of await readToolTouches(db, session.id)) {
    const normalized = normalizeToolPath(root, touch.path);
    const entry = upsert(accumulators, normalized.path, normalized.outsideRoot);
    // §6.10.2 step 5: each invocation counts once. Repeated reads of the same file *are*
    // separate touches; collapsing them would understate how much attention a file got.
    entry.toolTouchCount += touch.count;
    entry.lastTouchedAt = Math.max(entry.lastTouchedAt, touch.lastTouchedAt.getTime());
  }

  const ranked = [...accumulators.values()]
    .map(toFileTouch)
    .sort(
      (left, right) =>
        right.touchCount - left.touchCount ||
        (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    );

  const completeness = completenessOf(observation);

  return {
    root,
    files: ranked.slice(0, SESSION_FILES_CAP),
    totalFiles: ranked.length,
    truncated: ranked.length > SESSION_FILES_CAP,
    // Commit-derived rows are only as fresh as the last repository sync, so the panel can say
    // "commits as of 14:07" rather than implying real time.
    commitsAsOf: repository?.lastSyncedAt?.toISOString() ?? null,
    ...completeness,
  };
}

/**
 * Incompleteness is reported, never implied (§6.10.2). Managed Sessions stream every tool call
 * through the Backend so their file set is complete by construction; an observed Session whose
 * fidelity is known to be reduced reports `partial`, because Mission Control cannot prove the
 * hooks/transcript redundancy held for any specific skipped line.
 */
function completenessOf(observation: SessionObservation | null): {
  completeness: 'complete' | 'partial';
  completenessReason: 'observation_degraded' | 'hooks_not_installed' | null;
} {
  if (observation === null) return { completeness: 'complete', completenessReason: null };
  if (observation.degraded) {
    return { completeness: 'partial', completenessReason: 'observation_degraded' };
  }
  if (observation.channel === 'transcript_only') {
    return { completeness: 'partial', completenessReason: 'hooks_not_installed' };
  }
  return { completeness: 'complete', completenessReason: null };
}

async function findRepository(
  db: Db,
  repositoryId: string | null,
): Promise<{ localPath: string; lastSyncedAt: Date | null } | null> {
  if (repositoryId === null) return null;
  const rows = await db
    .select({
      localPath: schema.repositories.localPath,
      lastSyncedAt: schema.repositories.lastSyncedAt,
    })
    .from(schema.repositories)
    .where(eq(schema.repositories.id, repositoryId))
    .limit(1);
  return rows[0] ?? null;
}

interface CommitFileRow {
  path: string;
  status: string | null;
  additions: number;
  deletions: number;
  committedAt: Date;
}

/** `commits.files` expanded with `jsonb_array_elements`, served by `ix_commits_session_id`. */
async function readCommitFiles(db: Db, sessionId: string): Promise<CommitFileRow[]> {
  const result = await db.execute<{
    path: string | null;
    status: string | null;
    additions: number | null;
    deletions: number | null;
    committed_at: Date | string;
  }>(sql`
    SELECT f->>'path'                            AS path,
           f->>'status'                          AS status,
           COALESCE((f->>'additions')::int, 0)   AS additions,
           COALESCE((f->>'deletions')::int, 0)   AS deletions,
           c.committed_at                        AS committed_at
    FROM ${schema.commits} c
    CROSS JOIN LATERAL jsonb_array_elements(c.files) AS f
    WHERE c.session_id = ${sessionId}
  `);

  const rows: CommitFileRow[] = [];
  for (const row of result.rows) {
    if (typeof row.path !== 'string' || row.path.length === 0) continue;
    rows.push({
      path: row.path,
      status: row.status,
      additions: Number(row.additions ?? 0),
      deletions: Number(row.deletions ?? 0),
      committedAt: row.committed_at instanceof Date ? row.committed_at : new Date(row.committed_at),
    });
  }
  return rows;
}

/**
 * Tool activity, grouped by `messages.tool_file_path` — the column WS3 §3.11 added for exactly
 * this endpoint, written once by the ingester so no runtime-version knowledge ends up in a SQL
 * expression that cannot degrade gracefully. Served by `ix_messages_session_tool_file`.
 */
async function readToolTouches(
  db: Db,
  sessionId: string,
): Promise<{ path: string; count: number; lastTouchedAt: Date }[]> {
  const rows = await db
    .select({
      path: schema.messages.toolFilePath,
      count: sql<number>`count(*)::int`,
      lastTouchedAt: sql<Date>`max(${schema.messages.occurredAt})`,
    })
    .from(schema.messages)
    .where(and(eq(schema.messages.sessionId, sessionId), isNotNull(schema.messages.toolFilePath)))
    .groupBy(schema.messages.toolFilePath)
    .orderBy(desc(sql`count(*)`));

  return rows.flatMap((row) =>
    row.path === null
      ? []
      : [
          {
            path: row.path,
            count: Number(row.count),
            lastTouchedAt:
              row.lastTouchedAt instanceof Date ? row.lastTouchedAt : new Date(row.lastTouchedAt),
          },
        ],
  );
}

/**
 * §6.10.2 step 2. An absolute tool path under `root` is rewritten root-relative with `/`
 * separators; one that is not is kept verbatim with `outsideRoot: true`. A tool that read
 * `C:\Users\me\.ssh\config` must appear — silently dropping out-of-tree touches would make the
 * panel a comfort blanket rather than a record.
 */
export function normalizeToolPath(
  root: string,
  toolPath: string,
): { path: string; outsideRoot: boolean } {
  if (root.length === 0) return { path: toolPath, outsideRoot: true };
  if (!isAbsolute(toolPath)) return { path: toPosix(toolPath), outsideRoot: false };

  const rel = relative(root, toolPath);
  if (rel.length === 0) return { path: toolPath, outsideRoot: true };
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return { path: toolPath, outsideRoot: true };
  }
  return { path: toPosix(rel), outsideRoot: false };
}

function toPosix(value: string): string {
  return sep === '/' ? value : value.split(sep).join('/');
}

function upsert(
  accumulators: Map<string, Accumulator>,
  path: string,
  outsideRoot: boolean,
): Accumulator {
  const existing = accumulators.get(path);
  if (existing !== undefined) return existing;

  const created: Accumulator = {
    path,
    outsideRoot,
    toolTouchCount: 0,
    commitCount: 0,
    additions: null,
    deletions: null,
    status: null,
    statusAt: Number.NEGATIVE_INFINITY,
    lastTouchedAt: 0,
  };
  accumulators.set(path, created);
  return created;
}

function toFileTouch(entry: Accumulator): SessionFileTouch {
  const sources: ('tool' | 'commit')[] = [];
  if (entry.toolTouchCount > 0) sources.push('tool');
  if (entry.commitCount > 0) sources.push('commit');

  return {
    path: entry.path,
    outsideRoot: entry.outsideRoot,
    touchCount: entry.toolTouchCount + entry.commitCount,
    toolTouchCount: entry.toolTouchCount,
    commitCount: entry.commitCount,
    sources,
    status: entry.status,
    additions: entry.additions,
    deletions: entry.deletions,
    lastTouchedAt: new Date(entry.lastTouchedAt).toISOString(),
  };
}
