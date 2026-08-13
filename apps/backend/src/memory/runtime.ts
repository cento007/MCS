import {
  type ChunkBudget,
  chunkBudget,
  describeEmbeddingFailure,
  describeVectorStoreFailure,
  type EmbeddingPort,
  type EmbeddingStamp,
  EmbeddingStampMismatchError,
  formatStamp,
  redactSecret,
  type StampMismatchDetail,
  type VectorStorePort,
} from '@mc/shared';
import { createMemoryClients, type MemoryClients } from './health.js';
import type { MemoryConfig, MemoryConfigResult } from './settings.js';

/**
 * The verified runtime — the one place indexing and retrieval agree on what they are talking to.
 *
 * Both halves of Phase 3 need the same four things: an embedder, a store, the **stamp** those
 * two agree on, and the chunk budget derived from the model's context window. Getting them
 * requires three round trips (`/api/show`, an embed probe, `GET /collections/{name}`) and one
 * decision that must never be made twice differently — `ensureCollection`, which is what
 * declares the collection safe to write and query.
 *
 * So it is resolved once and cached. Not as an optimisation: **two independently-verified
 * clients are two chances to disagree about which model the collection holds**, and the whole
 * point of the stamp is that there is one answer. A retrieval path that verified separately
 * from the indexer could serve queries against a collection the indexer had refused.
 *
 * ## What invalidates it
 *
 * A `setting.updated` naming the `qdrant` or `ollama` integration, and nothing else. The next
 * caller re-resolves from scratch — new adapters, new probe, new `ensureCollection` — which is
 * how changing the embedding model takes effect without a restart, and how it is *caught*
 * without a restart.
 *
 * ## Why failures are cached only negatively for one call
 *
 * A failed resolution is not cached at all. Ollama being down is a state of the operator's
 * machine that they may fix while this process keeps running, and caching "unavailable" would
 * make the fix invisible until a restart — the same reasoning `ollama.ts` gives for caching only
 * a successful capability check.
 */

export type MemoryRuntimeState =
  | {
      readonly kind: 'ready';
      readonly embedder: EmbeddingPort;
      readonly store: VectorStorePort;
      readonly stamp: EmbeddingStamp;
      readonly budget: ChunkBudget;
      readonly collection: string;
    }
  | { readonly kind: 'not_configured'; readonly reason: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  /**
   * The collection was built by a different embedding model. Its own arm because the operator's
   * next action is a rebuild, not a restart, and because retrieval must **refuse** rather than
   * degrade: mismatched vectors return confident nonsense, not fewer results.
   */
  | {
      readonly kind: 'stamp_mismatch';
      readonly reason: string;
      readonly detail: StampMismatchDetail;
    };

/**
 * The four arms, as a value type. Named so that a document reporting which one it saw carries
 * *this* vocabulary rather than a parallel set of words for the same four states (F9.5).
 */
export type MemoryRuntimeKind = MemoryRuntimeState['kind'];

export interface MemoryRuntimeOptions {
  readConfig(): Promise<MemoryConfigResult>;
  readonly build?: ((config: MemoryConfig) => MemoryClients) | undefined;
  /** Bounds each resolution round trip. Generous: a cold model can take seconds to load. */
  readonly timeoutMs?: number | undefined;
}

export interface MemoryRuntime {
  /** Resolve, or return the reason it cannot be. Never throws. */
  ready(): Promise<MemoryRuntimeState>;
  /**
   * Reset the collection to `stamp` — every vector destroyed — and hand back a ready runtime.
   *
   * The one caller is the rebuild path, which is the only situation where destroying the index
   * is the correct action (`memory/index.ts`). Kept off `ready()` so no ordinary code path can
   * reach it.
   */
  reset(): Promise<MemoryRuntimeState>;
  /** Drop the cache — called when `setting.updated` names qdrant or ollama. */
  invalidate(): void;
  /** True when a resolved runtime is being held. Diagnostics only. */
  readonly cached: boolean;
}

/** Generous: `/api/show` is milliseconds but a cold `ollama pull`ed model takes seconds to load. */
export const MEMORY_RUNTIME_TIMEOUT_MS = 60_000;

export function createMemoryRuntime(options: MemoryRuntimeOptions): MemoryRuntime {
  const build = options.build ?? createMemoryClients;
  const timeoutMs = options.timeoutMs ?? MEMORY_RUNTIME_TIMEOUT_MS;

  let cached: MemoryRuntimeState | null = null;
  /** In-flight resolution, shared so a burst of jobs makes one probe rather than N. */
  let pending: Promise<MemoryRuntimeState> | null = null;

  async function resolve(mode: 'ensure' | 'reset'): Promise<MemoryRuntimeState> {
    const result = await options.readConfig();
    if (result.kind === 'not_configured') {
      return { kind: 'not_configured', reason: result.reason };
    }
    if (result.kind === 'secret_unreadable') {
      return { kind: 'unavailable', reason: result.reason };
    }

    const config = result.config;
    const scrub = (text: string): string => redactSecret(text, config.qdrant.apiKey);
    const { embedder, store } = build(config);

    const model = await embedder.describeModel({ timeoutMs });
    if (model.kind !== 'ok') {
      return { kind: 'unavailable', reason: scrub(describeEmbeddingFailure(model)) };
    }

    try {
      const ensured =
        mode === 'reset'
          ? await store.resetCollection(model.stamp, { timeoutMs })
          : await store.ensureCollection(model.stamp, { timeoutMs });

      if (ensured.kind !== 'ok') {
        return { kind: 'unavailable', reason: scrub(describeVectorStoreFailure(ensured)) };
      }
    } catch (error) {
      if (error instanceof EmbeddingStampMismatchError) {
        return { kind: 'stamp_mismatch', reason: scrub(error.message), detail: error.detail };
      }
      throw error;
    }

    return {
      kind: 'ready',
      embedder,
      store,
      stamp: model.stamp,
      // The chunker's ceiling comes from the model's own declared window, and falls back to a
      // deliberately small assumption when it declares none — see `chunk.ts`.
      budget: chunkBudget(model.contextTokens),
      collection: store.collection,
    };
  }

  return {
    get cached(): boolean {
      return cached !== null;
    },

    async ready(): Promise<MemoryRuntimeState> {
      if (cached !== null) return cached;
      pending ??= resolve('ensure').finally(() => {
        pending = null;
      });

      const state = await pending;
      // Only a ready runtime is remembered; every failure arm is a machine state the operator
      // may fix while this process keeps running.
      if (state.kind === 'ready') cached = state;
      return state;
    },

    async reset(): Promise<MemoryRuntimeState> {
      cached = null;
      const state = await resolve('reset');
      if (state.kind === 'ready') cached = state;
      return state;
    },

    invalidate(): void {
      cached = null;
    },
  };
}

/** One line naming what a runtime is, for a log or a run row. */
export function describeRuntime(state: MemoryRuntimeState): string {
  return state.kind === 'ready'
    ? `${formatStamp(state.stamp)} into "${state.collection}", chunks ≤ ${String(state.budget.maxBytes)} bytes`
    : state.reason;
}
