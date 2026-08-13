import type { Db, Queue } from '@mc/shared';
import { type MemoryProvisionReport, provisionMemoryCollection } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import type { EventBus, Outbox } from '../events/index.js';
import type { SecretVault } from '../settings/secrets.js';
import {
  createMemoryClients,
  createMemoryProbes,
  type MemoryClients,
  type MemoryProbes,
} from './health.js';
import { MemoryIndexService } from './indexing.js';
import { MemoryRetentionScheduler } from './retention.js';
import { MemorySearchService } from './retrieval.js';
import { registerMemoryRoutes } from './routes.js';
import { createMemoryRuntime, type MemoryRuntime } from './runtime.js';
import { describeMemoryConfig, type MemoryConfig, readMemoryConfig } from './settings.js';

/**
 * `memory/` — the Backend's half of Phase 3 (PRD §6).
 *
 * The ports, adapters, fakes, the embedding stamp, the chunker, the projections, the indexer and
 * the backfill live in `@mc/shared/memory`, because F2.2 forbids a worker importing Backend
 * modules and the vocabulary has to be identical on both sides of the queue. What lives *here*
 * is everything that needs the database, the settings vault, or a route:
 *
 *   settings.ts   read the qdrant/ollama configuration; "configured" vs "not configured"
 *   health.ts     the two `GET /services/health` rows, bounded and never throwing
 *   runtime.ts    the one verified (embedder, store, stamp, budget) both halves share
 *   indexing.ts   the `memory.index` producer and its single consumer; the backfill run
 *   notes.ts      the Obsidian vault stage — unmanaged notes only
 *   documents.ts  the repository documentation stage — PRD §6.3's sixth source
 *   retention.ts  the `memory.retention` tick — per-tier expiry, both stores
 *   retrieval.ts  `POST /memory-items/search`, scope filtering, the relevance floor
 *   routes.ts     the four routes, and the two §13.1 reserved ones deliberately not built
 *   index.ts      wiring
 *
 * The policy the whole layer obeys — which sources may be indexed, and for how long each tier
 * is kept — lives in `@mc/shared/memory/policy.ts` and is `settings.memory.*` (PRD §4.4 item 4).
 *
 * **Nothing here runs until an operator sets `integrations.qdrant.embeddingModel`.** No outbound
 * call is made, no collection is created, no job does any work: `MemoryRuntime.ready()` answers
 * `not_configured` and every path returns early. That is what lets an install that never opens
 * the Memory settings behave exactly as it did in Phase 2. Retention is doubly inert: it does
 * not even schedule a tick while every tier reads `0`, which is the default.
 */

export * from './documents.js';
export * from './health.js';
export * from './indexing.js';
export * from './notes.js';
export * from './retention.js';
export * from './retrieval.js';
export * from './runtime.js';
export * from './settings.js';

export interface MemoryModuleOptions {
  readonly db: Db;
  readonly vault: SecretVault;
  readonly queue: Queue;
  readonly outbox: Outbox;
  readonly bus: EventBus;
  /** Injected by tests so nothing reaches the network. */
  readonly build?: ((config: MemoryConfig) => MemoryClients) | undefined;
  readonly probeTimeoutMs?: number | undefined;
  /** Sources per backfill slice. Tests shrink it so a sweep takes two slices instead of one. */
  readonly backfillBatchSize?: number | undefined;
  /** Chunks deleted per retention tick. Tests shrink it to demonstrate the batch bound. */
  readonly retentionBatchSize?: number | undefined;
  /** Minutes between retention ticks. Tests shrink it so a scheduled tick is observable. */
  readonly retentionTickMinutes?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly onError?: ((error: unknown, context: string) => void) | undefined;
}

export interface MemoryModule {
  readonly probes: MemoryProbes;
  readonly runtime: MemoryRuntime;
  readonly indexing: MemoryIndexService;
  readonly retention: MemoryRetentionScheduler;
  readonly search: MemorySearchService;
  /**
   * Identify the model, then create-or-verify the stamped collection. Safe to call at startup
   * and safe to call again; returns a report and never throws.
   */
  verify(): Promise<
    MemoryProvisionReport | { readonly kind: 'not_configured'; readonly message: string }
  >;
}

