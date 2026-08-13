import { eq, sql } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import { INITIAL_ADR_STATUS } from '../entities/adr.js';
import type { EntityId } from '../entities/index.js';
import { newId } from '../events/envelope.js';

/**
 * The `adrs` **write** both processes need (TDS 03 §4.1).
 *
 * Two producers create ADRs: the Backend from `POST /api/v1/adrs`, and the Sync Worker from
 * `POST /sessions/{id}/generate-adr` (TDS 04 §9 puts the drafting in the worker). Numbering is
 * the reason this is shared rather than written twice — `adr_number` is per project, assigned
 * as `max + 1` *inside the insert*, and two implementations of that are two chances to produce
 * a duplicate or a gap in the identifier the operator reads on every note.
 *
 * The read side stays in the Backend (`apps/backend/src/adrs/store.ts`): it is API-shaped —
 * cursors, filters, the `synced_at` projection — and nothing in the worker asks for it.
 */

export type AdrRow = typeof schema.adrs.$inferSelect;

export interface InsertAdrInput {
  readonly id?: EntityId;
  readonly projectId: string;
  readonly title: string;
  readonly status?: string;
  readonly context?: string;
  readonly decision?: string;
  readonly alternatives?: string;
  readonly consequences?: string;
  /** Set when the ADR was drafted from a Session (TDS 03 §4.1). */
  readonly sourceSessionId?: string | null;
}

/**
 * Insert with `adr_number = max + 1`, computed by the database inside the same statement.
 *
 * Two transactions committing together can still collide on `ux_adrs_project_number`; the
 * caller retries, because the request was for an ADR and not for a particular number.
 */
export async function insertAdr(tx: DbTransaction, input: InsertAdrInput): Promise<AdrRow> {
  const nextNumber = sql<number>`(
    SELECT coalesce(max(a.adr_number), 0) + 1 FROM adrs a WHERE a.project_id = ${input.projectId}
  )`;

  const rows = await tx
    .insert(schema.adrs)
    .values({
      id: input.id ?? newId(),
      projectId: input.projectId,
      adrNumber: nextNumber,
      title: input.title,
      status: input.status ?? INITIAL_ADR_STATUS,
      context: input.context ?? '',
      decision: input.decision ?? '',
      alternatives: input.alternatives ?? '',
      consequences: input.consequences ?? '',
      sourceSessionId: input.sourceSessionId ?? null,
    })
    .returning();

  const row = rows[0];
  /* c8 ignore next */
  if (row === undefined) throw new Error('adrs insert returned no row');
  return row;
}

/**
 * The ADR already drafted from this Session, if any.
 *
 * The idempotency anchor for `adr.generate`: delivery is at-least-once (F6.3), so the handler
 * asks this first and does nothing when the answer is not `null`. V1 therefore drafts **one**
 * ADR per Session; a second decision from the same session is created by hand, which is also
 * the only way to give it a title that distinguishes it.
 */
export async function findAdrBySourceSession(
  db: Db | DbTransaction,
  sessionId: string,
): Promise<AdrRow | null> {
  const rows = await db
    .select()
    .from(schema.adrs)
    .where(eq(schema.adrs.sourceSessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}
