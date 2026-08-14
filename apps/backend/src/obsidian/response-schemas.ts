import { OBSIDIAN_SYNC_MODES, SYNC_RUN_STATES, SYNC_RUN_TRIGGERS } from '@mc/shared';
import {
  type Assert,
  arrayOf,
  booleanValue,
  type ExactShape,
  entityId,
  enumSchema,
  inlineObject,
  integerValue,
  nullable,
  nullableEntityId,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringEnum,
  stringValue,
} from '../http/response-schema.js';
import type { SyncRunDetailResource, SyncRunFileDetail, SyncRunResource } from './serialize.js';
import type { SyncPreview, SyncPreviewItem } from './service.js';

/** The `SyncRun` response shapes plus the dry-run preview (TDS 04 §10). */

export const syncRunSchema = objectSchema('SyncRun', {
  id: entityId,
  kind: stringEnum(['obsidian']),
  state: enumSchema('SyncRunState', SYNC_RUN_STATES),
  trigger: enumSchema('SyncRunTrigger', SYNC_RUN_TRIGGERS),
  startedAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  stats: nullable(
    objectSchema('SyncRunStats', {
      notesExported: integerValue,
      notesImported: integerValue,
      conflicts: integerValue,
    }),
  ),
  error: nullableString,
  createdAt: stringValue,
});
export type _SyncRunShape = Assert<ExactShape<SyncRunResource, typeof syncRunSchema>>;

const syncRunFileDetailSchema = objectSchema('SyncRunFileDetail', {
  vaultPath: stringValue,
  entityType: nullableString,
  entityId: nullableEntityId,
  /** The ledger's own status, so `conflict` and `error` both surface. */
  status: stringValue,
  lastError: nullableString,
  lastSyncedAt: nullableTimestamp,
});
export type _SyncRunFileDetailShape = Assert<
  ExactShape<SyncRunFileDetail, typeof syncRunFileDetailSchema>
>;

export const syncRunDetailSchema = objectSchema('SyncRunDetail', {
  ...syncRunSchema.properties,
  /** Files still in conflict **right now**, whichever run detected them. */
  conflicts: arrayOf(syncRunFileDetailSchema),
  /** Files the last run could not read or could not write. */
  errors: arrayOf(syncRunFileDetailSchema),
});
export type _SyncRunDetailShape = Assert<
  ExactShape<SyncRunDetailResource, typeof syncRunDetailSchema>
>;

const syncPreviewItemSchema = objectSchema('SyncPreviewItem', {
  action: stringValue,
  entityType: stringValue,
  entityId: stringValue,
  vaultPath: stringValue,
  reason: stringValue,
  resolution: nullableString,
  /** True when running for real would first copy the vault's version aside. */
  wouldKeepVaultCopy: booleanValue,
});
export type _SyncPreviewItemShape = Assert<
  ExactShape<SyncPreviewItem, typeof syncPreviewItemSchema>
>;

export const syncPreviewSchema = objectSchema('SyncPreview', {
  vaultPath: stringValue,
  syncMode: enumSchema('ObsidianSyncMode', OBSIDIAN_SYNC_MODES),
  conflictPolicy: stringValue,
  /** Syncing is off. The plan is still computed — that is when it is most useful. */
  paused: booleanValue,
  problem: nullable(inlineObject({ kind: stringValue, detail: stringValue })),
  summary: objectSchema('SyncPreviewSummary', {
    create: integerValue,
    update: integerValue,
    import: integerValue,
    inSync: integerValue,
    conflict: integerValue,
    pendingPull: integerValue,
    error: integerValue,
    /** Notes in the managed folders carrying no Mission Control id. Never touched. */
    unmanaged: integerValue,
  }),
  items: arrayOf(syncPreviewItemSchema),
  itemsTruncated: booleanValue,
  /** Notes claiming an id another note already claims — a copied or restored file. */
  duplicateIdPaths: arrayOf(stringValue),
});
export type _SyncPreviewShape = Assert<ExactShape<SyncPreview, typeof syncPreviewSchema>>;
