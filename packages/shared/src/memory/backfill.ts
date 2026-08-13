/**
 * The backfill — indexing everything that predates the index, in bounded resumable slices.
 *
 * Sessions, commits, ADRs and pull requests already exist by the thousand when memory is first
 * configured. Something has to walk them, and the shape of that something is fixed by three
 * constraints that pull against each other:
 *
 *  - **It cannot run as one long job.** A single handler that indexes 4 000 sources holds a
 *    pg-boss lease for minutes, blocks the incremental indexing behind it on the same queue,
 *    and loses all its work if the process is restarted at minute nine.
 *  - **It cannot run twice.** Two concurrent sweeps would race on the same `(source, chunk,
 *    model)` rows and double every embedding call.
 *  - **It has to be visible.** "Is it still going, and how far has it got" is the first thing an
 *    operator asks, and the only honest answer comes from state that survives a restart.
 *
 * So a backfill is a **run row plus a self-continuing job**. One slice per job: index at most
 * `BACKFILL_BATCH_SIZE` sources, commit the cursor to the run row, enqueue the next slice, and
 * return. Progress is `stats` on the run; the cursor is `stats.cursor`.
 *
 * ## The guard is the database, not a flag
 *
 * The run row is a `sync_runs` row with `kind = 'memory_index'`, and `ux_sync_runs_active` — a
 * partial unique index over `state IN ('queued','running')`, **per kind** — makes "at most one
 * active backfill" a constraint rather than a convention. Two overlapping triggers do not both
 * win; the loser gets a `23505` and the API turns it into `409 CONFLICT`. This is the same
 * mechanism the Obsidian sync uses (`obsidian/runs.ts`) and it is reused rather than
 * re-implemented precisely because the failure it prevents is the same one: two processes
 * racing for write access to a shared store.
 *
 * ⚠ **Widening `sync_runs.kind` is a deviation from TDS 03 §4.5**, which introduced the table
 * for Obsidian sync alone, and it is flagged rather than smuggled in. The alternative — a
 * `memory_index_runs` table with the same seven columns, the same four states and a copy of the
 * same partial unique index — would have been a second implementation of a guard that already
 * exists and is already tested. `kind` exists to discriminate; this is the second kind. Every
 * existing read is already `kind`-filtered (`findActiveSyncRun`, `listSyncRuns`,
 * `findLatestSyncRun`), so `GET /sync-runs` continues to mean "Obsidian sync runs" unchanged.
 *
 * ## Resumability is from the row, not from the payload
 *
 * The continuation job carries only `{ runId }`. The cursor comes from the run row, which was
 * committed by the previous slice. That matters for the one case a payload cursor gets wrong: a
 * job that is **redelivered** (a lease expiring mid-slice, a hard kill) carries the cursor it
 * started with and would redo the slice; reading from the row means a redelivery resumes from
 * whatever actually committed. Redoing a slice would be correct but not free — every source in
 * it is re-diffed, and any source whose hash *did* change gets re-embedded twice.
 */

import type { Db, DbTransaction } from '../db/index.js';
import type { MemorySourceType } from '../entities/memory.js';
import type { ChunkBudget } from './chunk.js';
import type { EmbeddingPort } from './embedding-port.js';
import { type IndexOutcome, indexSource } from './indexer.js';
import {
  projectAdr,
  projectCommit,
  projectPullRequest,
  projectSession,
  type SourceProjection,
} from './projection.js';
import type { EmbeddingStamp } from './stamp.js';
import {
  deleteMemoryItemsByIds,
  listAdrSources,
  listArchivedSessionMemoryItemIds,
  listCommitSources,
  listOrphanedMemoryItemIds,
  listPullRequestSources,
  listSessionSources,
  readSessionTurns,
} from './store.js';
import { describeVectorStoreFailure, type VectorStorePort } from './vector-store-port.js';

