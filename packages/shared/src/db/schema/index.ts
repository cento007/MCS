/**
 * Drizzle schema — the DDL source of truth (F1.4, TDS 03 §8).
 *
 * SCAFFOLD STATE: DELIBERATELY EMPTY.
 *
 * WS3 owns every table definition. The complete, implementation-ready DDL for all 20
 * Phase 1–2 tables plus the three Phase 3/4 skeleton tables lives in
 * `docs/tds/03-database-schema.md`; the Drizzle definitions that generate equivalent DDL
 * land there, one file per table group, alongside the generated SQL migrations in
 * `packages/shared/drizzle/`.
 *
 * Rules that already bind whoever writes them (TDS 03 §1, F4.2):
 *   - snake_case, plural table names, FKs as `<entity>_id`
 *   - UUIDv7 primary keys generated in application code, stored as PostgreSQL `uuid`
 *   - `timestamptz` only, UTC; every table carries `created_at` and `updated_at`
 *   - enum-like values are lowercase snake_case `text` with CHECK constraints
 *   - drizzle-kit is scoped to the `public` schema; the `pgboss` schema is vendored
 *     and must never be touched by a generated migration (TDS 03 §7.1)
 */

// Re-export table definitions here as WS3 adds them, e.g.:
//   export * from './sessions.js';
export {};
