import {
  ADR_GENERATE_QUEUE,
  createPgBossQueue,
  EVENTS_QUEUE,
  NOTIFICATION_DELIVER_QUEUE,
  OBSIDIAN_SYNC_QUEUE,
  type PgBossQueue,
  QUEUE_NAMES,
} from '@mc/shared';

/**
 * `queue/` — the Backend's QueuePort wiring (TDS 02 §2).
 *
 * Startup order is fixed and not negotiable (TDS 03 §7.1): drizzle migrations first, then
 * `boss.start()` (pg-boss migrates its own vendored `pgboss` schema), then the service accepts
 * work. The Backend is the sole app-migration runner; workers only call `start()`/`work()`.
 *
 * The `session.launch` consumer itself lives with the thing that owns concurrency —
 * `sessions/manager.ts` (TDS 02 §2 names it in both places; the registry is where the
 * semaphore is, so that is where the consumer belongs).
 */

/**
 * Queue definitions for the Backend.
 *
 * `events` and `notification.deliver` come from `@mc/shared` because the Telegram Worker
 * provisions the same two: pg-boss's `updateQueue` converges an existing definition, so two
 * processes declaring different policies would let whichever restarted last silently win.
 *
 * `session.launch` — durable launch requests (TDS 02 §4.3). `expireInSeconds` is generous on
 * purpose: the consumer's handler *waits* for a concurrency slot, and a lease shorter than a
 * plausible wait would keep re-delivering a launch that is patiently queued. Beyond that
 * window the job is redelivered, which is the correct outcome for a genuinely stuck launch.
 */
