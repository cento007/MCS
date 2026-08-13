import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  createJob,
  type Db,
  deleteMemoryItemsByIds,
  describeVectorStoreFailure,
  listExpiredMemoryItemIds,
  type MemoryPolicy,
  PRODUCIBLE_MEMORY_TIERS,
  type ProducibleMemoryTier,
  QUEUE_NAMES,
  type Queue,
  readMemoryPolicy,
  retentionCutoff,
  retentionDisabled,
  type Unsubscribe,
} from '@mc/shared';
import type { Outbox } from '../events/index.js';
import type { MemoryRuntime } from './runtime.js';

/**
 * Memory retention — PRD §4.4 item 4's "retention policy per memory tier", and the thing that
 * makes PRD §6.1's **"Session Memory — temporary"** true.
 *
 * Nothing expired before this: session-tier chunks accumulated for the life of the install, so
 * "temporary" was a word in a requirements document and nowhere else.
 *
 * ## Why a durable job and not a timer
 *
 * The same reason `github.poll` and `notification.schedule` are (see `github/poller.ts`): a
 * `setInterval` restarts with the process and looks identical from the outside until the moment
 * it matters. A tick scheduled before a restart is still scheduled after it, and the next tick's
 * job id is derived from the interval bucket it targets, so pg-boss's
 * `ON CONFLICT (name, id) DO NOTHING` collapses a re-primed chain into the existing one instead
 * of running two sweeps side by side. Under `tsx watch` that is the difference between one
 * retention chain and one per reload.
 *
 * ## Both stores, or nothing
 *
 * A `memory_items` row deleted without its point leaves a vector in the collection with no row
 * behind it. Retrieval hydrates every hit from `memory_items` and drops a hit whose row is
 * absent, so such a point cannot *answer* — but it is still a vector the operator believes they
 * deleted, occupying the collection until a rebuild. So the sweep **requires a ready runtime**
 * and does nothing at all without one: an Ollama that is down or a collection whose stamp does
 * not match is a reason to postpone deletion, never a reason to half-perform it.
 *
 * The order within a batch is **rows first, points second**, which is the rule `store.ts`
 * already fixed for every other deletion path and it is chosen by which crash window is
 * survivable: rows-first strands an inert point, points-first strands a row that claims to be
 * indexed and has silently vanished from search.
 *
 * ## Bounded, and biased towards keeping data
 *
 * One tick deletes at most {@link MEMORY_RETENTION_BATCH} chunks. A tick that fills its budget
 * schedules its successor in {@link MEMORY_RETENTION_CATCHUP_SECONDS} instead of a full
 * interval, so a first policy change over a large index drains in minutes rather than days
 * without any single tick holding a long lease.
 *
 * Every tier defaults to `0` — never expire. Deletion is irreversible and re-embedding costs
 * real model time, so an operator opts *in* to losing data; the chain does not even run until
 * they do.
 */

/**
 * How often the tick fires while retention is enabled.
 *
 * Retention is expressed in days, so six hours bounds the overshoot to a quarter of the
 * smallest meaningful unit while costing four wake-ups a day. It is deliberately **not** a
 * setting: a knob whose only effect is when a bounded delete runs is a knob nobody can set
 * correctly, and one more field in a document that has to justify every field it has.
 */
export const MEMORY_RETENTION_TICK_MINUTES = 6 * 60;

/** Chunks deleted per tick, across all tiers. */
export const MEMORY_RETENTION_BATCH = 500;

/** How soon the next tick runs when this one filled its budget. */
export const MEMORY_RETENTION_CATCHUP_SECONDS = 60;

/**
 * The `memory.retention` job payload. A job name, not an event — it carries no F6 envelope.
 *
 * A type alias rather than an interface, exactly as `GithubPollJob` is: `JobPayload` requires an
 * index signature, and TypeScript gives one implicitly to an object *type* and not to an
 * interface.
 */
export type MemoryRetentionJob = {
  /** Diagnostic only; the policy is re-read from settings on every tick. */
  readonly scheduledFor: string;
};

export type RetentionReason =
  /** Every tier reads `0`. Nothing is deleted and the chain stops. */
  | 'disabled'
  /** No model configured, Ollama unreachable, or a stamp mismatch. Postponed, not skipped. */
  | 'unavailable'
  | 'ok';

