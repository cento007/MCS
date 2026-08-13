import {
  createOllamaEmbedder,
  createQdrantVectorStore,
  describeEmbeddingFailure,
  describeVectorStoreFailure,
  type EmbeddingPort,
  EmbeddingStampMismatchError,
  formatStamp,
  redactSecret,
  type VectorStorePort,
} from '@mc/shared';
import type { MemoryConfig, MemoryConfigResult } from './settings.js';

/**
 * The Qdrant and Ollama rows of `GET /api/v1/services/health` (TDS 04 §7.5).
 *
 * These replace the two `disabled` placeholders `health/services.ts` has carried since Phase 1
 * ("Not configured — vector store arrives in Phase 3"). They obey that file's rule exactly:
 *
 *   > **A broken dependency is DATA, never an error.**
 *
 * The panel exists to tell the operator which dependency is down. Every probe here is bounded,
 * never throws, and reports its reason in `detail` — including the one case that throws
 * everywhere else in this layer, the embedding stamp mismatch, which is caught here and rendered
 * as a **`down`** row rather than a degraded one. It is the only place a stamp mismatch becomes
 * data, and it is deliberately the reddest thing on the page: retrieval is not merely slower
 * under a mismatch, it is untrustworthy.
 *
 * ## Status vocabulary, per row
 *
 * | Situation                                   | Status     |
 * |---------------------------------------------|------------|
 * | No embedding model configured               | `disabled` |
 * | Service unreachable / timed out             | `down`     |
 * | Reachable, model not pulled                 | `down`     |
 * | Reachable, configured model is a chat model | `down`     |
 * | Collection stamp disagrees with settings    | `down`     |
 * | Reachable, collection absent (not indexed)  | `degraded` |
 * | Reachable and verified                      | `healthy`  |
 *
 * "Reachable but the collection does not exist yet" is `degraded` rather than `down` on purpose:
 * a freshly configured instance that has never indexed anything is working exactly as designed,
 * and a red row for the normal first-run state is a row operators learn to ignore.
 */

/** What one memory probe found, already classified. `services.ts` only renders it. */
export interface MemoryProbeRow {
  readonly status: 'healthy' | 'degraded' | 'down' | 'disabled';
  readonly detail: string;
  readonly meta: Record<string, unknown> | null;
}

/**
 * Tighter than the adapters' own defaults (10 s Qdrant, 5 s Ollama probe) because
 * `collectServiceHealth` bounds every probe at 2 s anyway — being tighter *here* means the row
 * carries a real reason instead of the generic "Check timed out after 2000 ms" the outer bound
 * would produce.
 */
export const MEMORY_PROBE_TIMEOUT_MS = 1_500;

export interface MemoryProbes {
  qdrant(): Promise<MemoryProbeRow>;
  ollama(): Promise<MemoryProbeRow>;
}

export interface CreateMemoryProbesOptions {
  /** Re-read per probe, so a settings change is reflected without a restart. */
  readConfig(): Promise<MemoryConfigResult>;
  readonly timeoutMs?: number | undefined;
  /** Injected by tests so the probes never reach the network. */
  readonly build?: ((config: MemoryConfig) => MemoryClients) | undefined;
}

export interface MemoryClients {
  readonly embedder: EmbeddingPort;
  readonly store: VectorStorePort;
}

/** The real clients for a configuration. One place constructs them; tests replace this seam. */
export function createMemoryClients(config: MemoryConfig): MemoryClients {
  return {
    embedder: createOllamaEmbedder({
      host: config.ollama.host,
      port: config.ollama.port,
      model: config.embeddingModel,
    }),
    store: createQdrantVectorStore({
      host: config.qdrant.host,
      port: config.qdrant.port,
      apiKey: config.qdrant.apiKey,
      // Read on construction and never held anywhere else in this module.
    }),
  };
}

