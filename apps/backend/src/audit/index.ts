import { type Db, type DbTransaction, newId, schema } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { AuditLogService } from './query.js';
import { registerAuditRoutes } from './routes.js';

/**
 * `audit/` — the writer for `audit_log_entries` (TDS 03 §3.14, PRD §10) and the read model
 * behind `GET /api/v1/audit-log-entries`, shaped by the `AuditLogEntry` contract in TDS 04 §12.
 *
 * NOTE FOR THE CONTRACT OWNERS: TDS 02 §2's module list does not name an `audit/` module —
 * it mentions audit writes only inside `settings/`. Auth (this phase), settings and session
 * lifecycle actions all have to write the same rows (TDS 03 §3.14 "Coverage"), so the writer
 * lives here rather than being owned by whichever module happened to need it first.
 *
 * Two rules from TDS 04 §12 that this module enforces rather than documents:
 *
 *  1. **There is no `'token'` actor.** A bearer-token call is still the single local User
 *     acting, so it is recorded as `actorType: 'user'` with the acting token identified in
 *     the payload (`after.apiTokenId` / `after.apiTokenName`), never as a fourth actor type.
 *  2. **`before`/`after` never carry secret material** — no password, no cookie token, no
 *     API token value. Callers pass field subsets; this module does not introspect them. A
 *     settings secret is recorded as `{ set: true | false }` by `settings/service.ts`, per
 *     TDS 03 §3.13.
 *
 * Layout:
 *   index.ts    the writer (`recordAuditEntry`) and the module registration
 *   query.ts    the §12 read model and its filters
 *   cursors.ts  the `(createdAt, id)` ordering key behind the opaque F5.3 cursor
 *   routes.ts   `/api/v1/audit-log-entries`
 */

export * from './cursors.js';
export * from './query.js';
export * from './routes.js';

export type AuditActorType = 'user' | 'agent' | 'system';

export interface AuditEntryInput {
  readonly actorType: AuditActorType;
  /** `users.id` today, `agents.id` in Phase 4, `null` for `system`. Not an FK (TDS 03 §3.14). */
  readonly actorId?: string | null;
  /** `<domain>.<verb-past>` — e.g. `auth.login`, `token.created` (F6.1 grammar). */
  readonly action: string;
  /** F4 table name, e.g. `users`, `api_tokens`. */
  readonly entityType?: string | null;
  readonly entityId?: string | null;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  /** F5.4 `requestId`. Stored verbatim, truncated to the column bound — see `auditableRequestId`. */
  readonly requestId?: string | null;
  readonly ipAddress?: string | null;
}

/**
 * F5.4 honours an inbound `X-Request-Id` so a hook POST or CLI client can carry its own
 * correlation id (see `http/generateRequestId`), and those are frequently not UUIDs.
 * `audit_log_entries.request_id` is therefore `text` bounded to 1–128 characters, not `uuid`
 * (TDS 03 §3.14, corrected 2026-08-12) — an earlier `uuid` column forced a choice between
 * failing the audit insert and storing NULL, and NULL loses the correlation in exactly the
 * externally-originated case that most needs it.
 *
 * Ids are stored verbatim. The generator already caps inbound values at 128 characters; this
 * clamps defensively so a caller bypassing that path cannot turn an audit write into a
 * constraint violation. Empty/whitespace-only normalises to NULL so "absent" has one form.
 */
const REQUEST_ID_MAX_LENGTH = 128;

export function auditableRequestId(requestId: string | null | undefined): string | null {
  if (typeof requestId !== 'string') return null;
  const trimmed = requestId.trim();
  if (trimmed.length === 0) return null;
  return trimmed.slice(0, REQUEST_ID_MAX_LENGTH);
}

/**
 * Append one audit row. Accepts a transaction handle so an audited write and its audit row
 * commit together; callers with nothing to be atomic with pass the plain `Db`.
 */
export async function recordAuditEntry(
  db: Db | DbTransaction,
  entry: AuditEntryInput,
): Promise<string> {
  const id = newId();

  await db.insert(schema.auditLogEntries).values({
    id,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    action: entry.action,
    entityType: entry.entityType ?? null,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    requestId: auditableRequestId(entry.requestId),
    ipAddress: entry.ipAddress ?? null,
  });

  return id;
}

export interface RegisterAuditLogOptions {
  readonly db: Db;
}

/** Registers the §12 read routes. The writer is a function, not a service — it has no state. */
export function registerAuditLog(
  app: FastifyInstance,
  options: RegisterAuditLogOptions,
): AuditLogService {
  const audit = new AuditLogService({ db: options.db });
  registerAuditRoutes(app, { audit });
  return audit;
}
