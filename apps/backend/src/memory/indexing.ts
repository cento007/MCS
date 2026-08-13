import {
  BACKFILL_SOURCE_ORDER,
  type BackfillProgress,
  beginMemoryRun,
  completeMemoryRun,
  countRowsForOtherModels,
  createJob,
  type Db,
  deleteMemoryItemsForSession,
  deleteRowsForOtherModels,
  describeProgress,
  type EventEnvelope,
  type EventType,
  emptyProgress,
  failMemoryRun,
  findActiveMemoryRun,
  findLatestMemoryRun,
  findMemoryRun,
  indexSource,
  insertMemoryRun,
  type JobPayload,
  listIndexedModels,
  MEMORY_RUN_KIND,
  type MemoryRunMode,
  type MemoryRunRow,
  type MemorySourceType,
  projectAdr,
  projectCommit,
  projectPullRequest,
  projectSession,
  purgeSource,
  QUEUE_NAMES,
  type Queue,
  readSessionTurns,
  reclaimAbandonedSyncRuns,
  runBackfillSlice,
  runProgressOf,
  type SourceProjection,
  saveMemoryRunProgress,
  schema,
  type Unsubscribe,
} from '@mc/shared';
import { eq } from 'drizzle-orm';
import {
  isCheckViolation,
  isUniqueViolation,
  SYNC_RUN_KIND_CONSTRAINT,
  syncRunKindRejected,
} from '../db/index.js';
import type { EventBus, Outbox } from '../events/index.js';
import { ApiError } from '../http/errors.js';
import { indexVaultNotes, type NoteStageResult } from './notes.js';
import type { MemoryRuntime, MemoryRuntimeKind, MemoryRuntimeState } from './runtime.js';

/**
 * Memory ingestion — the Backend's producer *and* its single consumer.
 *
 * ## Why the Backend consumes (arbitration A16, applied rather than worked around)
 *
 * A16 is one rule: **the Backend produces into a queue with exactly one consuming process, and
 * no queue has two consumers.** It does not say which process consumes; it says exactly one
 * does. The Sync Worker was the intuitive candidate — it already owns the slow filesystem work
 * — and it is the wrong one here, for three reasons in order of weight:
 *
 *  1. **Retrieval and indexing must share one stamp verification.** `ensureCollection` is the
 *     gate that declares a collection safe, and the danger it guards is invisible. Two
 *     processes verifying independently means two answers to "which model built this
 *     collection", and the Backend — which serves the queries — would have no way to know the
 *     writer had refused. `runtime.ts` exists to make that one answer; it cannot span
 *     processes.
 *  2. **The credential is already here.** The Qdrant API key is decrypted through the Backend's
 *     `SecretVault`, wired to `MC_ENCRYPTION_KEY` at startup. The worker would need a second
 *     copy of that wiring to read a setting the Backend already holds.
 *  3. **The work is not worker-shaped.** F2.2 puts the workers where failure-prone I/O lives —
 *     Telegram's network, the operator's vault, git polling. Embedding is a bounded HTTP call
 *     to loopback with a 60 s ceiling, which is the same class of I/O the Backend already makes
 *     to api.github.com on the `repository.sync` queue it already consumes.
 *
 * The cost is honest and worth stating: a backfill slice runs in the API process. It is bounded
 * to `BACKFILL_BATCH_SIZE` sources and `concurrency: 1` so it cannot fan out, and the whole
 * subsystem is inert until an operator configures an embedding model.
 *
 * ## One queue, three job kinds
 *
 * `memory.index` carries `source`, `purge` and `backfill` jobs. One queue rather than three
 * makes every write to the index **serial by construction** — two jobs can never race on the
 * same `(source, chunk, model)` row, so the partial unique indexes are a safety net rather than
 * a thing the code has to handle. Backfill slices are bounded precisely so an incremental index
 * queued behind one waits seconds.
 *
 * ## What triggers an incremental index
 *
 * Domain events, on the in-process post-commit bus — the same wiring the Notification producer
 * uses, and for the same reason: it costs nothing and adds no second consumer to `events`.
 *
 * | event                                       | action                    |
 * |---------------------------------------------|---------------------------|
 * | `session.completed`, `session.failed`        | index the Session         |
 * | `session.archived`                           | **purge** the Session     |
 * | `commit.recorded`                            | index the Commit          |
 * | `adr.created`, `adr.updated`                 | index the ADR             |
 * | `pull_request.*`                             | index the PullRequest     |
 *
 * `session.message.appended` is **not** in the table, though §15.2 reserves it for "Phase 3
 * memory indexer". Indexing a Session on every appended message would re-project and re-chunk
 * the entire transcript per turn — at 400 chunks that is 400 hashes per message for one chunk's
 * worth of new content — and it would index a conversation that is still being had. A Session
 * is indexed when it reaches a terminal state, which is when its transcript is a fact.
 */