export function createMemoryProbes(options: CreateMemoryProbesOptions): MemoryProbes {
  const timeoutMs = options.timeoutMs ?? MEMORY_PROBE_TIMEOUT_MS;
  const build = options.build ?? createMemoryClients;

  /**
   * Resolve the configuration or the row that stands in for it.
   *
   * Both probes need the same two non-`configured` answers rendered the same way, and rendering
   * them twice is how the Qdrant row ends up saying something subtly different from the Ollama
   * row about the same missing setting.
   */
  async function configured(): Promise<
    | { readonly kind: 'ok'; readonly config: MemoryConfig }
    | { readonly kind: 'row'; readonly row: MemoryProbeRow }
  > {
    const result = await options.readConfig();

    if (result.kind === 'not_configured') {
      return {
        kind: 'row',
        row: {
          status: 'disabled',
          detail: result.reason,
          meta: { configured: false, missing: [...result.missing] },
        },
      };
    }
    if (result.kind === 'secret_unreadable') {
      return {
        kind: 'row',
        row: {
          status: 'down',
          detail: result.reason,
          meta: { configured: true, reason: 'secret_unreadable', keyVersion: result.keyVersion },
        },
      };
    }
    return { kind: 'ok', config: result.config };
  }

  return {
    async ollama(): Promise<MemoryProbeRow> {
      const resolved = await configured();
      if (resolved.kind === 'row') return resolved.row;

      const { config } = resolved;
      const { embedder } = build(config);
      const model = await embedder.describeModel({ timeoutMs });

      if (model.kind !== 'ok') {
        return {
          // Every embedder failure is `down`: without an embedder nothing can be indexed and
          // nothing can be queried, so there is no partially-working state to call `degraded`.
          status: 'down',
          detail: scrub(describeEmbeddingFailure(model), config),
          meta: {
            configured: true,
            reason: model.kind,
            model: config.embeddingModel,
            host: `${config.ollama.host}:${String(config.ollama.port)}`,
            ...(model.kind === 'not_an_embedding_model'
              ? { capabilities: [...model.capabilities] }
              : {}),
          },
        };
      }

      return {
        status: 'healthy',
        detail: `${formatStamp(model.stamp)} ready`,
        meta: {
          configured: true,
          model: model.stamp.model,
          dimension: model.stamp.dimension,
          declaredDimension: model.declaredDimension,
          capabilities: [...model.capabilities],
          runtimeVersion: model.runtimeVersion,
          host: `${config.ollama.host}:${String(config.ollama.port)}`,
        },
      };
    },

    async qdrant(): Promise<MemoryProbeRow> {
      const resolved = await configured();
      if (resolved.kind === 'row') return resolved.row;

      const { config } = resolved;
      const { embedder, store } = build(config);
      const host = `${config.qdrant.host}:${String(config.qdrant.port)}`;

      const described = await store.describeCollection({ timeoutMs });
      if (described.kind !== 'ok') {
        return {
          status: 'down',
          detail: scrub(describeVectorStoreFailure(described), config),
          meta: { configured: true, reason: described.kind, host, collection: store.collection },
        };
      }
      const info = described.value;

      if (!info.exists) {
        return {
          status: 'degraded',
          detail:
            `Reachable, but the "${store.collection}" collection does not exist yet — ` +
            'nothing has been indexed. It is created on the first index run.',
          meta: { configured: true, host, collection: store.collection, exists: false },
        };
      }

      // The stamp comparison needs to know what the embedder currently produces, which is the
      // one question only the embedder can answer. When it cannot be reached the collection is
      // reported as-is rather than guessed at: an unverifiable stamp is not a failed stamp, and
      // the Ollama row next to this one already carries the reason.
      const model = await embedder.describeModel({ timeoutMs });
      const base = {
        configured: true,
        host,
        collection: store.collection,
        exists: true,
        pointCount: info.pointCount,
        collectionModel: info.stamp?.model ?? null,
        collectionDimension: info.stamp?.dimension ?? info.vectorSize,
        vectorSize: info.vectorSize,
        schemaVersion: info.schemaVersion,
      };

      if (model.kind !== 'ok') {
        return {
          status: 'degraded',
          detail:
            `Collection "${store.collection}" holds ${String(info.pointCount)} point` +
            `${info.pointCount === 1 ? '' : 's'}; its stamp could not be checked because the ` +
            `embedding model is unavailable — ${scrub(describeEmbeddingFailure(model), config)}`,
          meta: { ...base, reason: 'stamp_unverified' },
        };
      }

      try {
        // The same verification a write would do, minus the write. `ensureCollection` is
        // idempotent and this collection already exists, so the only effects available to it
        // are stamping an empty unstamped collection — which is a repair, not a surprise.
        const ensured = await store.ensureCollection(model.stamp, { timeoutMs });
        if (ensured.kind !== 'ok') {
          return {
            status: 'down',
            detail: scrub(describeVectorStoreFailure(ensured), config),
            meta: { ...base, reason: ensured.kind },
          };
        }

        return {
          status: 'healthy',
          detail:
            `${String(info.pointCount)} point${info.pointCount === 1 ? '' : 's'}, stamped ` +
            `${formatStamp(model.stamp)}`,
          meta: { ...base, adopted: ensured.value.adopted, stamped: true },
        };
      } catch (error) {
        if (error instanceof EmbeddingStampMismatchError) {
          // The one place this error becomes data instead of stopping the caller. Rendered
          // `down`, with the full remedy text, because a mismatched index does not return
          // fewer answers — it returns confidently wrong ones.
          return {
            status: 'down',
            detail: scrub(error.message, config),
            meta: {
              ...base,
              reason: 'stamp_mismatch',
              mismatch: error.detail.kind,
              expectedModel: error.detail.expected.model,
              expectedDimension: error.detail.expected.dimension,
              foundModel: error.detail.found?.model ?? null,
              foundDimension: error.detail.found?.dimension ?? null,
            },
          };
        }
        throw error;
      }
    },
  };
}

/**
 * Last line of defence on the API key.
 *
 * The adapters already redact anything they build from a transport error, so in practice this
 * is redundant — which is exactly why it is here. It is one function call standing between a
 * credential and an authenticated HTTP response, and the cost of it being unnecessary is
 * nothing while the cost of it being missing once is a leaked key.
 */
function scrub(text: string, config: MemoryConfig): string {
  return redactSecret(text, config.qdrant.apiKey);
}
