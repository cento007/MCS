import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import {
  ACTIVE_SYNC_RUN_STATES,
  type SyncRunStatsShape,
  type SyncRunTrigger,
} from '../entities/adr.js';
import { newId } from '../events/envelope.js';

/**
 * `sync_runs` — the run record (TDS 03 §4.5, TDS 04 §10).
 *
 * Two properties this module exists to guarantee:
 *
 *  1. **At most one run at a time, enforced by the database.** `ux_sync_runs_active` is a
 *     partial unique index over `state IN ('queued','running')`, so two overlapping triggers
 *     cannot both win — the loser gets a `23505` and the API turns it into `409 CONFLICT`. A
 *     `SELECT` then `INSERT` would be a race, and the thing being raced for is write access to
 *     the operator's vault.
 *  2. **Every transition is conditional on the state it expects.** `beginRun` updates
 *     `WHERE state = 'queued'`; a redelivered pg-boss job therefore updates zero rows and the
 *     consumer knows to do nothing instead of syncing the vault twice. At-least-once delivery
 *     (F6.3) makes that the only safe shape.
 */

type DbLike = Db | DbTransaction;

export type SyncRunRow = typeof schema.syncRuns.$inferSelect;

export const SYNC_RUN_KIND = 'obsidian';

export async function insertSyncRun(
  tx: DbTransaction,
  input: { readonly trigger: SyncRunTrigger; readonly id?: string },
): Promise<SyncRunRow> {
  const rows = await tx
    .insert(schema.syncRuns)
    .values({
      id: input.id ?? newId(),
      kind: SYNC_RUN_KIND,
      state: 'queued',
      trigger: input.trigger,
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('sync_runs insert returned no row');
  return row;
}

export async function findSyncRun(db: DbLike, id: string): Promise<SyncRunRow | null> {
  const rows = await db.select().from(schema.syncRuns).where(eq(schema.syncRuns.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findActiveSyncRun(db: DbLike): Promise<SyncRunRow | null> {
  const rows = await db
    .select()
    .from(schema.syncRuns)
    .where(
      and(
        eq(schema.syncRuns.kind, SYNC_RUN_KIND),
        inArray(schema.syncRuns.state, [...ACTIVE_SYNC_RUN_STATES]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Newest run first — the schedule read model's `lastRunAt` source (TDS 04 §7.7). */
export async function findLatestSyncRun(db: DbLike): Promise<SyncRunRow | null> {
  const rows = await db
    .select()
    .from(schema.syncRuns)
    .where(eq(schema.syncRuns.kind, SYNC_RUN_KIND))
    .orderBy(desc(schema.syncRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * `GET /sync-runs` — newest first, keyset-paginated on the UUIDv7 `id` (F5.3).
 *
 * `id` rather than `created_at`: both are time-ordered here (UUIDv7), and a single-column
 * keyset cannot tie, which a `created_at` cursor can under the same-millisecond inserts a
 * scheduler produces.
 */
export async function listSyncRuns(
  db: DbLike,
  input: { readonly limit: number; readonly beforeId?: string },
): Promise<SyncRunRow[]> {
  const conditions = [eq(schema.syncRuns.kind, SYNC_RUN_KIND)];
  if (input.beforeId !== undefined) conditions.push(lt(schema.syncRuns.id, input.beforeId));

  return db
    .select()
    .from(schema.syncRuns)
    .where(and(...conditions))
    .orderBy(desc(schema.syncRuns.id))
    .limit(input.limit);
}

/**
 * `queued -> running`. `null` means somebody else already claimed this run.
 *
 * The claimed row comes back rather than a boolean because the caller needs its `trigger` for
 * the `sync.started` payload (TDS 04 §15.2 #23), and re-reading it would be a second query
 * against a row this statement already had in hand.
 */
export async function beginSyncRun(
  tx: DbTransaction,
  id: string,
  now: Date,
): Promise<SyncRunRow | null> {
  const updated = await tx
    .update(schema.syncRuns)
    .set({ state: 'running', startedAt: now })
    .where(and(eq(schema.syncRuns.id, id), eq(schema.syncRuns.state, 'queued')))
    .returning();

  return updated[0] ?? null;
}

/** `running -> completed`. */
export async function completeSyncRun(
  tx: DbTransaction,
  id: string,
  stats: SyncRunStatsShape,
  now: Date,
): Promise<boolean> {
  const updated = await tx
    .update(schema.syncRuns)
    .set({ state: 'completed', stats, completedAt: now })
    .where(and(eq(schema.syncRuns.id, id), eq(schema.syncRuns.state, 'running')))
    .returning({ id: schema.syncRuns.id });

  return updated.length === 1;
}

/**
 * `queued | running -> failed`.
 *
 * `stats` is written even on failure when the run got far enough to have any: a run that
 * exported forty notes and then lost the vault did in fact export forty notes, and reporting
 * zero would make the operator look for a problem that is not there.
 */
export async function failSyncRun(
  tx: DbTransaction,
  id: string,
  error: string,
  now: Date,
  stats?: SyncRunStatsShape,
): Promise<boolean> {
  const updated = await tx
    .update(schema.syncRuns)
    .set({
      state: 'failed',
      error: error.slice(0, 2_000),
      completedAt: now,
      ...(stats === undefined ? {} : { stats }),
    })
    .where(
      and(eq(schema.syncRuns.id, id), inArray(schema.syncRuns.state, [...ACTIVE_SYNC_RUN_STATES])),
    )
    .returning({ id: schema.syncRuns.id });

  return updated.length === 1;
}

export interface ReclaimOptions {
  readonly now: Date;
  /** Runs untouched for longer than this are presumed dead. */
  readonly olderThanMs?: number;
  readonly reason?: string;
}

/**
 * Fail runs a previous process left behind.
 *
 * Without this, one hard kill mid-run makes the partial unique index permanent: the abandoned
 * `running` row blocks every future trigger with a `409` and the only cure is SQL. The Sync
 * Worker calls it at startup and on every scheduler tick.
 *
 * A run interrupted this way loses nothing. Each file is written atomically and its ledger row
 * is committed as it goes, so the next run resumes from exactly the state the vault is in —
 * which is the property the per-file ledger buys.
 */
export async function reclaimAbandonedSyncRuns(
  db: DbLike,
  options: ReclaimOptions,
): Promise<number> {
  const olderThanMs = options.olderThanMs ?? 15 * 60_000;
  const cutoff = new Date(options.now.getTime() - olderThanMs);

  const updated = await db
    .update(schema.syncRuns)
    .set({
      state: 'failed',
      error: options.reason ?? 'the sync worker stopped before this run finished',
      completedAt: options.now,
      updatedAt: options.now,
    })
    .where(
      and(
        inArray(schema.syncRuns.state, [...ACTIVE_SYNC_RUN_STATES]),
        lt(schema.syncRuns.updatedAt, cutoff),
      ),
    )
    .returning({ id: schema.syncRuns.id });

  return updated.length;
}