export interface RetentionSummary {
  readonly reason: RetentionReason;
  readonly deleted: number;
  readonly byTier: Readonly<Partial<Record<ProducibleMemoryTier, number>>>;
  /** True when the batch budget was exhausted — the next tick is scheduled sooner. */
  readonly budgetExhausted: boolean;
  readonly nextTickAt: string | null;
  /** The vector store refused a delete; the rows are gone and the points are not. */
  readonly storeError: string | null;
}

export interface MemoryRetentionOptions {
  readonly db: Db;
  readonly queue: Queue;
  readonly outbox: Outbox;
  readonly runtime: MemoryRuntime;
  readonly now?: (() => Date) | undefined;
  readonly batchSize?: number | undefined;
  readonly tickMinutes?: number | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
  readonly onTick?: ((summary: RetentionSummary) => void) | undefined;
}

export class MemoryRetentionScheduler {
  readonly #db: Db;
  readonly #queue: Queue;
  readonly #outbox: Outbox;
  readonly #runtime: MemoryRuntime;
  readonly #now: () => Date;
  readonly #batchSize: number;
  readonly #tickMinutes: number;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;
  readonly #onTick: ((summary: RetentionSummary) => void) | undefined;

  #unsubscribe: Unsubscribe | null = null;
  #stopping = false;

  constructor(options: MemoryRetentionOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#outbox = options.outbox;
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => new Date());
    this.#batchSize = options.batchSize ?? MEMORY_RETENTION_BATCH;
    this.#tickMinutes = options.tickMinutes ?? MEMORY_RETENTION_TICK_MINUTES;
    this.#onError = options.onError;
    this.#onTick = options.onTick;
  }

  async start(): Promise<void> {
    this.#stopping = false;
    this.#unsubscribe ??= await this.#queue.subscribeJobs<MemoryRetentionJob>(
      QUEUE_NAMES.MEMORY_RETENTION,
      async () => {
        await this.tick();
      },
      // One sweep at a time: two concurrent ticks would race for the same expired ids and the
      // loser would try to delete rows that are already gone.
      { concurrency: 1 },
    );
    await this.prime();
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const unsubscribe = this.#unsubscribe;
    this.#unsubscribe = null;
    if (unsubscribe !== null) await unsubscribe();
  }

  /**
   * Ensure a tick is scheduled, if any tier expires at all.
   *
   * Safe to call repeatedly — the deterministic tick id makes a redundant call a no-op at the
   * database. Called at startup and whenever `PUT /settings/memory` changes something, which is
   * what restarts a chain that stopped because every tier read `0`.
   */
  async prime(): Promise<void> {
    const policy = await readMemoryPolicy(this.#db);
    if (retentionDisabled(policy)) return;
    await this.#schedule(this.#tickMinutes * 60_000);
  }

  /**
   * One sweep. Public because that is the seam a test drives — the queue is delivery, not
   * behaviour. Never throws for an ordinary failure.
   */
  async tick(): Promise<RetentionSummary> {
    const policy = await readMemoryPolicy(this.#db);

    if (retentionDisabled(policy)) {
      // Nothing expires, and no next tick. `prime()` restarts the chain if that changes; a
      // chain that kept ticking to re-read a policy that says "keep everything" would be a
      // scheduler that cannot be turned off.
      return this.#summary('disabled', {}, false, null, null);
    }

    const state = await this.#runtime.ready();
    if (state.kind !== 'ready') {
      // Postponed, not skipped: deleting rows we cannot delete points for is the one outcome
      // worse than deleting nothing.
      const next = await this.#schedule(this.#tickMinutes * 60_000);
      return this.#summary('unavailable', {}, false, next, null);
    }

    const byTier: Partial<Record<ProducibleMemoryTier, number>> = {};
    let budget = this.#batchSize;
    let storeError: string | null = null;

    for (const tier of PRODUCIBLE_MEMORY_TIERS) {
      if (budget <= 0 || this.#stopping) break;
      const cutoff = retentionCutoff(policy, tier, this.#now());
      if (cutoff === null) continue;

      const ids = await listExpiredMemoryItemIds(this.#db, { tier, before: cutoff, limit: budget });
      if (ids.length === 0) continue;

      await this.#db.transaction(async (tx) => {
        await deleteMemoryItemsByIds(tx, ids);
      });

      const dropped = await state.store.deleteByFilter({ memoryItemIds: ids });
      if (dropped.kind !== 'ok') {
        storeError = describeVectorStoreFailure(dropped);
        this.#onError?.(new Error(storeError), `memory retention (${tier})`);
      }

      byTier[tier] = ids.length;
      budget -= ids.length;

      await this.#emitDeleted(tier, ids.length, cutoff);
    }

    const budgetExhausted = budget <= 0;
    const next = await this.#schedule(
      budgetExhausted ? MEMORY_RETENTION_CATCHUP_SECONDS * 1_000 : this.#tickMinutes * 60_000,
    );

    const summary = this.#summary('ok', byTier, budgetExhausted, next, storeError);
    this.#onTick?.(summary);
    return summary;
  }

  #summary(
    reason: RetentionReason,
    byTier: Partial<Record<ProducibleMemoryTier, number>>,
    budgetExhausted: boolean,
    nextTickAt: string | null,
    storeError: string | null,
  ): RetentionSummary {
    return {
      reason,
      deleted: Object.values(byTier).reduce((total, count) => total + count, 0),
      byTier,
      budgetExhausted,
      nextTickAt,
      storeError,
    };
  }

  /**
   * `memory.item_deleted` (TDS 04 §15.4) with a retention reason.
   *
   * Counts and a tier — never a chunk's text, and never the source it came from, because a
   * retention sweep deletes by age and has no single source to name.
   */
  async #emitDeleted(tier: ProducibleMemoryTier, deleted: number, cutoff: Date): Promise<void> {
    await this.#outbox.run(async (ctx) => {
      await ctx.emit(
        this.#outbox.event('memory.item_deleted', {
          reason: 'retention',
          tier,
          deleted,
          expiredBefore: cutoff.toISOString(),
        }),
      );
    });
  }

  /** Enqueue the next tick. Returns when it is due, or `null` if the scheduler is stopping. */
  async #schedule(delayMs: number): Promise<string | null> {
    if (this.#stopping) return null;

    const scheduledFor = new Date(this.#now().getTime() + delayMs);
    await this.#db.transaction(async (tx) => {
      await this.#queue.enqueueJob<MemoryRetentionJob>(
        tx,
        QUEUE_NAMES.MEMORY_RETENTION,
        createJob<MemoryRetentionJob>(
          { scheduledFor: scheduledFor.toISOString() },
          retentionTickJobId(scheduledFor, delayMs),
          { startAfterSeconds: Math.max(1, Math.round(delayMs / 1000)) },
        ),
      );
    });
    return scheduledFor.toISOString();
  }
}

