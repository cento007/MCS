-- Custom SQL migration file, put your code below! --

-- Everything in this file is part of the TDS 03 contract but is NOT expressible in
-- Drizzle's schema builder, so it is carried here (TDS 03 §8: "partial indexes,
-- lower(...) expression indexes, BRIN, and multi-column CHECKs that drizzle-kit cannot
-- express are added via drizzle-kit custom migrations ... never applied out-of-band").
-- Drizzle DOES express partial/expression/BRIN/GIN indexes, generated columns and
-- table-level CHECKs in 0000 — only the two items below need hand-written SQL.

--------------------------------------------------------------------------------
-- 1. TDS 03 §3.9 — ix_sessions_started_at (WS2 §7.8 `GET /api/v1/spend`)
--------------------------------------------------------------------------------
-- Drizzle's index builder has no INCLUDE support. The covering column is the point of
-- this index: it makes the month-range `sum(total_cost_usd)` scan index-only. The
-- partial predicate excludes exactly the rows the aggregate ignores (a Session that
-- never started carries no cost).
--
-- NOT declared in `src/db/schema/sessions.ts` — adding it there would generate a
-- second, INCLUDE-less index with the same name.
CREATE INDEX "ix_sessions_started_at" ON "sessions" ("started_at" DESC)
  INCLUDE ("total_cost_usd")
  WHERE "started_at" IS NOT NULL;
--> statement-breakpoint

--------------------------------------------------------------------------------
-- 2. TDS 03 §3.15 / §4.4 — fillfactor = 90 on the two update-heavy tables
--------------------------------------------------------------------------------
-- Drizzle cannot express table storage parameters (`WITH (fillfactor = 90)` in the
-- document's `CREATE TABLE`). `ALTER TABLE ... SET` reaches the identical reloption.
--
-- `transcript_tail_states` is rewritten on every tailer read burst and
-- `service_heartbeats` on every 30 s worker upsert; both update only non-indexed
-- columns, so leaving 10% free space per page lets those updates stay HOT.
ALTER TABLE "transcript_tail_states" SET (fillfactor = 90);
--> statement-breakpoint
ALTER TABLE "service_heartbeats" SET (fillfactor = 90);
