import {
  type Heartbeat,
  type Logger,
  QUEUE_NAMES,
  type QueueConsumerPort,
  type Unsubscribe,
} from '@mc/shared';
import type { AdrGenerationJob, AdrGenerationResult } from './adr-generation.js';
import type { ScheduleTickJob, TickSummary } from './schedule.js';
import type { SyncJob, SyncResult } from './sync.js';

/**
 * Sync Worker core (TDS 02 §2.2).
 *
 * What the shape enforces, and must keep enforcing:
 *   - the worker talks to the Backend ONLY through the queue (F2.2) — no HTTP client pointed at
 *     the Backend, no import of any Backend module;
 *   - delivery is at-least-once, so every handler is idempotent — the anchors are the
 *     `sync_runs` row state and `adrs.source_session_id`, never the job id;
 *   - the process exposes no port; health is derived from the heartbeat row (TDS 02 §7.2);
 *   - **this process is the only writer of the operator's vault.**
 *
 * ## The three subscriptions — and the one that is deliberately absent
 *
 * | Queue               | Why this worker has it                                     |
 * |---------------------|------------------------------------------------------------|
 * | `obsidian.sync`     | one vault sync run (TDS 04 §10)                            |
 * | `obsidian.schedule` | the self-rescheduling interval tick (§7.7)                  |
 * | `adr.generate`      | draft an ADR from a Session (§9)                            |
 *
 * **`events` is not in that table.** TDS 04 §15.2 lists this worker as a consumer of
 * `setting.updated`, `adr.created` and `adr.updated` on the shared `events` queue, but pg-boss
 * is a competing-consumer substrate: one job reaches exactly one subscriber, and the Telegram
 * Worker already drains that queue. Two subscribers would steal each other's envelopes. See
 * `queue.ts` for the full note and for why nothing is lost by not subscribing.
 *
 * ## Outbound: `sync.*` and `adr.created` do reach the browser
 *
 * Everything this worker emits goes through `WorkerOutbox`, which enqueues the durable job
 * **and** raises a `pg_notify` on the same transaction (TDS 04 §15.1). The Backend's
 * `events/relay.ts` listens on that channel and injects the envelope into its in-process bus,
 * so `sync.started` / `sync.completed` / `sync.failed` / `sync.conflict_detected` land on the
 * `sync` WebSocket channel exactly as a Backend-produced event would. That path is fan-out,
 * not a queue: `NOTIFY` is broadcast to every listening session and has nothing to claim, so it
 * cannot be raced the way a shared `events` subscription would be.
 *
 * ## Shutdown
 *
 * `offWork` waits for the in-flight handler, so the abort must come **first**. A sync run can
 * be minutes of file I/O; the engine checks the abort signal between files and returns, the
 * run is failed with `interrupted`, and the next run resumes from the ledger. Parking a
 * consumer on something that never completes is how a worker becomes unkillable — the Session
 * registry learned that the hard way, and the same rule is applied here.
 */

export interface SyncPort {
  runOne(job: SyncJob, signal?: AbortSignal): Promise<SyncResult>;
}

export interface SchedulerPort {
  tick(): Promise<TickSummary>;
  setStopping(stopping: boolean): void;
}

export interface AdrGenerationPort {
  generate(job: AdrGenerationJob): Promise<AdrGenerationResult>;
}

export interface WorkerOptions {
  readonly queue: QueueConsumerPort;
  readonly logger: Logger;
  readonly sync: SyncPort;
  readonly scheduler: SchedulerPort;
  readonly adrs: AdrGenerationPort;
  readonly heartbeat?: Heartbeat;
  /** Aborted first on `stop()`, so an in-flight sync cannot hold shutdown open. */
  readonly shutdown?: AbortController;
  /** Prime the scheduler chain on start. Default `true`; tests turn it off. */
  readonly tickOnStart?: boolean;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Jobs processed / failed since start — the `stats` column of the heartbeat row. */
  stats(): Readonly<Record<string, number>>;
}

/** Queues this worker consumes (see the table above). */
export const SUBSCRIBED_QUEUES: readonly string[] = Object.freeze([
  QUEUE_NAMES.OBSIDIAN_SYNC,
  QUEUE_NAMES.OBSIDIAN_SCHEDULE,
  QUEUE_NAMES.ADR_GENERATE,
]);

