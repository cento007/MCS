-- Phase 3: `sync_runs` gains a second kind, `memory_index`.
--
-- The memory backfill needs a durable, resumable, single-active run record. `sync_runs` already
-- is one, and `ux_sync_runs_active` is a partial unique index over `state IN ('queued','running')`
-- **per kind** — so widening the CHECK buys "at most one active backfill" as a database
-- guarantee, for free, from an index that is already there and already tested. A parallel
-- `memory_index_runs` table would have been a second implementation of the same guard.
--
-- Every existing read of this table is already `kind`-filtered (`findActiveSyncRun`,
-- `listSyncRuns`, `findLatestSyncRun`), so `GET /sync-runs` continues to mean Obsidian runs and
-- TDS 04 §10 is unchanged. `reclaimAbandonedSyncRuns` gained a `kind` argument in the same
-- change, because the Sync Worker reclaiming a live memory backfill would kill it.
--
-- Dropping and re-adding the CHECK is a metadata-only operation here: the new predicate is
-- strictly weaker, so PostgreSQL re-validates rows that all satisfy it.

ALTER TABLE "sync_runs" DROP CONSTRAINT "ck_sync_runs_kind";--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "ck_sync_runs_kind" CHECK ("sync_runs"."kind" IN ('obsidian', 'memory_index'));