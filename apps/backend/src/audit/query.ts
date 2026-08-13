import { type Db, type IsoTimestamp, schema } from '@mc/shared';
import { and, desc, eq, gte, lt, lte, or, type SQL, sql } from 'drizzle-orm';
import { ApiError } from '../http/errors.js';
import type { AuditCursor } from './cursors.js';

/**
 * The `audit_log_entries` read model (TDS 04 §12) — the "View audit log →" target.
 *
 * Read-only by construction: there is no writer here (that is `recordAuditEntry`), no update
 * and no delete. The table is append-only and pruned by retention (`security.
 * auditLogRetentionDays`), never edited — an audit log an operator can edit is not one.
 */

/** §12, verbatim. `occurredAt` is `created_at`; `ipAddress` is stored but not exposed. */
export interface AuditLogEntryResource {
  readonly id: string;
  readonly occurredAt: IsoTimestamp;
  readonly actorType: 'user' | 'agent' | 'system';
  readonly actorId: string | null;
  readonly action: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
  readonly requestId: string | null;
}

export interface ListAuditFilters {
  readonly limit: number;
  readonly after?: AuditCursor | undefined;
  readonly action?: string | undefined;
  readonly actorType?: string | undefined;
  readonly entityType?: string | undefined;
  readonly entityId?: string | undefined;
  /** Inclusive lower bound on `occurredAt`. */
  readonly from?: Date | undefined;
  /** Inclusive upper bound on `occurredAt`. */
  readonly to?: Date | undefined;
}

type AuditRow = typeof schema.auditLogEntries.$inferSelect;

function toResource(row: AuditRow): AuditLogEntryResource {
  return {
    id: row.id,
    occurredAt: row.createdAt.toISOString(),
    actorType: row.actorType as AuditLogEntryResource['actorType'],
    actorId: row.actorId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    // `before`/`after` are stored already redacted — a secret write records `{ set: true }`
    // and never a value (TDS 03 §3.13). This projection adds no filtering of its own, because
    // filtering *here* would imply the rows might contain something that needs filtering.
    before: row.before ?? null,
    after: row.after ?? null,
    requestId: row.requestId,
  };
}

export class AuditLogService {
  readonly #db: Db;

  constructor(options: { readonly db: Db }) {
    this.#db = options.db;
  }

  async list(filters: ListAuditFilters): Promise<readonly AuditLogEntryResource[]> {
    const conditions: SQL[] = [];

    if (filters.action !== undefined) {
      conditions.push(eq(schema.auditLogEntries.action, filters.action));
    }
    if (filters.actorType !== undefined) {
      conditions.push(eq(schema.auditLogEntries.actorType, filters.actorType));
    }
    if (filters.entityType !== undefined) {
      conditions.push(eq(schema.auditLogEntries.entityType, filters.entityType));
    }
    if (filters.entityId !== undefined) {
      conditions.push(eq(schema.auditLogEntries.entityId, filters.entityId));
    }
    if (filters.from !== undefined) {
      conditions.push(gte(schema.auditLogEntries.createdAt, filters.from));
    }
    if (filters.to !== undefined) {
      conditions.push(lte(schema.auditLogEntries.createdAt, filters.to));
    }

    if (filters.after !== undefined) {
      // Keyset pagination on `(created_at DESC, id DESC)`: strictly older, or the same instant
      // with a smaller id. Written as an explicit OR rather than a row-value comparison so the
      // index on `created_at` is usable either way.
      const { occurredAt, id } = filters.after;
      const older = lt(schema.auditLogEntries.createdAt, occurredAt);
      const sameInstant = and(
        eq(schema.auditLogEntries.createdAt, occurredAt),
        lt(schema.auditLogEntries.id, id),
      );
      const keyset = or(older, sameInstant);
      if (keyset !== undefined) conditions.push(keyset);
    }

    const where = conditions.length === 0 ? undefined : and(...conditions);

    const rows = await this.#db
      .select()
      .from(schema.auditLogEntries)
      .where(where)
      .orderBy(desc(schema.auditLogEntries.createdAt), desc(schema.auditLogEntries.id))
      .limit(filters.limit);

    return rows.map(toResource);
  }

  async get(id: string): Promise<AuditLogEntryResource> {
    const rows = await this.#db
      .select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.id, id))
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw new ApiError('NOT_FOUND', `Audit log entry ${id} does not exist`);
    return toResource(row);
  }
}

/**
 * Parse an ISO instant from a query string.
 *
 * @throws {ApiError} `VALIDATION_FAILED` — a `?from=` nobody can parse must not silently widen
 * the window to "everything"; that is the one direction in which an audit filter must never
 * fail open.
 */
export function parseInstant(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError('VALIDATION_FAILED', `\`${field}\` is not an ISO 8601 timestamp`, {
      field,
    });
  }
  return parsed;
}

/** Diagnostics only: the count behind the current filter set is not part of §12's contract. */
export async function countAuditEntries(db: Db): Promise<number> {
  const rows = await db.select({ total: sql<number>`count(*)::int` }).from(schema.auditLogEntries);
  return rows[0]?.total ?? 0;
}
