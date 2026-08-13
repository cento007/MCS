import { and, eq, inArray, ne } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import { newId } from '../events/envelope.js';
import type { ObsidianEntityType } from './layout.js';
import type { LedgerEntry } from './plan.js';

/**
 * `obsidian_sync_states` — the per-file ledger (TDS 03 §4.3).
 *
 * It is the memory that makes "changed on both sides" answerable at all. Without it a sync
 * can only compare the two current versions, which cannot distinguish *"the vault was edited"*
 * from *"Mission Control was edited"* — and a sync that cannot tell those apart has to guess,
 * and half its guesses destroy something.
 *
 * `entity_id` is polymorphic and carries no FK by design (TDS 03 §4.3), so the writes here are
 * plain and there is no cascade to reason about.
 */

export type LedgerStatus = 'in_sync' | 'pending_push' | 'pending_pull' | 'conflict' | 'error';

type DbLike = Db | DbTransaction;

export async function readLedger(
  db: DbLike,
  entityTypes: readonly ObsidianEntityType[],
): Promise<LedgerEntry[]> {
  if (entityTypes.length === 0) return [];

  const rows = await db
    .select()
    .from(schema.obsidianSyncStates)
    .where(inArray(schema.obsidianSyncStates.entityType, [...entityTypes]));

  return rows.map((row) => ({
    id: row.id,
    vaultPath: row.vaultPath,
    entityType: row.entityType,
    entityId: row.entityId,
    mcHash: row.mcHash,
    vaultHash: row.vaultHash,
    vaultMtime: row.vaultMtime,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
  }));
}

/**
 * Files in one ledger state — the detail behind `GET /sync-runs/{id}` (TDS 04 §10).
 *
 * Served by `ix_obsidian_sync_status`, the partial index over everything but `in_sync`.
 */
export async function readLedgerByStatus(db: DbLike, status: LedgerStatus): Promise<LedgerEntry[]> {
  const rows = await db
    .select()
    .from(schema.obsidianSyncStates)
    .where(eq(schema.obsidianSyncStates.status, status))
    .orderBy(schema.obsidianSyncStates.vaultPath);

  return rows.map((row) => ({
    id: row.id,
    vaultPath: row.vaultPath,
    entityType: row.entityType,
    entityId: row.entityId,
    mcHash: row.mcHash,
    vaultHash: row.vaultHash,
    vaultMtime: row.vaultMtime,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
  }));
}

/** Every file the operator still has to decide about. */
export function readConflictedFiles(db: DbLike): Promise<LedgerEntry[]> {
  return readLedgerByStatus(db, 'conflict');
}

/** Every file the last run could not read or could not write. */
export function readErroredFiles(db: DbLike): Promise<LedgerEntry[]> {
  return readLedgerByStatus(db, 'error');
}

export interface LedgerUpsert {
  /** The existing row's id, when the planner matched one. */
  readonly ledgerId: string | null;
  readonly vaultPath: string;
  readonly entityType: ObsidianEntityType;
  readonly entityId: string;
  readonly mcHash: string | null;
  readonly vaultHash: string | null;
  readonly vaultMtime: Date | null;
  readonly status: LedgerStatus;
  readonly lastSyncedAt: Date | null;
  readonly lastError: string | null;
}

/**
 * Write one file's ledger row.
 *
 * The move case is why this is not a one-line `ON CONFLICT`: when the operator renames a note
 * in Obsidian, the row for that entity must **move** to the new path rather than a second row
 * appearing beside it. `ux_obsidian_sync_vault_path` is unique, so any row already sitting on
 * the destination path is removed first — it can only be a stale record of a file that is now
 * this entity's.
 */
export async function upsertLedgerEntry(tx: DbTransaction, input: LedgerUpsert): Promise<string> {
  const values = {
    vaultPath: input.vaultPath,
    entityType: input.entityType,
    entityId: input.entityId,
    mcHash: input.mcHash,
    vaultHash: input.vaultHash,
    vaultMtime: input.vaultMtime,
    status: input.status,
    lastSyncedAt: input.lastSyncedAt,
    lastError: input.lastError,
    updatedAt: new Date(),
  };

  if (input.ledgerId !== null) {
    await tx
      .delete(schema.obsidianSyncStates)
      .where(
        and(
          eq(schema.obsidianSyncStates.vaultPath, input.vaultPath),
          ne(schema.obsidianSyncStates.id, input.ledgerId),
        ),
      );

    const updated = await tx
      .update(schema.obsidianSyncStates)
      .set(values)
      .where(eq(schema.obsidianSyncStates.id, input.ledgerId))
      .returning({ id: schema.obsidianSyncStates.id });

    const row = updated[0];
    if (row !== undefined) return row.id;
    // The row was deleted under us (a truncate between runs). Fall through and insert.
  }

  const id = newId();
  const inserted = await tx
    .insert(schema.obsidianSyncStates)
    .values({ id, ...values })
    .onConflictDoUpdate({ target: schema.obsidianSyncStates.vaultPath, set: values })
    .returning({ id: schema.obsidianSyncStates.id });

  return inserted[0]?.id ?? id;
}