export function createMemoryModule(options: MemoryModuleOptions): MemoryModule {
  const readConfig = () => readMemoryConfig({ db: options.db, vault: options.vault });
  const build = options.build ?? createMemoryClients;

  const runtime = createMemoryRuntime({
    readConfig,
    build,
  });

  const indexing = new MemoryIndexService({
    db: options.db,
    queue: options.queue,
    outbox: options.outbox,
    bus: options.bus,
    runtime,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.backfillBatchSize === undefined ? {} : { batchSize: options.backfillBatchSize }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const retention = new MemoryRetentionScheduler({
    db: options.db,
    queue: options.queue,
    outbox: options.outbox,
    runtime,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.retentionBatchSize === undefined ? {} : { batchSize: options.retentionBatchSize }),
    ...(options.retentionTickMinutes === undefined
      ? {}
      : { tickMinutes: options.retentionTickMinutes }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const search = new MemorySearchService({ db: options.db, runtime });

  return {
    probes: createMemoryProbes({
      readConfig,
      build,
      ...(options.probeTimeoutMs === undefined ? {} : { timeoutMs: options.probeTimeoutMs }),
    }),
    runtime,
    indexing,
    retention,
    search,

    async verify() {
      const result = await readConfig();
      if (result.kind !== 'configured') {
        return { kind: 'not_configured', message: result.reason };
      }
      const { embedder, store } = build(result.config);
      return provisionMemoryCollection({ embedder, store });
    },
  };
}

/**
 * Does this `setting.updated` change what `MemoryRuntime` resolved?
 *
 * The **slug test is the live path**, and today it is the only one: `integrations` is
 * deliberately excluded from `DOCUMENT_CATEGORIES` (§7.3 — "it has its own pair of endpoints
 * because it is written one integration at a time"), so every write that can touch this
 * configuration arrives from `PUT /settings/integrations/{qdrant|ollama}` carrying its slug.
 *
 * Ollama counts as well as Qdrant: the runtime caches an embedder built from the Ollama host and
 * port, and a stamp derived from that model's context window. Moving Ollama to another port
 * without dropping the cache leaves every subsequent embed call pointed at nothing.
 *
 * The `changedKeys` test underneath is **defence in depth, not a second live path** — no route
 * currently emits `integration: null` alongside an `integrations.*` key. It is kept because
 * `changedKeys` is the authoritative statement of what actually moved, while the slug is an
 * artifact of which route was called: if a category-level integrations write is ever added, or a
 * worker writes these keys directly, the predicate stays correct without anyone remembering it
 * exists. The prefixes are the registry's own key namespaces, so a key added to either
 * integration is covered on arrival.
 */
export function affectsMemoryRuntime(payload: Record<string, unknown>): boolean {
  const integration = payload['integration'];
  if (integration === 'qdrant' || integration === 'ollama') return true;

  const changedKeys = payload['changedKeys'];
  if (!Array.isArray(changedKeys)) return false;

  return changedKeys.some(
    (key) =>
      typeof key === 'string' &&
      (key.startsWith('integrations.qdrant.') || key.startsWith('integrations.ollama.')),
  );
}

/**
 * Does this `setting.updated` change the memory **policy** — which sources are indexed, and how
 * long each tier is kept?
 *
 * Separate from `affectsMemoryRuntime` because they protect different things and share nothing:
 * the runtime cache is about *what we are talking to*, the policy is about *what we are allowed
 * to do*. The policy is re-read from the database on every job and every query, so the only
 * thing that has to happen on a change is re-priming the retention chain — which is how turning
 * retention on from `0` starts a tick without a restart, and the exact mechanism
 * `github/poller.ts` uses for `syncIntervalMinutes`.
 *
 * `PUT /settings/memory` is the only route that can write these keys and it emits
 * `category: 'memory'`, so the category test is the live path; the key test underneath is the
 * same defence in depth `affectsMemoryRuntime` keeps, for a caller that writes the rows directly.
 */
export function affectsMemoryPolicy(payload: Record<string, unknown>): boolean {
  if (payload['category'] === 'memory') return true;

  const changedKeys = payload['changedKeys'];
  if (!Array.isArray(changedKeys)) return false;
  return changedKeys.some((key) => typeof key === 'string' && key.startsWith('memory.'));
}

/**
 * Build the module and register its routes.
 *
 * The `memory.index` consumer is **not** subscribed here. Registration happens while the app is
 * being built; subscribing a queue consumer at that moment would start doing work before the
 * process is ready to serve, and — in the integration tier, where an app is built per test —
 * would attach a consumer to a queue that the test may never start. `start()` is called from
 * `main.ts` after the queue is up, exactly as the GitHub poller is.
 *
 * The **cache invalidator** is subscribed here rather than in `start()`, and that difference is
 * deliberate. It performs no I/O — it drops a cached object — so none of the reasoning above
 * applies to it, while the routes it protects go live the moment they are registered. Deferring
 * it to `start()` would leave the integration tier, which builds an app per test and often never
 * calls `start()`, serving retrieval from a runtime that no settings write could ever refresh.
 *
 * Without this, `runtime.ts`'s stated contract does not hold: an operator who changes the
 * embedding model keeps being served from the collection built by the *previous* model until the
 * process restarts. That is the one failure mode the stamp exists to refuse, because mismatched
 * vectors return confident nonsense rather than an error — so the miss is invisible.
 */
export function registerMemory(app: FastifyInstance, options: MemoryModuleOptions): MemoryModule {
  const memory = createMemoryModule(options);
  registerMemoryRoutes(app, { search: memory.search, indexing: memory.indexing });

  const unsubscribe = options.bus.on('setting.updated', (event) => {
    if (affectsMemoryRuntime(event.payload)) memory.runtime.invalidate();
    if (affectsMemoryPolicy(event.payload)) {
      // Fire-and-forget: a settings write must not wait on a queue insert, and a failed prime
      // costs at most one interval — the next tick re-reads everything from settings anyway.
      void memory.retention.prime().catch((error: unknown) => {
        options.onError?.(error, 'priming the memory retention chain');
      });
    }
  });

  app.addHook('onClose', async () => {
    unsubscribe();
    memory.indexing.stop();
    await memory.retention.stop();
  });

  return memory;
}

/**
 * Startup verification, as one call `main.ts` makes and logs.
 *
 * Never fatal, and that is the design: Phase 1 and Phase 2 do not need a vector store, so
 * refusing to boot because Qdrant is down would take out session management to protect a search
 * box. A stamp mismatch is logged at `error` — the one condition here that means "stop trusting
 * this index" rather than "this dependency is offline".
 */
export async function verifyMemoryAtStartup(
  memory: MemoryModule,
  log: {
    info: (object: object, message: string) => void;
    warn: (object: object, message: string) => void;
    error: (object: object, message: string) => void;
  },
  config?: MemoryConfig,
): Promise<void> {
  const report = await memory.verify();
  // Never the API key — `describeMemoryConfig` has no field for it, only `qdrantApiKeySet`.
  const context = config === undefined ? {} : describeMemoryConfig(config);

  switch (report.kind) {
    case 'ready':
      log.info(
        {
          ...context,
          collection: report.collection,
          model: report.stamp.model,
          dimension: report.stamp.dimension,
          points: report.pointCount,
          created: report.created,
          adopted: report.adopted,
          stampPersisted: report.stampPersisted,
        },
        'memory collection verified',
      );
      return;
    case 'stamp_mismatch':
      log.error(
        { ...context, ...report.detail },
        'memory collection stamp does not match the configured embedding model — retrieval is disabled',
      );
      return;
    case 'not_configured':
      log.info({ ...context }, 'memory is not configured — no embedding model is set');
      return;
    default:
      log.warn({ ...context, reason: report.kind }, report.message);
  }
}
