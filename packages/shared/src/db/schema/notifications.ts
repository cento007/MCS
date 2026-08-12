/**
 * `notifications` (TDS 03 §4.2, Phase 2) — the in-app record AND the Telegram delivery
 * ledger in one row.
 *
 * `type` is the WS2 §8 notification-type enum, NOT an F6 event name (arbitration A8 /
 * finding B10): `daily_report` and `cost_budget_alert` have no originating event. Where one
 * exists its F6 type rides in `payload.eventType`.
 */

import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';

const NOTIFICATION_TYPES = [
  'session_completed',
  'session_failed',
  'sync_failed',
  'repository_problem',
  'daily_report',
  'cost_budget_alert',
] as const;

const NOTIFICATION_SEVERITIES = ['info', 'warning', 'error'] as const;

/** `skipped` when Telegram is disabled or the event type is toggled off (PRD §4.4.3). */
const TELEGRAM_STATUSES = ['skipped', 'pending', 'sent', 'failed'] as const;

/** Entity IDs for deep links plus `eventType` (F6.2: IDs, never full entities). */
export interface NotificationPayload {
  eventType?: string;
  [key: string]: unknown;
}

export const notifications = pgTable(
  'notifications',
  {
    id: primaryKeyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    payload: jsonb('payload').$type<NotificationPayload>(),
    /** F6.2 correlationId of the originating chain (finding B8). No FK — it names an envelope. */
    correlationId: uuid('correlation_id'),
    /** NULL = unread. */
    readAt: timestamptz('read_at'),
    telegramStatus: text('telegram_status').notNull().default('skipped'),
    telegramSentAt: timestamptz('telegram_sent_at'),
    telegramError: text('telegram_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_notifications_type', sql`${table.type} IN (${valueList(NOTIFICATION_TYPES)})`),
    check(
      'ck_notifications_severity',
      sql`${table.severity} IN (${valueList(NOTIFICATION_SEVERITIES)})`,
    ),
    check(
      'ck_notifications_telegram_status',
      sql`${table.telegramStatus} IN (${valueList(TELEGRAM_STATUSES)})`,
    ),
    /** Unread badge/list: hot subset, partial index. */
    index('ix_notifications_unread')
      .on(table.userId, sql`${table.createdAt} DESC`)
      .where(sql`${table.readAt} IS NULL`),
    index('ix_notifications_user_created').on(table.userId, sql`${table.createdAt} DESC`),
  ],
);