/**
 * Sources per slice.
 *
 * A Session is the expensive one: up to `DEFAULT_MAX_CHUNKS` chunks, so a slice of 25 sessions
 * is at most 10 000 chunks — too many. 10 keeps a slice at a few seconds of model time on the
 * measured 5.9 ms/chunk, which is short enough that an incremental index job queued behind it
 * is not noticeably delayed and short enough that a crash loses seconds, not minutes.
 */
export const BACKFILL_BATCH_SIZE = 10;

/** Orphan and archived-session rows cleared per prune pass. */
export const BACKFILL_PRUNE_LIMIT = 500;

/** Turns read per Session. Above this a transcript is projected from its opening. */
export const BACKFILL_MAX_TURNS = 2_000;

/**
 * The source types the sweep walks, **in order**.
 *
 * ADRs first, then pull requests, then commits, then sessions — cheapest and densest first, so
 * the first minute of a backfill already makes "when did we decide X" answerable, and the long
 * tail of session transcripts arrives after. A backfill that is 30 % done is then 30 % *useful*
 * rather than 30 % of the way through the least valuable material.
 *
 * `obsidian_note` is not here: it is not a database table, and vault notes are indexed by their
 * own pass (`notes.ts` in the Backend) which needs a filesystem scan this module has no business
 * owning.
 */
export const BACKFILL_SOURCE_ORDER = [
  'adr',
  'pull_request',
  'commit',
  'session',
] as const satisfies readonly MemorySourceType[];

export type BackfillSourceType = (typeof BACKFILL_SOURCE_ORDER)[number];

/** Where a backfill has got to. Stored verbatim as `sync_runs.stats`. */
export interface BackfillProgress {
  /** Which source type the next slice starts on. `null` once every type is exhausted. */
  readonly stage: BackfillSourceType | null;
  /** Keyset cursor within `stage` — the last id indexed. */
  readonly cursor: string | null;
  readonly sourcesSeen: number;
  readonly sourcesIndexed: number;
  readonly sourcesSkipped: number;
  readonly chunksEmbedded: number;
  readonly chunksDeleted: number;
  /** Sources whose indexing failed. Named so a run does not report success it did not have. */
  readonly failures: number;
  /** The last failure's message, for the run row and the Services panel. */
  readonly lastError: string | null;
  /** Rows removed by the prune pass, which runs once at the end. */
  readonly pruned: number;
  /**
   * True once the Obsidian vault stage has run.
   *
   * The note stage lives in the Backend (`memory/notes.ts`) rather than here, because it is a
   * bounded filesystem scan against an operator-supplied path and this module is a database
   * sweep. It runs after every database stage — its own flag rather than a member of
   * `BACKFILL_SOURCE_ORDER` precisely so that `stage`'s vocabulary keeps meaning "a table this
   * module knows how to page through".
   */
  readonly notesDone: boolean;
}

export function emptyProgress(): BackfillProgress {
  return {
    stage: BACKFILL_SOURCE_ORDER[0],
    cursor: null,
    sourcesSeen: 0,
    sourcesIndexed: 0,
    sourcesSkipped: 0,
    chunksEmbedded: 0,
    chunksDeleted: 0,
    failures: 0,
    lastError: null,
    pruned: 0,
    notesDone: false,
  };
}

/**
 * Read a progress object back out of `sync_runs.stats`, which is untyped JSONB.
 *
 * Defensive because the row may have been written by an older build or edited by hand, and a
 * `stage` of `"sessions"` (plural, a plausible hand-edit) must not silently restart the sweep
 * from the beginning — it resolves to `null`, which ends the run, and the operator triggers a
 * new one. Guessing would re-embed the entire corpus.
 */
export function readProgress(stats: unknown): BackfillProgress {
  const record =
    typeof stats === 'object' && stats !== null ? (stats as Record<string, unknown>) : {};
  const stage = record['stage'];
  const cursor = record['cursor'];

  const count = (key: string): number => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? Math.trunc(value)
      : 0;
  };

  return {
    stage: isBackfillSourceType(stage) ? stage : null,
    cursor: typeof cursor === 'string' && cursor.length > 0 ? cursor : null,
    sourcesSeen: count('sourcesSeen'),
    sourcesIndexed: count('sourcesIndexed'),
    sourcesSkipped: count('sourcesSkipped'),
    chunksEmbedded: count('chunksEmbedded'),
    chunksDeleted: count('chunksDeleted'),
    failures: count('failures'),
    lastError: typeof record['lastError'] === 'string' ? record['lastError'] : null,
    pruned: count('pruned'),
    notesDone: record['notesDone'] === true,
  };
}

