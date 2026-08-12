/**
 * `audit_log_entries` (TDS 03 §3.14, PRD §10) — append-only.
 *
 * `actor_id` is deliberately NOT an FK: it is polymorphic (`users.id` today, `agents.id` in
 * Phase 4, NULL for `system`) and audit rows must survive actor deletion. `request_id` is the
 * F5.4 `requestId` / `X-Request-Id`, correlating an audit row with API logs and the F6.2
 * `correlationId` chain.
 *
 * Retention: the `security.audit_log_retention_days` setting drives a periodic pg-boss
 * pruning job; the BRIN index keeps that cheap.
 */

import { sql } from 'drizzle-orm';
import { check, index, inet, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, updatedAt, valueList } from './columns.js';

const AUDIT_ACTOR_TYPES = ['user', 'agent', 'system'] as const;

export const auditLogEntries = pgTable(
  'audit_log_entries',
  {
    id: primaryKeyId(),
    actorType: text('actor_type').notNull(),
    /** `users.id` / `agents.id` (Phase 4); NULL for system. */
    actorId: uuid('actor_id'),
    /** `<domain>.<verb-past>`, e.g. 'setting.updated', 'auth.login'. WS2 §3.1 owns the registry. */
    action: text('action').notNull(),
    /** F4 table name, e.g. 'settings', 'sessions'. */
    entityType: text('entity_type'),
    entityId: uuid('entity_id'),
    /** Relevant field subset; NULL for creates. Never contains secret material. */
    before: jsonb('before').$type<Record<string, unknown>>(),
    /** Relevant field subset; NULL for deletes. Never contains secret material. */
    after: jsonb('after').$type<Record<string, unknown>>(),
    /**
     * F5.4 requestId correlation. `text`, not `uuid`: F5.4 honours an inbound `X-Request-Id`
     * so an external caller (a Claude Code hook POST) can supply its own correlation id, and
     * those are frequently not UUIDs. A `uuid` column forced a choice between failing the
     * audit insert and storing NULL — and NULL loses the correlation in exactly the
     * externally-originated case that most needs it. Ids we generate are UUIDv7 strings.
     */
    requestId: text('request_id'),
    ipAddress: inet('ip_address'),
    createdAt: createdAt(),
    /** Convention only (F4.2); rows are append-only. */
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'ck_audit_log_entries_actor_type',
      sql`${table.actorType} IN (${valueList(AUDIT_ACTOR_TYPES)})`,
    ),
    check(
      'ck_audit_log_entries_request_id',
      sql`${table.requestId} IS NULL OR length(${table.requestId}) BETWEEN 1 AND 128`,
    ),
    index('ix_audit_entity').on(table.entityType, table.entityId, sql`${table.createdAt} DESC`),
    index('ix_audit_actor').on(table.actorType, table.actorId, sql`${table.createdAt} DESC`),
    /** Insert-ordered append-only table: BRIN gives near-free time-range scans. */
    index('ix_audit_created_at_brin').using('brin', table.createdAt),
  ],
);