export const BACKEND_QUEUES = Object.freeze([
  EVENTS_QUEUE,
  /**
   * `notification.deliver` — the Backend **produces** these jobs (`notifications/produce.ts`)
   * and the Telegram Worker consumes them. It is provisioned here because pg-boss 10+ refuses
   * to send to a queue that does not exist, and a Notification must be producible whether or
   * not the worker has ever been started. The definition is shared so the two processes cannot
   * converge on different retry policies.
   */
  NOTIFICATION_DELIVER_QUEUE,
  Object.freeze({
    name: QUEUE_NAMES.SESSION_LAUNCH,
    retryLimit: 3,
    retryDelaySeconds: 5,
    retryBackoff: true,
    expireInSeconds: 3600,
  }),
  /**
   * `session.prompt.retry` — rate-limited turns (TDS 02 §4.3). The **delay** is on the job
   * (`startAfterSeconds`), computed per attempt with jitter by the scheduler, because the wait
   * is a property of that turn's backoff and not of the queue. pg-boss's own retry policy stays
   * short here and covers a different failure: the retry handler itself erroring.
   */
  Object.freeze({
    name: QUEUE_NAMES.SESSION_PROMPT_RETRY,
    retryLimit: 2,
    retryDelaySeconds: 5,
    retryBackoff: true,
    expireInSeconds: 600,
  }),
  /**
   * `repository.sync` — one repository's GitHub sync (TDS 04 §5.1).
   *
   * Two retries, not five: the failures this job actually sees are a rejected token, a deleted
   * remote and an exhausted rate limit, and none of them gets better by being retried a minute
   * later. They are recorded on the row (`sync_status`, `last_sync_error`) by the handler
   * itself rather than thrown, so pg-boss's retry budget covers only the *infrastructure*
   * failure — a dropped connection mid-transaction — which two attempts is plenty for.
   */
  Object.freeze({
    name: QUEUE_NAMES.REPOSITORY_SYNC,
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    expireInSeconds: 900,
  }),
  /**
   * `github.poll` — the polling tick.
   *
   * `retryLimit: 0` is deliberate. The tick reschedules itself at the end of every run, so a
   * pg-boss retry would create a *second* chain running alongside the first; a failed tick is
   * better dropped, because the next one is already scheduled and will pick up every repository
   * the failed one missed (they are ordered by `last_synced_at NULLS FIRST`).
   */
  Object.freeze({
    name: QUEUE_NAMES.GITHUB_POLL,
    retryLimit: 0,
    expireInSeconds: 3600,
  }),
  /**
   * `obsidian.sync` and `adr.generate` — both **produced** here and **consumed** by the Sync
   * Worker. Provisioned because pg-boss 10+ refuses to send to a queue that does not exist, so
   * `POST /sync-runs` and `POST /sessions/{id}/generate-adr` must work whether or not the
   * worker has ever been started; the definitions are shared so the two processes cannot
   * converge on different retry policies.
   */
  OBSIDIAN_SYNC_QUEUE,
  ADR_GENERATE_QUEUE,
  /**
   * `memory.index` — indexing one source, one backfill slice, or one purge (PRD §6.3).
   *
   * Produced *and* consumed here; see `QUEUE_NAMES.MEMORY_INDEX` for why the Backend and not
   * the Sync Worker.
   *
   * **`retryLimit: 0`, deliberately, and it is the interesting decision.** Every failure this
   * handler can see is already recorded as data — a source-level failure lands on the backfill
   * run's `failures`/`lastError`, and a dependency failure halts the run with a reason on the
   * row — so a pg-boss retry could only repeat work that will fail identically. Worse, the
   * backfill slice **enqueues its own successor**, exactly like `github.poll`: a retry of a
   * slice that had already enqueued its continuation would fork the sweep into two chains
   * racing over the same cursor. Nothing is lost by dropping a failed job: the run row holds
   * the cursor, and the next trigger resumes from it.
   *
   * `expireInSeconds: 900` against a slice of `BACKFILL_BATCH_SIZE` sources. Generous, because
   * a cold Ollama takes seconds to load its weights before the first batch of a run answers,
   * and a lease that expired mid-slice would hand a second delivery the same cursor.
   */
  Object.freeze({
    name: QUEUE_NAMES.MEMORY_INDEX,
    retryLimit: 0,
    expireInSeconds: 900,
  }),
  /**
   * `memory.retention` — the per-tier expiry sweep (`memory/retention.ts`).
   *
   * `retryLimit: 0`, exactly as `github.poll` and for the identical reason: the tick enqueues
   * its own successor before it returns, so a pg-boss retry would create a second chain running
   * beside the first. A dropped tick costs nothing — the next one recomputes every cutoff from
   * settings and deletes whatever the failed one did not.
   *
   * `expireInSeconds: 600` against a bounded batch of `MEMORY_RETENTION_BATCH` deletions plus
   * one `deleteByFilter` round trip to the vector store.
   */
  Object.freeze({
    name: QUEUE_NAMES.MEMORY_RETENTION,
    retryLimit: 0,
    expireInSeconds: 600,
  }),
  /**
   * `agent_workflow.advance` — move a workflow run to its next step (PRD §5.6).
   *
   * Produced *and* consumed here; see `QUEUE_NAMES.AGENT_WORKFLOW_ADVANCE` for why the Backend
   * and not a worker.
   *
   * **`retryLimit: 0`, and the reason is the same one `memory.index` gives with one addition.**
   * Every failure this handler can see is already recorded as data — a step that cannot be
   * launched **halts the run** with a reason the operator can read and resume from — so a pg-boss
   * retry could only repeat work that will fail identically. The addition is that a retry is not
   * merely useless here, it is *expensive*: the handler creates a Claude Code Session, so a
   * redelivery that raced the run's own state would spend money twice. The run's own budget
   * (`ck_agent_workflow_runs_sessions_launched`) is the backstop; dropping the job is the policy.
   *
   * `expireInSeconds: 300` against one context package (bounded at 25 s of memory plus 10 s of
   * git by `sessions/export/service.ts`) and one Session spawn.
   */
  Object.freeze({
    name: QUEUE_NAMES.AGENT_WORKFLOW_ADVANCE,
    retryLimit: 0,
    expireInSeconds: 300,
  }),
]);

export interface CreateBackendQueueOptions {
  readonly connectionString: string;
  readonly onError?: (error: Error) => void;
  readonly onWarning?: (warning: unknown) => void;
  /** Tests drop this to keep the launch queue responsive without waiting out a poll. */
  readonly pollingIntervalSeconds?: number;
  readonly supervise?: boolean;
  readonly schedule?: boolean;
}

export function createBackendQueue(options: CreateBackendQueueOptions): PgBossQueue {
  return createPgBossQueue({
    connectionString: options.connectionString,
    queues: BACKEND_QUEUES,
    // Single-node, single-operator: pg-boss needs very few connections of its own.
    maxConnections: 4,
    ...(options.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: options.pollingIntervalSeconds }),
    ...(options.supervise === undefined ? {} : { supervise: options.supervise }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
  });
}