export function isBackfillSourceType(value: unknown): value is BackfillSourceType {
  return typeof value === 'string' && (BACKFILL_SOURCE_ORDER as readonly string[]).includes(value);
}

export interface BackfillSliceOptions {
  readonly db: Db;
  readonly embedder: EmbeddingPort;
  readonly store: VectorStorePort;
  readonly stamp: EmbeddingStamp;
  readonly budget: ChunkBudget;
  readonly progress: BackfillProgress;
  readonly batchSize?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Aborts mid-slice on shutdown or lease expiry. The handler passes the job's signal. */
  readonly signal?: AbortSignal | undefined;
}

export interface BackfillSliceResult {
  readonly progress: BackfillProgress;
  /** True when every source type is exhausted and the prune has run — the run may complete. */
  readonly done: boolean;
  /**
   * Set when the slice stopped because a dependency is unavailable rather than because it
   * finished its batch. The caller fails the run rather than enqueueing a next slice that would
   * hit the same wall — a backfill that retries a dead Ollama every second is a busy loop with
   * a progress bar.
   */
  readonly halt: string | null;
}

/**
 * Do one slice of work and return the new progress. Never throws for a dependency failure.
 *
 * A source that fails is counted and skipped past — one malformed row must not wedge a sweep
 * behind it forever. A *dependency* that fails halts the slice, because every subsequent source
 * in it would fail identically.
 */
