/**
 * `service_heartbeats` (TDS 03 §4.4, TDS 02 §7.2) — worker liveness.
 *
 * Workers have no HTTP surface, so each upserts one row every 30 s via the shared
 * `heartbeat` helper (`ON CONFLICT (service) DO UPDATE`). **Status is derived at read time,
 * never stored:** `healthy` < 90 s, `stale` 90 s–5 min, `down` beyond that or no row —
 * a status column would just be a second clock to keep honest.
 *
 * One hot row per service, updated in place, so the table carries `fillfactor = 90`. Drizzle
 * cannot express table storage parameters — applied by the custom migration
 * `0001_custom_include_and_fillfactor.sql`.
 *
 * Created in Phase 1 for schema stability, populated from Phase 2 when the workers exist;
 * the Backend self-reports and does not heartbeat here.
 */

import { sql } from 'drizzle-orm';
import { check, integer, jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';

/** Adding a service later (e.g. a dedicated session-runner) is a one-line CHECK alter. */
const HEARTBEAT_SERVICES = ['telegram_worker', 'sync_worker'] as const;

/** Jobs processed/failed since start. */
export interface HeartbeatStats {
  jobsProcessed?: number;
  jobsFailed?: number;
  [key: string]: unknown;
}

export const serviceHeartbeats = pgTable(
  'service_heartbeats',
  {
    id: primaryKeyId(),
    service: text('service').notNull(),
    hostname: text('hostname').notNull(),
    pid: integer('pid').notNull(),
    version: text('version'),
    stats: jsonb('stats').$type<HeartbeatStats>(),
    startedAt: timestamptz('started_at').notNull(),
    lastHeartbeatAt: timestamptz('last_heartbeat_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check(
      'ck_service_heartbeats_service',
      sql`${table.service} IN (${valueList(HEARTBEAT_SERVICES)})`,
    ),
    check('ck_service_heartbeats_pid', sql`${table.pid} > 0`),
    check('ck_service_heartbeats_stats_object', sql`jsonb_typeof(${table.stats}) = 'object'`),
    /** Upsert conflict target. */
    uniqueIndex('ux_service_heartbeats_service').on(table.service),
  ],
);
