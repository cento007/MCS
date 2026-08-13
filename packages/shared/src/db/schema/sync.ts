/**
 * Obsidian two-way sync bookkeeping: `obsidian_sync_states` (per-file ledger, TDS 03 §4.3)
 * and `sync_runs` (per-run record, TDS 03 §4.5 — finding B1 / deviation D5). Both Phase 2.
 *
 * `sync_runs.state` is a RUN state, not an F7 session state (F9.5 vocabulary discipline).
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { SYNC_RUN_KINDS } from '../../entities/adr.js';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';

/** Polymorphic across `adrs`, `sessions`, `projects` and vault-native note kinds. */
const OBSIDIAN_ENTITY_TYPES = ['project', 'session', 'adr', 'agent', 'feature', 'daily'] as const;

const OBSIDIAN_SYNC_STATUSES = [
  'in_sync',
  'pending_push',
  'pending_pull',
  'conflict',
  'error',
] as const;

/** The subset the `ix_obsidian_sync_status` partial index covers — everything but `in_sync`. */
const OBSIDIAN_PENDING_STATUSES = OBSIDIAN_SYNC_STATUSES.filter((status) => status !== 'in_sync');

/** Exactly the four values in WS2 §10. `queued` exists because a manual trigger returns 202. */
const SYNC_RUN_STATES = ['queued', 'running', 'completed', 'failed'] as const;

/** Non-terminal run states — the guard behind the 409 on overlapping triggers (WS2 §10). */
const SYNC_RUN_ACTIVE_STATES = ['queued', 'running'] as const;

/**
 * ⚠ **`memory_index` widens TDS 03 §4.5, deliberately and on the record.**
 *
 * The table arrived for Obsidian sync alone. The Phase 3 memory backfill needs the same four
 * things this table already provides — a durable run record, the four run states, a
 * `user`/`schedule` trigger, and above all `ux_sync_runs_active`, which makes "at most one
 * active run **per kind**" a database constraint rather than an application convention.
 *
 * The alternative was a `memory_index_runs` table with the same seven columns, the same CHECKs
 * and a second copy of that partial unique index — a second implementation of a guard whose
 * whole value is that it is not re-implemented. `kind` exists to discriminate; this is the
 * second kind. Every existing read is already `kind`-filtered, so `GET /sync-runs` continues to
 * mean "Obsidian sync runs" and nothing about §10 changes.
 *
 * **Imported rather than re-declared.** This file used to keep its own private copy, and
 * `entities/adr.ts` kept an exported one that still read `['obsidian']` long after migration
 * `0005` widened the CHECK — an exported statement about the schema that disagreed with the
 * schema, harmless only because nothing imported it. The list that *builds* the constraint and
 * the list callers read are now the same array, so a third kind cannot make them disagree.
 */

const SYNC_RUN_TRIGGERS = ['user', 'schedule'] as const;

/**
 * WS2 §10 shape — small, whole-read, display-only.
 *
 * Two disjoint field sets, one per `kind`, because a run's progress is exactly what this column
 * is for and neither kind ever reads the other's fields. The `memory_index` half is owned by
 * `memory/backfill.ts` (`BackfillProgress`) and is always read back through its `readProgress`,
 * which validates rather than trusts — the row may have been written by an older build.
 */
export interface SyncRunStats {
  // kind = 'obsidian'
  notesExported?: number;
  notesImported?: number;
  conflicts?: number;

  // kind = 'memory_index'
  readonly mode?: string;
  readonly stage?: string | null;
  readonly cursor?: string | null;
  readonly sourcesSeen?: number;
  readonly sourcesIndexed?: number;
  readonly sourcesSkipped?: number;
  readonly chunksEmbedded?: number;
  readonly chunksDeleted?: number;
  readonly failures?: number;
  readonly lastError?: string | null;
  readonly pruned?: number;
  readonly notesDone?: boolean;
}

/**
 * One row per vault file under the managed layout. `entity_id` has no FK — it is polymorphic;
 * referential cleanup is the Sync Worker's reconciliation pass.
 */
export const obsidianSyncStates = pgTable(
  'obsidian_sync_states',
  {
    id: primaryKeyId(),
    /** Vault-relative path, forward slashes. */
    vaultPath: text('vault_path').notNull(),
    entityType: text('entity_type'),
    /** Polymorphic, no FK. */
    entityId: uuid('entity_id'),
    /** sha256 of the last content generated/accepted by Mission Control. */
    mcHash: text('mc_hash'),
    /** sha256 of the vault file at the last scan. */
    vaultHash: text('vault_hash'),
    vaultMtime: timestamptz('vault_mtime'),
    status: text('status').notNull().default('pending_pull'),
    lastSyncedAt: timestamptz('last_synced_at'),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'ck_obsidian_sync_states_entity_type',
      sql`${table.entityType} IN (${valueList(OBSIDIAN_ENTITY_TYPES)})`,
    ),
    check(
      'ck_obsidian_sync_states_status',
      sql`${table.status} IN (${valueList(OBSIDIAN_SYNC_STATUSES)})`,
    ),
    uniqueIndex('ux_obsidian_sync_vault_path').on(table.vaultPath),
    index('ix_obsidian_sync_entity').on(table.entityType, table.entityId),
    index('ix_obsidian_sync_status')
      .on(table.status)
      .where(sql`${table.status} IN (${valueList(OBSIDIAN_PENDING_STATUSES)})`),
  ],
);

/**
 * The run record behind `POST|GET /api/v1/sync-runs` (WS2 §10) and the `syncRunId` in events
 * 21–24. Holds no FK: a run's per-file detail is joined from `obsidian_sync_states` at read
 * time.
 */
export const syncRuns = pgTable(
  'sync_runs',
  {
    id: primaryKeyId(),
    kind: text('kind').notNull().default('obsidian'),
    state: text('state').notNull().default('queued'),
    trigger: text('trigger').notNull(),
    stats: jsonb('stats').$type<SyncRunStats>(),
    /** Populated on `state = 'failed'` — the `sync.failed` reason verbatim. */
    error: text('error'),
    startedAt: timestamptz('started_at'),
    /** Set on completed OR failed. */
    completedAt: timestamptz('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_sync_runs_kind', sql`${table.kind} IN (${valueList(SYNC_RUN_KINDS)})`),
    check('ck_sync_runs_state', sql`${table.state} IN (${valueList(SYNC_RUN_STATES)})`),
    check('ck_sync_runs_trigger', sql`${table.trigger} IN (${valueList(SYNC_RUN_TRIGGERS)})`),
    check('ck_sync_runs_stats_object', sql`jsonb_typeof(${table.stats}) = 'object'`),
    /** List/newest-first read path (GET /sync-runs, dashboard "last sync" widget). */
    index('ix_sync_runs_kind_created_at').on(table.kind, sql`${table.createdAt} DESC`),
    /** At most one non-terminal run per kind — the 409 becomes a database guarantee. */
    uniqueIndex('ux_sync_runs_active')
      .on(table.kind)
      .where(sql`${table.state} IN (${valueList(SYNC_RUN_ACTIVE_STATES)})`),
  ],
);