/** The `memory.index` job payload. A job name, not an event (TDS 04 §15.2). */
export type MemoryIndexJob =
  | { readonly kind: 'source'; readonly sourceType: MemorySourceType; readonly sourceId: string }
  | { readonly kind: 'purge'; readonly sourceType: MemorySourceType; readonly sourceId: string }
  | { readonly kind: 'purge_session'; readonly sessionId: string }
  | { readonly kind: 'backfill'; readonly runId: string };

/** Event types that make one source worth (re-)indexing. */
export const INDEXED_FROM_EVENTS: readonly EventType[] = Object.freeze([
  'session.completed',
  'session.failed',
  'session.archived',
  'commit.recorded',
  'adr.created',
  'adr.updated',
  'pull_request.opened',
  'pull_request.reviewed',
  'pull_request.merged',
  'pull_request.closed',
]);

export interface MemoryIndexServiceOptions {
  readonly db: Db;
  readonly queue: Queue;
  readonly outbox: Outbox;
  readonly bus: EventBus;
  readonly runtime: MemoryRuntime;
  readonly now?: (() => Date) | undefined;
  readonly batchSize?: number | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

/**
 * `GET /api/v1/memory-items/backfill`.
 *
 * ⚠ **`configured` / `runtime` / `runtimeReason` are additive to TDS 04 §13.1** — which reserved
 * these routes with "no payload detail", so this is the first concrete shape rather than a
 * departure from a specified one. Written down in §13.1 as well as here, the way
 * `MemorySearchResult` was: flagged, not invented quietly.
 *
 * ## Why a bare `configured: boolean` was not enough
 *
 * Everything else on this document was all-`null` in **two** situations that share nothing: no
 * embedding model is set at all, and a model is set but nothing has ever been indexed. The
 * operator's next action is *open Settings* in one and *press Backfill* in the other, and the
 * document could not tell them apart — so the Memory screen went and fetched
 * `GET /services/health` to read `meta.configured` off the qdrant/ollama rows, which is a second
 * round trip and a second source of truth for one fact this method already had in hand.
 *
 * `configured` alone would fix that and leave two more situations conflated, because the runtime
 * this is derived from has **four** arms and three of them are "configured":
 *
 * | runtime           | configured | what the operator has to do                          |
 * |-------------------|------------|------------------------------------------------------|
 * | `not_configured`  | `false`    | set an embedding model in Settings                    |
 * | `unavailable`     | `true`     | start Ollama / fix the host — **not** a Settings trip |
 * | `stamp_mismatch`  | `true`     | rebuild; the stored vectors cannot be trusted         |
 * | `ready`           | `true`     | nothing                                               |
 *
 * Collapsing those three into one `true` would send an operator whose Ollama is down to the
 * Settings page to re-enter a model that is already correct. It also decides whether offering
 * the Backfill button is honest: `POST /memory-items/backfill` refuses `unavailable` with
 * `INTEGRATION_NOT_CONFIGURED` and an incremental run under `stamp_mismatch` with `CONFLICT`, so
 * a screen without this field can only find out by making the operator press it.
 *
 * The vocabulary is `MemoryRuntimeState['kind']` verbatim (F9.5) and the same four words
 * `POST /memory-items/search` already answers with in `emptyReason`, so one client-side mapping
 * covers both documents. `configured` stays alongside it — never derived twice, never meaning
 * anything but "an embedding model is configured".
 */
export interface BackfillStatus {
  readonly runId: string | null;
  readonly state: string | null;
  readonly mode: MemoryRunMode | null;
  readonly trigger: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly error: string | null;
  readonly progress: BackfillProgress | null;
  readonly summary: string | null;
  /**
   * Is an embedding model configured at all — exactly `runtime !== 'not_configured'`, and
   * nothing else. It says nothing about whether Ollama is reachable or the index is trustworthy;
   * `runtime` says that.
   */
  readonly configured: boolean;
  /** Which of the four runtime states this read saw. `MemoryRuntimeState['kind']`, verbatim. */
  readonly runtime: MemoryRuntimeKind;
  /**
   * The runtime's own operator-facing sentence when it is not `ready`, `null` when it is.
   *
   * Already scrubbed of the Qdrant API key at source (`runtime.ts`), and already served by
   * `POST /memory-items/search` as `detail` — this exposes no string that endpoint does not.
   */
  readonly runtimeReason: string | null;
  /** Distinct `embedding_model` values present in `memory_items` — the model-change signal. */
  readonly indexedModels: readonly string[];
  readonly rowsFromOtherModels: number;
}

export class MemoryIndexService {
  readonly #db: Db;
  readonly #queue: Queue;
  readonly #outbox: Outbox;
  readonly #bus: EventBus;
  readonly #runtime: MemoryRuntime;
  readonly #now: () => Date;
  readonly #batchSize: number | undefined;
  readonly #onError: ((error: unknown, context: string) => void) | undefined;