/**
 * A deterministic job id for the tick that targets `scheduledFor`, bucketed by the delay.
 *
 * Identical construction to `github/poller.ts`'s `tickJobId` — a name-based UUID over
 * `(queue, bucket size, bucket)` — because it solves the identical problem: two callers that
 * want a tick in the same slot must produce the same id, so pg-boss collapses them into one job
 * and `prime()` is idempotent across restarts without reading pg-boss's vendored tables.
 */
export function retentionTickJobId(scheduledFor: Date, bucketMs: number): string {
  const bucket = Math.floor(scheduledFor.getTime() / Math.max(1, bucketMs));
  const digest = createHash('sha256')
    .update(`${QUEUE_NAMES.MEMORY_RETENTION}:${String(bucketMs)}:${String(bucket)}`)
    .digest();

  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 5 (name-based) and RFC 4122 variant.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * One line naming what the stored policy does, for the startup log.
 *
 * Worth a line because retention is the one part of this subsystem whose *absence* looks
 * identical to its presence: an operator asking "why has nothing expired" and one asking "why
 * did my session memory disappear" are both answered by this string, and neither is answerable
 * from the queue.
 */
export function describeRetention(policy: MemoryPolicy): string {
  if (retentionDisabled(policy)) return 'no memory tier expires';
  return PRODUCIBLE_MEMORY_TIERS.map(
    (tier) =>
      `${tier}: ${policy.retentionDays[tier] === 0 ? 'never' : `${String(policy.retentionDays[tier])} days`}`,
  ).join(', ');
}
