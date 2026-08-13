/**
 * Drizzle schema — the DDL source of truth (F1.4, TDS 03 §8).
 *
 * `docs/tds/03-database-schema.md` (WS3) is the contract; the definitions re-exported below
 * express it, and `packages/shared/drizzle/*.sql` is what actually runs. 20 Phase 1–2 tables
 * (TDS 03 §9 inventory) plus `memory_items` — designed in Phase 3, which is the phase TDS 03 §6
 * deferred it to — and the two remaining Phase 4 skeletons (`agents`, `agent_teams`).
 *
 * Rules that bind every module here (TDS 03 §1, F4.2):
 *   - snake_case, plural table names, FKs as `<entity>_id`
 *   - UUIDv7 primary keys generated in application code, stored as PostgreSQL `uuid`
 *   - `timestamptz` only, UTC; every table carries `created_at` and `updated_at`
 *   - enum-like values are lowercase snake_case `text` with CHECK constraints
 *   - drizzle-kit is scoped to the `public` schema; the `pgboss` schema is vendored and must
 *     never be touched by a generated migration (TDS 03 §7.1)
 *
 * **Two things in the contract are not expressible in Drizzle's schema builder** and live in
 * the custom migration `drizzle/0001_custom_include_and_fillfactor.sql` instead. They are
 * real objects in the database and must not be re-declared here:
 *   1. `ix_sessions_started_at ... INCLUDE (total_cost_usd)` (TDS 03 §3.9) — no INCLUDE support.
 *   2. `fillfactor = 90` on `transcript_tail_states` and `service_heartbeats`
 *      (TDS 03 §3.15, §4.4) — no table storage parameter support.
 */

export * from './audit.js';
export * from './auth.js';
export * from './columns.js';
export * from './git.js';
export * from './knowledge.js';
export * from './memory.js';
export * from './notifications.js';
export * from './ops.js';
export * from './projects.js';
export * from './sessions.js';
export * from './settings.js';
export * from './skeletons.js';
export * from './sync.js';
