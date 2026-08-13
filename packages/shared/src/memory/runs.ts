/**
 * The memory index run record — a `sync_runs` row with `kind = 'memory_index'`.
 *
 * Why this table and not a new one is argued in `db/schema/sync.ts` and in `backfill.ts`; the
 * short version is that `ux_sync_runs_active` already makes "at most one active run per kind" a
 * database constraint, and re-implementing a guard is how two implementations of it end up
 * disagreeing.
 *
 * Two properties this module keeps, both borrowed verbatim from `obsidian/runs.ts` because they
 * are what make a queue-driven run safe under at-least-once delivery:
 *
 *  1. **The overlap guard is the index, not a prior `SELECT`.** A `SELECT` then `INSERT` is a
 *     race, and what is being raced for here is the right to spend an operator's model time.
 *  2. **Every transition is conditional on the state it expects.** A redelivered job that finds
 *     the run already `completed` updates zero rows and does nothing, rather than restarting a
 *     sweep that has finished.
 */

import { and, desc, eq, inArray } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import { newId } from '../events/envelope.js';
import type { BackfillProgress } from './backfill.js';
import { emptyProgress, readProgress } from './backfill.js';

type DbLike = Db | DbTransaction;

export type MemoryRunRow = typeof schema.syncRuns.$inferSelect;

/** The `sync_runs.kind` discriminator for a memory index run. */
export const MEMORY_RUN_KIND = 'memory_index';

/** Non-terminal states — what `ux_sync_runs_active` admits exactly one of. */
const ACTIVE_STATES = ['queued', 'running'] as const;

export type MemoryRunTrigger = 'user' | 'schedule';

/**
 * How much of the index this run is meant to rebuild.
 *
 * `incremental` re-diffs every source and embeds only what changed — the ordinary sweep, and
 * the one that costs nothing on a second run. `rebuild` is the model-change path: the caller
 * has already reset the collection and dropped the old model's rows, so every source is new.
 *
 * The distinction is recorded on the run rather than inferred, because "why did this take
 * forty minutes" has two very different answers and only the row can tell them apart.
 */
export type MemoryRunMode = 'incremental' | 'rebuild';

export interface InsertMemoryRunInput {
  readonly trigger: MemoryRunTrigger;
  readonly mode: MemoryRunMode;
  readonly id?: string;
}

/**
 * Insert a `queued` run. Throws a `23505` on `ux_sync_runs_active` when one is already active —
 * the caller turns that into `409 CONFLICT`.
 */
export async function insertMemoryRun(
  tx: DbTransaction,
  input: InsertMemoryRunInput,
): Promise<MemoryRunRow> {
  const rows = await tx
    .insert(schema.syncRuns)
    .values({
      id: input.id ?? newId(),
      kind: MEMORY_RUN_KIND,
      state: 'queued',
      trigger: input.trigger,
      // A fresh run starts at the first stage with a zeroed counter set. `mode` rides in
      // `stats` because that column *is* the run's own scratch space (§4.5) and adding a
      // column for one enum on one of two kinds would be a migration per discriminator.
      stats: { ...emptyProgress(), mode: input.mode },
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('sync_runs insert returned no row');
  return row;
}

export async function findMemoryRun(db: DbLike, id: string): Promise<MemoryRunRow | null> {
  const rows = await db
    .select()
    .from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.id, id), eq(schema.syncRuns.kind, MEMORY_RUN_KIND)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findActiveMemoryRun(db: DbLike): Promise<MemoryRunRow | null> {
  const rows = await db
    .select()
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.kind, MEMORY_RUN_KIND),
        inArray(schema.syncRuns.state, [...ACTIVE_STATES]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Newest run first — what `GET /memory-items/backfill` reports when nothing is active. */
export async function findLatestMemoryRun(db: DbLike): Promise<MemoryRunRow | null> {
  const rows = await db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.kind, MEMORY_RUN_KIND))
    .orderBy(desc(schema.syncRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** `queued -> running`. `null` means somebody else already claimed this run. */
export async function beginMemoryRun(
  tx: DbTransaction,
  id: string,
  now: Date,
): Promise<MemoryRunRow | null> {
  const updated = await tx
    .update(schema.syncRuns)
    .set({ state: 'running', startedAt: now, updatedAt: now })
    .where(
      and(
        eq(schema.syncRuns.id, id),
        eq(schema.syncRuns.kind, MEMORY_RUN_KIND),
        eq(schema.syncRuns.state, 'queued'),
      ),
    )
    .returning();

  return updated[0] ?? null;
}

/**
 * Commit a slice's progress.
 *
 * `updated_at` moves on every slice, and that is load-bearing rather than incidental: it is what
 * distinguishes a long run that is working from one whose process died, and therefore what
 * `reclaimAbandonedMemoryRuns` keys on.
 */
export async function saveMemoryRunProgress(
  db: DbLike,
  id: string,
  progress: BackfillProgress,
  now: Date,
  mode: MemoryRunMode,
): Promise<void> {
  await db
    .update(schema.syncRuns)
    .set({ stats: { ...progress, mode }, updatedAt: now })
    .where(and(eq(schema.syncRuns.id, id), eq(schema.syncRuns.state, 'running')));
}

export async function completeMemoryRun(
  db: DbLike,
  id: string,
  progress: BackfillProgress,
  now: Date,
  mode: MemoryRunMode,
): Promise<boolean> {
  const updated = await db
    .update(schema.syncRuns)
    .set({
      state: 'completed',
      stats: { ...progress, mode },
      completedAt: now,
      updatedAt: now,
    })
    .where(and(eq(schema.syncRuns.id, id), eq(schema.syncRuns.state, 'running')))
    .returning({ id: schema.syncRuns.id });

  return updated.length === 1;
}

/**
 * `queued | running -> failed`.
 *
 * Progress is written even on failure: a run that indexed nine hundred sources and then lost
 * Ollama did index nine hundred sources, and reporting zero would send the operator looking for
 * a problem that is not there. It is also what makes the *next* run cheap — every one of those
 * sources is now a hash match.
 */
export async function failMemoryRun(
  db: DbLike,
  id: string,
  error: string,
  progress: BackfillProgress,
  now: Date,
  mode: MemoryRunMode,
): Promise<boolean> {
  const updated = await db
    .update(schema.syncRuns)
    .set({
      state: 'failed',
      error: error.slice(0, 2_000),
      stats: { ...progress, mode },
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.syncRuns.id, id),
        eq(schema.syncRuns.kind, MEMORY_RUN_KIND),
        inArray(schema.syncRuns.state, [...ACTIVE_STATES]),
      ),
    )
    .returning({ id: schema.syncRuns.id });

  return updated.length === 1;
}

/** The progress and mode carried on a run row, validated rather than trusted. */
export function runProgressOf(row: MemoryRunRow): {
  readonly progress: BackfillProgress;
  readonly mode: MemoryRunMode;
} {
  return {
    progress: readProgress(row.stats),
    mode: row.stats?.mode === 'rebuild' ? 'rebuild' : 'incremental',
  };
}