  #unsubscribeJobs: Unsubscribe | null = null;
  #unsubscribeBus: (() => void)[] = [];

  constructor(options: MemoryIndexServiceOptions) {
    this.#db = options.db;
    this.#queue = options.queue;
    this.#outbox = options.outbox;
    this.#bus = options.bus;
    this.#runtime = options.runtime;
    this.#now = options.now ?? (() => new Date());
    this.#batchSize = options.batchSize;
    this.#onError = options.onError;
  }

  // ------------------------------------------------------------------------------ lifecycle

  /** Subscribe the single job consumer and the event triggers. */
  async start(): Promise<void> {
    this.#unsubscribeJobs ??= await this.#queue.subscribeJobs<MemoryIndexJob & JobPayload>(
      QUEUE_NAMES.MEMORY_INDEX,
      async (job) => {
        await this.handle(job.payload, job.signal);
      },
      // Serial: the whole reason there is one queue. See the header.
      { concurrency: 1 },
    );

    this.#unsubscribeBus = INDEXED_FROM_EVENTS.map((type) =>
      this.#bus.on(type, (event) => {
        void this.#onEvent(event).catch((error: unknown) => {
          this.#onError?.(error, `memory trigger for ${type}`);
        });
      }),
    );

    // A backfill whose process died leaves a `running` row holding `ux_sync_runs_active`, and
    // the guard would then refuse every future trigger with a 409 until someone ran SQL. Same
    // reclamation the Sync Worker does for its own kind, scoped to ours so neither kills the
    // other's live run.
    await reclaimAbandonedSyncRuns(this.#db, {
      now: this.#now(),
      kind: 'memory_index',
      reason: 'the backend stopped before this memory index run finished',
    });
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribeBus) unsubscribe();
    this.#unsubscribeBus = [];
    const unsubscribe = this.#unsubscribeJobs;
    this.#unsubscribeJobs = null;
    if (unsubscribe !== null) void unsubscribe();
  }

  // ------------------------------------------------------------------------------- producing

  /** Enqueue one job on its own transaction. */
  async enqueue(job: MemoryIndexJob, jobId?: string): Promise<void> {
    await this.#outbox.run(async (ctx) => {
      await this.#queue.enqueueJob<MemoryIndexJob & JobPayload>(
        ctx.tx,
        QUEUE_NAMES.MEMORY_INDEX,
        createJob<MemoryIndexJob & JobPayload>(job as MemoryIndexJob & JobPayload, jobId),
      );
    });
  }

  async #onEvent(event: EventEnvelope): Promise<void> {
    const payload = event.payload as Record<string, unknown>;
    const id = (key: string): string | null =>
      typeof payload[key] === 'string' ? (payload[key] as string) : null;

    switch (event.type) {
      case 'session.archived': {
        const sessionId = id('sessionId');
        if (sessionId !== null) await this.enqueue({ kind: 'purge_session', sessionId });
        return;
      }
      case 'session.completed':
      case 'session.failed': {
        const sessionId = id('sessionId');
        if (sessionId !== null) {
          await this.enqueue({ kind: 'source', sourceType: 'session', sourceId: sessionId });
        }
        return;
      }
      case 'commit.recorded': {
        const commitId = id('commitId');
        if (commitId !== null) {
          await this.enqueue({ kind: 'source', sourceType: 'commit', sourceId: commitId });
        }
        return;
      }
      case 'adr.created':
      case 'adr.updated': {
        const adrId = id('adrId');
        if (adrId !== null) {
          await this.enqueue({ kind: 'source', sourceType: 'adr', sourceId: adrId });
        }
        return;
      }
      default: {
        const pullRequestId = id('pullRequestId');
        if (pullRequestId !== null) {
          await this.enqueue({
            kind: 'source',
            sourceType: 'pull_request',
            sourceId: pullRequestId,
          });
        }
      }
    }
  }

  // ------------------------------------------------------------------------------- consuming

  /**
   * Handle one job. **Never throws** — `retryLimit: 0` means a thrown error would only be
   * recorded as a dead job nobody reads, while every failure here has a better home: a source
   * failure is dropped (the next backfill re-derives it), a run failure lands on the run row.
   */
  async handle(job: MemoryIndexJob, signal?: AbortSignal): Promise<void> {
    try {
      switch (job.kind) {
        case 'source':
          await this.#indexOne(job.sourceType, job.sourceId);
          return;
        case 'purge':
          await this.#purgeOne(job.sourceType, job.sourceId);
          return;
        case 'purge_session':
          await this.#purgeSession(job.sessionId);
          return;
        default:
          await this.#runSlice(job.runId, signal);
      }
    } catch (error) {
      this.#onError?.(error, `memory.index job ${job.kind}`);
    }
  }

  async #indexOne(sourceType: MemorySourceType, sourceId: string): Promise<void> {
    const state = await this.#runtime.ready();
    if (state.kind !== 'ready') return;

    const projection = await this.#project(sourceType, sourceId);
    if (projection === null) {
      // The row is gone between the event and the job. Purge rather than skip: whatever was
      // indexed for it must stop answering queries.
      await this.#purgeOne(sourceType, sourceId);
      return;
    }

    const outcome = await indexSource({
      db: this.#db,
      embedder: state.embedder,
      store: state.store,
      stamp: state.stamp,
      budget: state.budget,
      projection,
      now: this.#now,
    });

    if (outcome.kind === 'indexed' && (outcome.embedded > 0 || outcome.deleted > 0)) {
      await this.#emit('memory.item_stored', {
        sourceType,
        sourceId,
        tier: projection.tier,
        chunks: outcome.chunks,
        embedded: outcome.embedded,
      });
    }
    if (outcome.kind === 'embedder_failed' || outcome.kind === 'store_failed') {
      this.#onError?.(new Error(outcome.reason), `indexing ${sourceType} ${sourceId}`);
      // A dependency that just failed is not a runtime worth holding: the next job re-probes.
      this.#runtime.invalidate();
    }
  }

  async #purgeOne(sourceType: MemorySourceType, sourceId: string): Promise<void> {
    const state = await this.#runtime.ready();
    if (state.kind !== 'ready') return;

    const result = await purgeSource({
      db: this.#db,
      store: state.store,
      key: { sourceType, sourceId, sourceRef: null },
    });
    if (result.storeFailure !== null) {
      this.#onError?.(new Error(result.storeFailure), `purging ${sourceType} ${sourceId}`);
    }
    if (result.deleted > 0) {
      await this.#emit('memory.item_deleted', { sourceType, sourceId, deleted: result.deleted });
    }
  }

  /**
   * Purge everything a Session remembers.
   *
   * Broader than `purgeOne('session', id)` on purpose: a Session's chunks are the transcript's,
   * but `memory_items.session_id` is the scope column, so anything else ever scoped to that
   * Session goes too. Archiving is the product's "forget this" action and it should mean it.
   */
  async #purgeSession(sessionId: string): Promise<void> {
    const state = await this.#runtime.ready();
    if (state.kind !== 'ready') return;

    const ids = await this.#db.transaction(async (tx) =>
      deleteMemoryItemsForSession(tx, sessionId),
    );
    if (ids.length === 0) return;

    const dropped = await state.store.deleteByFilter({ memoryItemIds: ids });
    if (dropped.kind !== 'ok') {
      this.#onError?.(new Error(dropped.kind), `purging session ${sessionId}`);
    }
    await this.#emit('memory.item_deleted', {
      sourceType: 'session',
      sourceId: sessionId,
      deleted: ids.length,
    });
  }

  // -------------------------------------------------------------------------------- backfill

  /**
   * `POST /api/v1/memory-items/backfill` -> `202`.
   *
   * `CONFLICT` when a run is already active, and that is decided by `ux_sync_runs_active`, not
   * by the `SELECT` above it: two overlapping triggers race for the right to spend an
   * operator's model time, and the guarantee has to be the database's.
   */
  async trigger(input: { readonly mode: MemoryRunMode }): Promise<MemoryRunRow> {
    const state = await this.#runtime.ready();
    if (state.kind === 'not_configured') {
      throw new ApiError('INTEGRATION_NOT_CONFIGURED', state.reason, { reason: 'not_configured' });
    }
    // A `rebuild` is *how* a stamp mismatch is fixed, so it must be reachable while one exists;
    // an `incremental` run under a mismatch would write nothing and report success.
    if (state.kind === 'stamp_mismatch' && input.mode !== 'rebuild') {
      throw new ApiError('CONFLICT', state.reason, { reason: 'stamp_mismatch' });
    }
    if (state.kind === 'unavailable') {
      throw new ApiError('INTEGRATION_NOT_CONFIGURED', state.reason, { reason: 'unavailable' });
    }

    if (input.mode === 'rebuild') await this.#rebuild();

    try {
      const run = await this.#outbox.run(async (ctx) => {
        const row = await insertMemoryRun(ctx.tx, { trigger: 'user', mode: input.mode });
        // The job id IS the run id: pg-boss inserts `ON CONFLICT (name, id) DO NOTHING`, so a
        // retried request that somehow reached here twice cannot queue two sweeps of one run.
        await this.#queue.enqueueJob<MemoryIndexJob & JobPayload>(
          ctx.tx,
          QUEUE_NAMES.MEMORY_INDEX,
          createJob<MemoryIndexJob & JobPayload>({ kind: 'backfill', runId: row.id }, row.id),
        );
        return row;
      });
      return run;
    } catch (error) {
      if (isUniqueViolation(error, 'ux_sync_runs_active')) {
        throw new ApiError('CONFLICT', 'A memory index run is already queued or running');
      }
      // `memory_index` is the second `sync_runs.kind`, added by migration `0005`; a database that
      // has not applied it rejects this insert with a `23514`. Only *this* constraint is
      // translated — a violation of `ck_sync_runs_state` or `ck_sync_runs_trigger` would be a
      // genuine bug in this code and must keep surfacing as one.
      if (isCheckViolation(error, SYNC_RUN_KIND_CONSTRAINT)) {
        throw syncRunKindRejected(MEMORY_RUN_KIND);
      }
      throw error;
    }
  }

  /**
   * The model-change path: destroy the collection, drop the rows that named its points, and
   * let the caller's run rebuild from zero.
   *
   * ⚠ **Retrieval is unavailable while this runs, and that is a real limitation** — not an
   * oversight. `memory_items.embedding_model` is per row precisely so old vectors could keep
   * answering while a new set was built, and the *rows* can indeed coexist (the partial unique
   * indexes include the model). The **vectors** cannot: the collection carries one stamp, and
   * a second live model in it is exactly what `verifyStamp` exists to refuse. Serving through a
   * model change would need a second collection plus a settings-owned "active collection"
   * pointer to swap atomically — deferred, and named here so it is a decision rather than a
   * gap. What the per-row model still buys today is the work list (`deleteRowsForOtherModels`)
   * and a resumable rebuild: rows already written under the new model are hash matches.
   */
  async #rebuild(): Promise<void> {
    const reset = await this.#runtime.reset();
    if (reset.kind !== 'ready') {
      throw new ApiError('INTEGRATION_NOT_CONFIGURED', reset.reason, { reason: reset.kind });
    }
    await this.#db.transaction(async (tx) => {
      await deleteRowsForOtherModels(tx, reset.stamp.model);
    });
  }

  /** One bounded slice of a run, then enqueue the next. */
  async #runSlice(runId: string, signal?: AbortSignal): Promise<void> {
    const row = await findMemoryRun(this.#db, runId);
    if (row === null) return;
    if (row.state === 'completed' || row.state === 'failed') return;

    const { mode } = runProgressOf(row);
    let progress = runProgressOf(row).progress;

    if (row.state === 'queued') {
      const claimed = await this.#db.transaction(async (tx) =>
        beginMemoryRun(tx, runId, this.#now()),
      );
      // A redelivered job that finds the run already claimed does nothing, rather than
      // restarting a sweep that is halfway through.
      if (claimed === null && row.state === 'queued') return;
      progress = emptyProgress();
    }

    const state = await this.#runtime.ready();
    if (state.kind !== 'ready') {
      await failMemoryRun(this.#db, runId, state.reason, progress, this.#now(), mode);
      await this.#emitRunFinished(runId, 'failed', progress, mode);
      return;
    }

    // Vault notes are their own stage and run after the database sources, because a vault scan
    // is filesystem I/O with its own bounds and its own way of being absent.
    if (progress.stage === null && !progress.notesDone) {
      const notes = await this.#runNoteStage(state, progress);
      progress = notes.progress;
      if (notes.halt !== null) {
        await failMemoryRun(this.#db, runId, notes.halt, progress, this.#now(), mode);
        await this.#emitRunFinished(runId, 'failed', progress, mode);
        return;
      }
      await saveMemoryRunProgress(this.#db, runId, progress, this.#now(), mode);
      await this.enqueue({ kind: 'backfill', runId });
      return;
    }

    const slice = await runBackfillSlice({
      db: this.#db,
      embedder: state.embedder,
      store: state.store,
      stamp: state.stamp,
      budget: state.budget,
      progress,
      ...(this.#batchSize === undefined ? {} : { batchSize: this.#batchSize }),
      now: this.#now,
      ...(signal === undefined ? {} : { signal }),
    });

    if (slice.halt !== null) {
      await failMemoryRun(this.#db, runId, slice.halt, slice.progress, this.#now(), mode);
      await this.#emitRunFinished(runId, 'failed', slice.progress, mode);
      this.#runtime.invalidate();
      return;
    }

    if (slice.done) {
      await saveMemoryRunProgress(this.#db, runId, slice.progress, this.#now(), mode);
      await completeMemoryRun(this.#db, runId, slice.progress, this.#now(), mode);
      await this.#emitRunFinished(runId, 'completed', slice.progress, mode);
      return;
    }

    await saveMemoryRunProgress(this.#db, runId, slice.progress, this.#now(), mode);
    if (signal?.aborted === true) return;
    await this.enqueue({ kind: 'backfill', runId });
  }

  async #runNoteStage(
    state: Extract<MemoryRuntimeState, { kind: 'ready' }>,
    progress: BackfillProgress,
  ): Promise<{ progress: BackfillProgress; halt: string | null }> {
    const result: NoteStageResult = await indexVaultNotes({
      db: this.#db,
      embedder: state.embedder,
      store: state.store,
      stamp: state.stamp,
      budget: state.budget,
      now: this.#now,
    });

    return {
      progress: {
        ...progress,
        notesDone: true,
        sourcesSeen: progress.sourcesSeen + result.seen,
        sourcesIndexed: progress.sourcesIndexed + result.indexed,
        sourcesSkipped: progress.sourcesSkipped + result.skipped,
        chunksEmbedded: progress.chunksEmbedded + result.embedded,
        failures: progress.failures + result.failures,
        lastError: result.lastError ?? progress.lastError,
      },
      halt: result.halt,
    };
  }

  // ----------------------------------------------------------------------------------- reads

  /** `GET /api/v1/memory-items/backfill` — the active run, or the most recent one. */
  async status(): Promise<BackfillStatus> {
    const row = (await findActiveMemoryRun(this.#db)) ?? (await findLatestMemoryRun(this.#db));
    const models = await listIndexedModels(this.#db);
    const state = await this.#runtime.ready();
    const currentModel = state.kind === 'ready' ? state.stamp.model : null;
    const rowsFromOtherModels =
      currentModel === null ? 0 : await countRowsForOtherModels(this.#db, currentModel);

    // Free: `ready()` is already awaited above for `currentModel`, and it caches. The whole cost
    // of this half of the document is reading three fields off a state object that was being
    // thrown away.
    const index = {
      configured: state.kind !== 'not_configured',
      runtime: state.kind,
      runtimeReason: state.kind === 'ready' ? null : state.reason,
      indexedModels: models,
      rowsFromOtherModels,
    };

    if (row === null) {
      return {
        runId: null,
        state: null,
        mode: null,
        trigger: null,
        startedAt: null,
        completedAt: null,
        error: null,
        progress: null,
        summary: null,
        ...index,
      };
    }

    const { progress, mode } = runProgressOf(row);
    return {
      runId: row.id,
      state: row.state,
      mode,
      trigger: row.trigger,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      error: row.error,
      progress,
      summary: describeProgress(progress),
      ...index,
    };
  }

  // ------------------------------------------------------------------------------ projection

  /** Load and project one source. `null` when the row no longer exists. */
  async #project(sourceType: MemorySourceType, sourceId: string): Promise<SourceProjection | null> {
    switch (sourceType) {
      case 'session': {
        const rows = await this.#db
          .select({
            id: schema.sessions.id,
            projectId: schema.sessions.projectId,
            title: schema.sessions.title,
            state: schema.sessions.state,
            completedAt: schema.sessions.completedAt,
            createdAt: schema.sessions.createdAt,
          })
          .from(schema.sessions)
          .where(eq(schema.sessions.id, sourceId))
          .limit(1);
        const row = rows[0];
        if (row === undefined || row.state === 'archived') return null;

        const turns = await readSessionTurns(this.#db, row.id, 2_000);
        return projectSession({
          sessionId: row.id,
          projectId: row.projectId,
          title: row.title,
          turns,
          occurredAt: row.completedAt ?? row.createdAt,
        });
      }
      case 'commit': {
        const rows = await this.#db
          .select({
            id: schema.commits.id,
            projectId: schema.repositories.projectId,
            sha: schema.commits.sha,
            message: schema.commits.message,
            authorName: schema.commits.authorName,
            branch: schema.commits.branch,
            files: schema.commits.files,
            committedAt: schema.commits.committedAt,
          })
          .from(schema.commits)
          .innerJoin(schema.repositories, eq(schema.repositories.id, schema.commits.repositoryId))
          .where(eq(schema.commits.id, sourceId))
          .limit(1);
        const row = rows[0];
        // No Project means no scope — see `listCommitSources` for why that waits rather than
        // being filed under `global`.
        if (row === undefined || row.projectId === null) return null;
        return projectCommit({ ...row, projectId: row.projectId, commitId: row.id });
      }
      case 'adr': {
        const rows = await this.#db
          .select()
          .from(schema.adrs)
          .where(eq(schema.adrs.id, sourceId))
          .limit(1);
        const row = rows[0];
        if (row === undefined) return null;
        return projectAdr({ ...row, adrId: row.id });
      }
      case 'pull_request': {
        const rows = await this.#db
          .select({
            id: schema.pullRequests.id,
            projectId: schema.repositories.projectId,
            number: schema.pullRequests.number,
            title: schema.pullRequests.title,
            description: schema.pullRequests.description,
            state: schema.pullRequests.state,
            updatedAt: schema.pullRequests.updatedAt,
          })
          .from(schema.pullRequests)
          .innerJoin(
            schema.repositories,
            eq(schema.repositories.id, schema.pullRequests.repositoryId),
          )
          .where(eq(schema.pullRequests.id, sourceId))
          .limit(1);
        const row = rows[0];
        if (row === undefined || row.projectId === null) return null;
        return projectPullRequest({ ...row, projectId: row.projectId, pullRequestId: row.id });
      }
      default:
        // `obsidian_note` and `document` are file-backed and reached by `source_ref`, never by
        // a row id — they are indexed by the note stage, not by a `source` job.
        return null;
    }
  }

  // --------------------------------------------------------------------------------- events

  async #emit(type: EventType, payload: Record<string, unknown>): Promise<void> {
    await this.#outbox.run(async (ctx) => {
      await ctx.emit(this.#outbox.event(type, payload));
    });
  }

  async #emitRunFinished(
    runId: string,
    state: string,
    progress: BackfillProgress,
    mode: MemoryRunMode,
  ): Promise<void> {
    await this.#emit('memory.reindexed', {
      runId,
      state,
      mode,
      sourcesIndexed: progress.sourcesIndexed,
      chunksEmbedded: progress.chunksEmbedded,
      failures: progress.failures,
    });
  }
}

/** Exported for the tests that assert the sweep order matches the documented one. */
export const BACKFILL_STAGES = BACKFILL_SOURCE_ORDER;
