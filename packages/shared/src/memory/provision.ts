/**
 * Collection provisioning and startup verification.
 *
 * One function that runs the sequence in the only order that is safe, and reports what it found
 * as a value rather than by throwing:
 *
 *   1. **Identify the model** (`describeModel`). This is where a chat model is caught, by name,
 *      in one ~5 ms call — before anything spends 29 seconds loading it to discover the same
 *      thing (see `ollama.ts`). It is also where the **dimension is measured** rather than
 *      assumed, which is the value the collection is about to be stamped with permanently.
 *   2. **Ensure the collection** carries that stamp, creating it if absent and refusing if an
 *      existing one disagrees.
 *
 * The order is not interchangeable. Stamping a collection with a dimension taken from settings
 * or from a model manifest, instead of from a vector the model actually produced, is how a
 * collection ends up permanently mis-sized: every subsequent upsert then fails against a
 * constraint that was written from a guess.
 *
 * ## Why this returns a report instead of throwing
 *
 * Called at Backend startup, where the rule is that an unconfigured or broken *optional*
 * dependency must not stop the process — Mission Control's Phase 1 and 2 features do not need
 * Qdrant, and refusing to boot because a vector store is down would take out session management
 * to protect a search box. So every outcome is a `MemoryProvisionReport` the caller logs and
 * the Services panel renders.
 *
 * The single exception is the stamp mismatch, which arrives as `kind: 'stamp_mismatch'`. It is
 * caught here rather than propagated because startup must continue — but it is caught *only*
 * here, and it is reported as a hard failure with the operator's two ways out, never as a
 * degraded-but-usable state. Nothing writes or queries after it.
 */

import {
  describeEmbeddingFailure,
  type EmbeddingFailure,
  type EmbeddingPort,
} from './embedding-port.js';
import {
  type EmbeddingStamp,
  EmbeddingStampMismatchError,
  formatStamp,
  type StampMismatchDetail,
} from './stamp.js';
import {
  describeVectorStoreFailure,
  type MemoryEnsureResult,
  type VectorStoreOutcome,
  type VectorStorePort,
} from './vector-store-port.js';

export type MemoryProvisionReport =
  | {
      readonly kind: 'ready';
      readonly stamp: EmbeddingStamp;
      readonly collection: string;
      readonly created: boolean;
      readonly adopted: boolean;
      readonly pointCount: number;
      /**
       * True when the collection exists and carries no metadata stamp because the server did
       * not store one. The dimension is still enforced by the store, so this is usable — but it
       * is reported, because a model change would then be caught only by the per-row stamp.
       */
      readonly stampPersisted: boolean;
      readonly message: string;
    }
  | {
      readonly kind: 'embedder_unavailable';
      readonly failure: EmbeddingFailure;
      readonly message: string;
    }
  | {
      readonly kind: 'store_unavailable';
      readonly failure: Exclude<VectorStoreOutcome<never>, { kind: 'ok' }>;
      readonly message: string;
    }
  | {
      readonly kind: 'stamp_mismatch';
      readonly detail: StampMismatchDetail;
      readonly message: string;
    };

export interface ProvisionMemoryOptions {
  readonly embedder: EmbeddingPort;
  readonly store: VectorStorePort;
  /** Bounds the whole sequence's individual calls; defaults to each adapter's own. */
  readonly timeoutMs?: number | undefined;
}

/**
 * Identify the model, then stamp and verify the collection. Never throws.
 *
 * Idempotent: a second call against a ready collection re-verifies the stamp and reports
 * `created: false, adopted: false`, which is exactly what a health probe wants.
 */
export async function provisionMemoryCollection(
  options: ProvisionMemoryOptions,
): Promise<MemoryProvisionReport> {
  const { embedder, store } = options;
  const callOptions =
    options.timeoutMs === undefined ? undefined : { timeoutMs: options.timeoutMs };

  const model = await embedder.describeModel(callOptions);
  if (model.kind !== 'ok') {
    return {
      kind: 'embedder_unavailable',
      failure: model,
      message: `Memory is not ready — ${describeEmbeddingFailure(model)}`,
    };
  }

  let ensured: VectorStoreOutcome<MemoryEnsureResult>;
  try {
    ensured = await store.ensureCollection(model.stamp, callOptions);
  } catch (error) {
    if (error instanceof EmbeddingStampMismatchError) {
      return { kind: 'stamp_mismatch', detail: error.detail, message: error.message };
    }
    throw error;
  }

  if (ensured.kind !== 'ok') {
    return {
      kind: 'store_unavailable',
      failure: ensured,
      message: `Memory is not ready — ${describeVectorStoreFailure(ensured)}`,
    };
  }

  const { created, adopted, info } = ensured.value;
  const verb = created ? 'created' : adopted ? 'adopted' : 'verified';

  return {
    kind: 'ready',
    stamp: model.stamp,
    collection: store.collection,
    created,
    adopted,
    pointCount: info.pointCount,
    stampPersisted: info.stamp !== null,
    message:
      `Memory ready — ${verb} collection "${store.collection}" stamped ` +
      `${formatStamp(model.stamp)}, ${String(info.pointCount)} point${info.pointCount === 1 ? '' : 's'}` +
      (info.stamp === null
        ? '. This Qdrant did not persist the collection metadata stamp, so a model change ' +
          'will be caught by the vector width and the per-row stamp only.'
        : ''),
  };
}
