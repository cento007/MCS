import type { AdrStatus } from '@mc/shared';
import type { AdrRecord } from './store.js';

/**
 * `Adr` — TDS 04 §9, verbatim, plus one flagged addition.
 *
 * ⚠ **`adrNumber` is not in §9's interface — added deliberately, not silently.** TDS 03 §4.1
 * calls it "per-project and user-visible (\"ADR-0007\")" and the vault file name is built from
 * it, so a client that cannot read it cannot render the identifier the operator sees
 * everywhere else. Omitting it would force the UI to parse `obsidianPath`.
 */
export interface AdrResource {
  readonly id: string;
  readonly projectId: string;
  readonly adrNumber: number;
  readonly title: string;
  readonly status: AdrStatus;
  readonly context: string;
  readonly decision: string;
  readonly alternatives: string;
  readonly consequences: string;
  readonly sourceSessionId: string | null;
  readonly supersededByAdrId: string | null;
  /** Vault-relative path, maintained by the Sync Worker. `null` until the note is written. */
  readonly obsidianPath: string | null;
  /** `obsidian_sync_states.last_synced_at` for this ADR's note — see `store.ts`. */
  readonly syncedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeAdr(record: AdrRecord): AdrResource {
  const { adr } = record;

  return {
    id: adr.id,
    projectId: adr.projectId,
    adrNumber: adr.adrNumber,
    title: adr.title,
    status: adr.status as AdrStatus,
    context: adr.context,
    decision: adr.decision,
    alternatives: adr.alternatives,
    consequences: adr.consequences,
    sourceSessionId: adr.sourceSessionId,
    supersededByAdrId: adr.supersededByAdrId,
    obsidianPath: adr.obsidianPath,
    syncedAt: record.syncedAt?.toISOString() ?? null,
    createdAt: adr.createdAt.toISOString(),
    updatedAt: adr.updatedAt.toISOString(),
  };
}