export function createWorker(options: WorkerOptions): Worker {
  const { queue, logger, sync, scheduler, adrs, heartbeat } = options;
  const unsubscribes: Unsubscribe[] = [];

  let running = false;
  let jobsProcessed = 0;
  let jobsFailed = 0;
  let syncRuns = 0;
  let notesExported = 0;
  let notesImported = 0;
  let conflicts = 0;
  let adrsDrafted = 0;

  const stats = (): Readonly<Record<string, number>> => ({
    jobsProcessed,
    jobsFailed,
    syncRuns,
    notesExported,
    notesImported,
    conflicts,
    adrsDrafted,
  });

  const handleSync = async (job: SyncJob, signal: AbortSignal): Promise<void> => {
    try {
      const result = await sync.runOne(job, signal);
      jobsProcessed += 1;
      if (result.kind !== 'ignored') syncRuns += 1;
      notesExported += result.stats.notesExported;
      notesImported += result.stats.notesImported;
      conflicts += result.stats.conflicts;
    } catch (error) {
      jobsFailed += 1;
      // The run row was already failed by `SyncService`; this is for the process log. The queue
      // does not retry (`retryLimit: 0`) — the next scheduled tick is the recovery path.
      logger.error({ err: error, syncRunId: job.syncRunId }, 'sync run failed');
      throw error;
    }
  };

  const handleTick = async (): Promise<void> => {
    jobsProcessed += 1;
    const summary = await scheduler.tick();
    if (summary.triggeredRunId !== null) {
      logger.info({ syncRunId: summary.triggeredRunId }, 'scheduled sync queued');
    }
  };

  const handleGenerate = async (job: AdrGenerationJob): Promise<void> => {
    try {
      const result = await adrs.generate(job);
      jobsProcessed += 1;
      if (result.kind === 'created') adrsDrafted += 1;
    } catch (error) {
      jobsFailed += 1;
      logger.error({ err: error, sessionId: job.sessionId }, 'adr generation failed');
      throw error;
    }
  };

  return {
    stats,

    async start() {
      if (running) return;
      running = true;
      scheduler.setStopping(false);

      unsubscribes.push(
        await queue.subscribeJobs<SyncJob>(
          QUEUE_NAMES.OBSIDIAN_SYNC,
          async (job) => {
            await handleSync(job.payload, job.signal);
          },
          // Strictly one at a time: two concurrent runs would both hold write access to the
          // same vault files, and the ledger has one row per path.
          { concurrency: 1 },
        ),
      );

      unsubscribes.push(
        await queue.subscribeJobs<ScheduleTickJob>(QUEUE_NAMES.OBSIDIAN_SCHEDULE, handleTick, {
          concurrency: 1,
        }),
      );

      unsubscribes.push(
        await queue.subscribeJobs<AdrGenerationJob>(
          QUEUE_NAMES.ADR_GENERATE,
          async (job) => {
            await handleGenerate(job.payload);
          },
          { concurrency: 1 },
        ),
      );

      heartbeat?.start();
      // Beat once immediately: the Services panel shows a worker that has never written a row
      // as `disabled` ("not deployed"), so waiting 30 s would make the first half-minute of
      // every run look like a worker that was never installed.
      await heartbeat?.beat();

      if (options.tickOnStart !== false) {
        // Primes the self-rescheduling chain AND reclaims any run a previous process abandoned
        // — without which one hard kill would block every future sync behind the partial
        // unique index. Both are idempotent and bounded.
        const summary = await scheduler.tick();
        logger.debug({ ...summary }, 'sync scheduler chain primed');
      }

      logger.info({ queues: [...SUBSCRIBED_QUEUES] }, 'sync worker started');
    },

    async stop() {
      if (!running) return;
      running = false;

      // ORDER IS LOAD-BEARING. `offWork` waits for the in-flight handler, so the abort must
      // come first: a sync part-way through a large vault would otherwise hold shutdown until
      // it finished, or until the hard-exit deadline killed it mid-write.
      options.shutdown?.abort();
      scheduler.setStopping(true);
      heartbeat?.stop();

      for (const unsubscribe of unsubscribes.reverse()) await unsubscribe();
      unsubscribes.length = 0;
      await queue.stop();

      logger.info({ ...stats() }, 'sync worker stopped');
    },
  };
}
