import type { CommitRow } from './store.js';

/**
 * DB row -> the TDS 04 §5.2 `Commit` resource, in **two shapes on purpose**.
 *
 *   `CommitResource`       list item — aggregate counts only
 *   `CommitDetailResource` single fetch — the same fields plus `files[]`
 *
 * §5.2 draws that line and §6.10.1 explains why it matters: `files[]` on the list would make
 * the Session Files tab an N+1 walk over every commit, and a 200-row page of commits that each
 * touched 40 files is a megabyte of JSON nobody rendered. The aggregates (`filesChanged`,
 * `additions`, `deletions`) are what the list actually displays, and they are derived here from
 * `commits.files` rather than stored (TDS 03 §3.7 keeps that array read-whole).
 */

export const COMMIT_FILE_STATUSES = ['added', 'modified', 'deleted', 'renamed'] as const;
export type CommitFileStatus = (typeof COMMIT_FILE_STATUSES)[number];

export interface CommitResource {
  readonly id: string;
  readonly repositoryId: string;
  /** Set when the commit was made during a tracked Session (§5.2, `github/attribution.ts`). */
  readonly sessionId: string | null;
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  /**
   * `null` where git recorded no email. §5.2 types this `string`, but TDS 03 §3.7 makes the
   * column nullable and `github/map.ts` will not invent an address to fill it.
   */
  readonly authorEmail: string | null;
  readonly committedAt: string;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly createdAt: string;
}

/**
 * One entry of `files[]`.
 *
 * ⚠ **`additions`/`deletions` are additive to §5.2 — flagged, not silently invented.** §5.2
 * names `{ path, status }`; the stored array (TDS 03 §3.7) carries the per-file line counts as
 * well, they are already the source of the resource's three aggregates, and the single-commit
 * fetch is the only place a per-file breakdown can be read at all. Dropping them here would
 * hide data the sync already paid GitHub for, in the exact response whose reason to exist is
 * detail.
 */
export interface CommitFileResource {
  readonly path: string;
  readonly status: CommitFileStatus;
  readonly additions: number;
  readonly deletions: number;
}

export interface CommitDetailResource extends CommitResource {
  readonly files: readonly CommitFileResource[];
}

/** The list item — §5.2 minus `files[]`, which is §6.10.1's stated split. */
export function serializeCommit(row: CommitRow): CommitResource {
  return summarize(row, filesOf(row));
}

/** `GET /api/v1/commits/{id}` — the list item plus the per-file breakdown (§5.2). */
export function serializeCommitDetail(row: CommitRow): CommitDetailResource {
  // One pass over `files`, so the aggregates and the array can never describe different sets.
  const files = filesOf(row);
  return { ...summarize(row, files), files };
}

function summarize(row: CommitRow, files: readonly CommitFileResource[]): CommitResource {
  return {
    id: row.id,
    repositoryId: row.repositoryId,
    sessionId: row.sessionId,
    sha: row.sha,
    message: row.message,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    committedAt: row.committedAt.toISOString(),
    filesChanged: files.length,
    additions: files.reduce((total, file) => total + file.additions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `commits.files` is JSONB with a `jsonb_typeof(...) = 'array'` CHECK and nothing finer, so the
 * *elements* are untrusted at read time however carefully `github/map.ts` wrote them. Every
 * accessor here degrades rather than throws: a malformed entry must not be able to 500 a list.
 *
 * An entry with no usable `path` is dropped, which is also why `filesChanged` is computed from
 * this array rather than from the raw one — the count and the list have to agree, and a file
 * that cannot be named cannot be shown.
 */
function filesOf(row: CommitRow): readonly CommitFileResource[] {
  if (!Array.isArray(row.files)) return [];

  const files: CommitFileResource[] = [];
  for (const entry of row.files as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const path = record['path'];
    if (typeof path !== 'string' || path.length === 0) continue;

    files.push({
      path,
      status: asFileStatus(record['status']),
      additions: count(record['additions']),
      deletions: count(record['deletions']),
    });
  }
  return files;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * `github/map.ts` already folds GitHub's wider vocabulary into these four (`removed` ->
 * `deleted`, `copied`/`changed` -> `modified`). Anything else in the column predates that
 * mapping or was written by hand; it reads as `modified` rather than as a blank badge.
 */
function asFileStatus(value: unknown): CommitFileStatus {
  return (COMMIT_FILE_STATUSES as readonly unknown[]).includes(value)
    ? (value as CommitFileStatus)
    : 'modified';
}
