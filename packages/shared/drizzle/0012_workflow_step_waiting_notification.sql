-- "A workflow step is waiting for you" — a seventh notification type, and the column that stops it
-- being sent twice.
--
-- A managed Session is never auto-completed (F7 keeps `completed` reachable only by an explicit
-- `end`, trigger `user`), so a PRD §5.6 chain advances when a human ends each step's Session. That
-- is the intended design and not a gap — but until now the only way to learn a step was waiting was
-- to be looking at the run view. `workflow_step_waiting` is the page that closes it. It is not
-- auto-advance: nothing here ends a Session, and the operator remains the only thing that does.
--
-- **`waiting_notified_at` is the dedupe anchor, and it is claimed before the Notification is
-- written.** A step's Session goes idle at the end of *every* turn, so without a claim an operator
-- who answered a question inside a step would be paged again the moment that answer's turn ended.
-- The claim is a conditional UPDATE (`… WHERE waiting_notified_at IS NULL`), which is the same
-- construction `prompt_sent_at` uses two columns above and for the same reason: it cannot fire
-- twice, and a crash inside the window loses the page rather than duplicating it. A lost page is
-- recoverable — the run view still shows the step waiting — and a duplicate is not.
--
-- It is nullable with no CHECK: there is nothing to constrain. "Not yet notified" and "the
-- operator switched the toggle off, so it never will be" are both NULL, and inventing a value to
-- distinguish them would be a field that claims to know why.
ALTER TABLE "agent_workflow_run_steps" ADD COLUMN "waiting_notified_at" timestamp with time zone;--> statement-breakpoint

-- `ck_notifications_type` is generated from `NOTIFICATION_TYPES`, so widening the vocabulary is a
-- drop and re-add of the same constraint. No row can violate it: the new value has no producer
-- before this migration.
ALTER TABLE "notifications" DROP CONSTRAINT "ck_notifications_type";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "ck_notifications_type" CHECK ("notifications"."type" IN ('session_completed', 'session_failed', 'sync_failed', 'repository_problem', 'daily_report', 'cost_budget_alert', 'workflow_step_waiting'));
