import { type DbTransaction, schema } from '../db/index.js';
import { newId } from '../events/envelope.js';

/**
 * The narrow audit writer the sync engine uses (`audit_log_entries`, TDS 03 §3.14).
 *
 * The Backend has a fuller one in `apps/backend/src/audit/`, and this is deliberately not it:
 * the engine runs inside the **Sync Worker**, which may not import a Backend module (F2.2).
 * The shape written here is the same shape that module writes, minus the request/IP fields a
 * background job does not have.
 *
 * It matters more here than anywhere else in the system, because these rows are the **recovery
 * path for a losing database version**: when the vault wins a conflict, the ADR fields the
 * import replaced are in `before`, and that is the only copy of them that exists.
 */

export type SyncAuditAction =
  /** A vault edit was taken into an `adrs` row. `before` holds the replaced fields. */
  | 'adr.imported'
  /** An ADR was drafted from a Session by the worker (TDS 04 §9). */
  | 'adr.generated'
  /** Both sides changed and the policy picked a winner. */
  | 'obsidian.conflict_resolved'
  /** Both sides changed and nothing was written — the operator has to decide. */
  | 'obsidian.conflict_detected';

export interface SyncAuditInput {
  readonly action: SyncAuditAction;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  /** The SyncRun this happened in, so the row joins back to the run the operator is reading. */
  readonly syncRunId?: string | null;
}

export async function recordSyncAudit(tx: DbTransaction, input: SyncAuditInput): Promise<void> {
  await tx.insert(schema.auditLogEntries).values({
    id: newId(),
    actorType: 'system',
    actorId: null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before ?? null,
    after: input.after ?? null,
    requestId: input.syncRunId ?? null,
  });
}