export async function runBackfillSlice(
  options: BackfillSliceOptions,
): Promise<BackfillSliceResult> {
  const batchSize = options.batchSize ?? BACKFILL_BATCH_SIZE;
  let progress = options.progress;

  const stage = progress.stage;
  if (stage === null) {
    const pruned = await pruneStaleRows(options);
    return {
      progress: { ...progress, pruned: progress.pruned + pruned },
      done: true,
      halt: null,
    };
  }

  const page = await loadPage(options.db, stage, batchSize, progress.cursor);

  for (const projection of page.projections) {
    if (options.signal?.aborted === true) {
      // Stop cleanly, keep what committed. The cursor already points past the sources that
      // finished, so the next delivery resumes from exactly here.
      return { progress, done: false, halt: null };
    }

    const outcome = await indexSource({
      db: options.db,
      embedder: options.embedder,
      store: options.store,
      stamp: options.stamp,
      budget: options.budget,
      projection,
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    progress = applyOutcome(progress, outcome);

    if (outcome.kind === 'embedder_failed' || outcome.kind === 'store_failed') {
      // Do not advance the cursor past a source we failed on a dependency for: the next
      // attempt must retry it, not skip it.
      return { progress, done: false, halt: outcome.reason };
    }
    progress = { ...progress, cursor: projection.sourceId ?? progress.cursor };
  }

  if (page.nextCursor !== null) {
    return { progress: { ...progress, cursor: page.nextCursor }, done: false, halt: null };
  }

  const nextStage = nextStageAfter(stage);
  return {
    progress: { ...progress, stage: nextStage, cursor: null },
    // Not done yet even when `nextStage` is null: the prune pass is one more slice, so it gets
    // its own bounded delivery rather than being tacked onto the end of a batch.
    done: false,
    halt: null,
  };
}

function nextStageAfter(stage: BackfillSourceType): BackfillSourceType | null {
  const index = BACKFILL_SOURCE_ORDER.indexOf(stage);
  return BACKFILL_SOURCE_ORDER[index + 1] ?? null;
}

function applyOutcome(progress: BackfillProgress, outcome: IndexOutcome): BackfillProgress {
  const seen = progress.sourcesSeen + 1;

  switch (outcome.kind) {
    case 'indexed':
      return {
        ...progress,
        sourcesSeen: seen,
        sourcesIndexed: progress.sourcesIndexed + 1,
        chunksEmbedded: progress.chunksEmbedded + outcome.embedded,
        chunksDeleted: progress.chunksDeleted + outcome.deleted,
      };
    case 'skipped':
      return { ...progress, sourcesSeen: seen, sourcesSkipped: progress.sourcesSkipped + 1 };
    default:
      return {
        ...progress,
        sourcesSeen: seen,
        failures: progress.failures + 1,
        lastError: outcome.reason,
      };
  }
}

interface LoadedPage {
  readonly projections: readonly SourceProjection[];
  readonly nextCursor: string | null;
}

async function loadPage(
  db: Db,
  stage: BackfillSourceType,
  limit: number,
  cursor: string | null,
): Promise<LoadedPage> {
  const after = cursor === null ? {} : { afterId: cursor };

  switch (stage) {
    case 'adr': {
      const page = await listAdrSources(db, { limit, ...after });
      return {
        projections: page.rows.map((row) => projectAdr({ ...row, adrId: row.id })),
        nextCursor: page.nextCursor,
      };
    }
    case 'pull_request': {
      const page = await listPullRequestSources(db, { limit, ...after });
      return {
        projections: page.rows.map((row) => projectPullRequest({ ...row, pullRequestId: row.id })),
        nextCursor: page.nextCursor,
      };
    }
    case 'commit': {
      const page = await listCommitSources(db, { limit, ...after });
      return {
        projections: page.rows.map((row) => projectCommit({ ...row, commitId: row.id })),
        nextCursor: page.nextCursor,
      };
    }
    default: {
      const page = await listSessionSources(db, { limit, ...after });
      const projections: SourceProjection[] = [];
      for (const row of page.rows) {
        const turns = await readSessionTurns(db, row.id, BACKFILL_MAX_TURNS);
        projections.push(
          projectSession({
            sessionId: row.id,
            projectId: row.projectId,
            title: row.title,
            turns,
            occurredAt: row.occurredAt,
          }),
        );
      }
      return { projections, nextCursor: page.nextCursor };
    }
  }
}

/**
 * The end-of-run sweep: chunks whose source row has gone, and chunks of Sessions that have
 * since been archived.
 *
 * Both are re-derived from state rather than trusted to events. Purge-on-archive is
 * event-driven, and an event can be missed — a Backend restart between the transition and the
 * job, an archive performed by a build that predates this code. Deriving the rule from `state`
 * makes the guarantee eventual rather than best-effort.
 */
async function pruneStaleRows(options: BackfillSliceOptions): Promise<number> {
  const [orphaned, archived] = await Promise.all([
    listOrphanedMemoryItemIds(options.db, BACKFILL_PRUNE_LIMIT),
    listArchivedSessionMemoryItemIds(options.db, BACKFILL_PRUNE_LIMIT),
  ]);

  const ids = [...new Set([...orphaned, ...archived])];
  if (ids.length === 0) return 0;

  await options.db.transaction(async (tx: DbTransaction) => {
    await deleteMemoryItemsByIds(tx, ids);
  });

  const dropped = await options.store.deleteByFilter({ memoryItemIds: ids });
  if (dropped.kind !== 'ok') {
    // The rows are gone, so these points can no longer answer a query. Reported through the
    // run's `lastError` by the caller; not retried here.
    throw new Error(`memory prune could not delete points: ${describeVectorStoreFailure(dropped)}`);
  }
  return ids.length;
}

/** A one-line summary of a run's progress — the text a run row and a log line carry. */
export function describeProgress(progress: BackfillProgress): string {
  const stage = progress.stage === null ? 'pruning' : progress.stage;
  return (
    `${String(progress.sourcesIndexed)} indexed, ${String(progress.chunksEmbedded)} chunks ` +
    `embedded, ${String(progress.sourcesSkipped)} skipped, ${String(progress.failures)} failed` +
    (progress.stage === null ? '' : ` (at ${stage})`)
  );
}
