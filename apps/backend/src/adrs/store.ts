import { type Db, type DbTransaction, schema } from '@mc/shared';
import { and, asc, desc, eq, gt, lt, sql } from 'drizzle-orm';

/**
 * Every `adrs` read and write (TDS 03 §4.1).
 *
 * `synced_at` deserves a note: TDS 04 §9's `Adr` resource has one, and the `adrs` table has no
 * such column. It is not missing — it belongs to the **file**, not the decision, and lives in
 * `obsidian_sync_states.last_synced_at` (TDS 03 §4.3, whose own header says the Obsidian
 * mapping lives there). So every read here left-joins the ledger row for
 * `(entity_type = 'adr', entity_id = adrs.id)` and projects its `last_synced_at`. Recorded as a
 * contract wrinkle rather than resolved by adding a second copy of the truth to `adrs`.
 *
 * The **insert** is not here: `adr_number` is `max + 1` per project and the Sync Worker creates
 * ADRs too (TDS 04 §9's `generate-adr`), so the numbering write lives in `@mc/shared/adrs`
 * where both processes use the same one. Everything below is API-shaped and Backend-only.
 */

export type AdrRow = typeof schema.adrs.$inferSelect;

/** An ADR plus the one ledger field the API contract projects onto it. */
export interface AdrRecord {
  readonly adr: AdrRow;
  readonly syncedAt: Date | null;
}

export type DbLike = Db | DbTransaction;

export interface ListAdrsFilters {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string;
  readonly projectId?: string;
  readonly status?: string;
}

const SYNCED_AT = sql<Date | null>`(
  SELECT s.last_synced_at
  FROM obsidian_sync_states s
  WHERE s.entity_type = 'adr' AND s.entity_id = ${schema.adrs.id}
  LIMIT 1
)`;

export async function listAdrs(db: DbLike, filters: ListAdrsFilters): Promise<AdrRecord[]> {
  const conditions = [];
  if (filters.projectId !== undefined)
    conditions.push(eq(schema.adrs.projectId, filters.projectId));
  if (filters.status !== undefined) conditions.push(eq(schema.adrs.status, filters.status));
  if (filters.afterId !== undefined) {
    conditions.push(
      filters.order === 'desc'
        ? lt(schema.adrs.id, filters.afterId)
        : gt(schema.adrs.id, filters.afterId),
    );
  }

  const rows = await db
    .select({ adr: schema.adrs, syncedAt: SYNCED_AT })
    .from(schema.adrs)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(filters.order === 'desc' ? desc(schema.adrs.id) : asc(schema.adrs.id))
    .limit(filters.limit);

  return rows.map(toRecord);
}

export async function findAdrById(db: DbLike, id: string): Promise<AdrRecord | null> {
  const rows = await db
    .select({ adr: schema.adrs, syncedAt: SYNCED_AT })
    .from(schema.adrs)
    .where(eq(schema.adrs.id, id))
    .limit(1);

  const row = rows[0];
  return row === undefined ? null : toRecord(row);
}

export type AdrUpdate = Partial<
  Pick<
    typeof schema.adrs.$inferInsert,
    | 'title'
    | 'status'
    | 'context'
    | 'decision'
    | 'alternatives'
    | 'consequences'
    | 'supersededByAdrId'
  >
>;

export async function updateAdr(
  tx: DbTransaction,
  id: string,
  changes: AdrUpdate,
): Promise<AdrRow | null> {
  const rows = await tx.update(schema.adrs).set(changes).where(eq(schema.adrs.id, id)).returning();
  return rows[0] ?? null;
}

export async function projectExists(db: DbLike, projectId: string): Promise<boolean> {
  const rows = await db
    .select({ id: schema.projects.id })
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1);
  return rows.length === 1;
}

export interface SessionSummary {
  readonly id: string;
  readonly projectId: string;
  readonly state: string;
}

export async function findSessionSummary(
  db: DbLike,
  sessionId: string,
): Promise<SessionSummary | null> {
  const rows = await db
    .select({
      id: schema.sessions.id,
      projectId: schema.sessions.projectId,
      state: schema.sessions.state,
    })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

function toRecord(row: { adr: AdrRow; syncedAt: Date | string | null }): AdrRecord {
  return {
    adr: row.adr,
    syncedAt:
      row.syncedAt === null
        ? null
        : row.syncedAt instanceof Date
          ? row.syncedAt
          : new Date(row.syncedAt),
  };
}
