import { QUEUE_NAMES } from './names.js';
import type { QueueDefinition } from './pg-boss.js';

/**
 * Queue definitions **shared between processes that provision the same queue**.
 *
 * pg-boss's `createQueue` is `ON CONFLICT DO NOTHING` and `updateQueue` converges an existing
 * row, so when two processes provision the same queue with *different* definitions the one that
 * started most recently silently wins. That is a real hazard here: the Backend produces
 * `notification.deliver` jobs and the Telegram Worker consumes them, so both must provision it,
 * and a Backend restart must not quietly halve the worker's retry budget.
 *
 * Declaring them once removes the possibility. A queue only one process ever touches
 * (`session.launch`, `github.poll`, …) stays with that process.
 */

/**
 * `events` — every F6 domain event, enqueued transactionally with its domain write (F6.3).
 *
 * Retries with exponential backoff, because a consumer failure is nearly always transient and
 * the alternative is losing a notification.
 */
export const EVENTS_QUEUE: QueueDefinition = Object.freeze({
  name: QUEUE_NAMES.EVENTS,
  retryLimit: 5,
  retryDelaySeconds: 2,
  retryBackoff: true,
});

/**
 * `notification.deliver` — one Notification's Telegram delivery.
 *
 * `retryLimit: 2`, not five, and the reason matters: the worker's handler does **not** throw
 * for a Telegram condition. A rejected token, a missing chat and a `429` are recorded on the
 * `notifications` row, and the `429`'s retry is re-enqueued by the handler itself using
 * Telegram's own `retry_after`. pg-boss's budget therefore covers only what the handler cannot
 * record — the database going away mid-write, and a shutdown that interrupted a send.
 *
 * `expireInSeconds: 120` against the client's 10 s HTTP bound. The gap is deliberate: a lease
 * that could expire mid-send would let the job be fetched again and produce a duplicate
 * message, which is the one duplication the row-status guard cannot catch.
 */
export const NOTIFICATION_DELIVER_QUEUE: QueueDefinition = Object.freeze({
  name: QUEUE_NAMES.NOTIFICATION_DELIVER,
  retryLimit: 2,
  retryDelaySeconds: 10,
  retryBackoff: true,
  expireInSeconds: 120,
});

/**
 * `notification.schedule` — the daily-report tick.
 *
 * `retryLimit: 0`, exactly as `github.poll`: the tick enqueues its own successor before it
 * returns, so a pg-boss retry would create a *second* chain running beside the first. A failed
 * tick is better dropped — the next one is at most a minute away and recomputes everything from
 * settings.
 */
export const NOTIFICATION_SCHEDULE_QUEUE: QueueDefinition = Object.freeze({
  name: QUEUE_NAMES.NOTIFICATION_SCHEDULE,
  retryLimit: 0,
  expireInSeconds: 120,
});

/**
 * `obsidian.sync` — one vault sync run. Provisioned by the Backend (which produces the job
 * from `POST /sync-runs`) and by the Sync Worker (which consumes it), so the definition is
 * declared once here for the same reason `notification.deliver` is.
 *
 * **`retryLimit: 0`, and that is the interesting decision.** A redelivered sync job is not
 * free: it re-scans the vault and re-evaluates every conflict, and the run row it names has
 * already been moved out of `queued` by the first attempt, so the retry can only no-op or —
 * worse, if the state check were ever relaxed — sync the vault twice. Every failure mode the
 * handler can see is recorded on the `sync_runs` row instead (`state = 'failed'`, `error`), and
 * the next scheduled tick is at most one interval away. A failed sync is not a lost sync.
 *
 * `expireInSeconds: 1800` because a first sync of a large vault is minutes of file I/O, and a
 * lease that expired mid-run would hand a second worker write access to the same files.
 */
export const OBSIDIAN_SYNC_QUEUE: QueueDefinition = Object.freeze({
  name: QUEUE_NAMES.OBSIDIAN_SYNC,
  retryLimit: 0,
  expireInSeconds: 1_800,
});

/**
 * `adr.generate` — draft an ADR from a Session (TDS 04 §9).
 *
 * Two retries: the handler's only failure mode is the database going away mid-write, and it is
 * idempotent on `adrs.source_session_id`, so a retry that lands after a successful attempt
 * finds the ADR already there and stops.
 */
export const ADR_GENERATE_QUEUE: QueueDefinition = Object.freeze({
  name: QUEUE_NAMES.ADR_GENERATE,
  retryLimit: 2,
  retryDelaySeconds: 10,
  retryBackoff: true,
  expireInSeconds: 300,
});
