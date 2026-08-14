import type { BackfillProgress } from '@mc/shared';
import { BACKFILL_SOURCE_ORDER, MEMORY_SOURCE_TYPES, MEMORY_TIERS } from '@mc/shared';
import {
  type Assert,
  arrayOf,
  booleanValue,
  type Covers,
  describe,
  type ExactShape,
  entityId,
  enumSchema,
  integerValue,
  nullable,
  nullableEntityId,
  nullableString,
  nullableTimestamp,
  numberValue,
  objectSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { BackfillStatus } from './indexing.js';
import type { EmptyReason, MemorySearchResponse, MemorySearchResult } from './retrieval.js';

/** The `/api/v1/memory-items/*` response shapes (TDS 04 §13.1). */

const memoryResultContextSchema = objectSchema('MemoryResultContext', {
  projectId: nullableEntityId,
  repositoryId: nullableEntityId,
  sessionId: nullableEntityId,
});

export const memoryItemSchema = objectSchema('MemoryItem', {
  memoryItemId: entityId,
  score: numberValue,
  tier: enumSchema('MemoryTier', MEMORY_TIERS),
  sourceType: enumSchema('MemorySourceType', MEMORY_SOURCE_TYPES),
  sourceId: nullableEntityId,
  sourceRef: nullableString,
  title: stringValue,
  content: stringValue,
  chunkOrdinal: integerValue,
  chunkCount: integerValue,
  occurredAt: nullableTimestamp,
  context: memoryResultContextSchema,
});
export type _MemoryItemShape = Assert<ExactShape<MemorySearchResult, typeof memoryItemSchema>>;

/**
 * Why a search came back empty.
 *
 * Six values that all render as "no results" and for which the operator's next action is
 * completely different — which is exactly why the list is enumerated on the wire instead of
 * being folded into a boolean.
 */
const MEMORY_EMPTY_REASONS = [
  'none',
  'not_configured',
  'unavailable',
  'stamp_mismatch',
  'index_empty',
  'below_threshold',
] as const;
export type _EmptyReasonsCover = Assert<Covers<EmptyReason, typeof MEMORY_EMPTY_REASONS>>;

export const memorySearchResponseSchema = objectSchema('MemorySearchResponse', {
  results: arrayOf(memoryItemSchema),
  emptyReason: describe(
    enumSchema('MemoryEmptyReason', MEMORY_EMPTY_REASONS),
    'Six situations that all render as "no results" and for which the operator next action is completely different. A screen that renders them as one sends the operator to the wrong place four times out of five.',
  ),
  /** Operator-facing sentence when `emptyReason` is not `none`. */
  detail: nullableString,
  minScore: numberValue,
  /** The model the query vector was produced by — the answer to "why did this match?". */
  embeddingModel: nullableString,
  /** Hits the store returned before the floor dropped them. Makes the floor visible. */
  candidatesConsidered: integerValue,
});
export type _MemorySearchResponseShape = Assert<
  ExactShape<MemorySearchResponse, typeof memorySearchResponseSchema>
>;

/**
 * `sync_runs.stats` for a memory run, verbatim (`packages/shared/src/memory/backfill.ts`).
 *
 * `stage` and `cursor` are resumption state rather than display data, and they are published for
 * the same reason `failures` is: a sweep that stopped halfway must be legible as *halfway* and
 * not as finished.
 */
const backfillProgressSchema = objectSchema('MemoryBackfillProgress', {
  stage: nullable(stringEnum(BACKFILL_SOURCE_ORDER)),
  cursor: nullableString,
  sourcesSeen: integerValue,
  sourcesIndexed: integerValue,
  sourcesSkipped: integerValue,
  chunksEmbedded: integerValue,
  chunksDeleted: integerValue,
  failures: integerValue,
  lastError: nullableString,
  pruned: integerValue,
  notesDone: booleanValue,
  documentsDone: booleanValue,
});
export type _BackfillProgressShape = Assert<
  ExactShape<BackfillProgress, typeof backfillProgressSchema>
>;

export const memoryBackfillStatusSchema = objectSchema('MemoryBackfillStatus', {
  runId: nullableEntityId,
  state: nullableString,
  mode: nullable(enumSchema('MemoryRunMode', ['incremental', 'rebuild'])),
  trigger: nullableString,
  startedAt: nullableTimestamp,
  completedAt: nullableTimestamp,
  error: nullableString,
  progress: nullable(backfillProgressSchema),
  summary: nullableString,
  /** Exactly `runtime !== 'not_configured'`, and nothing else — `runtime` carries the rest. */
  configured: booleanValue,
  runtime: enumSchema('MemoryRuntimeKind', [
    'not_configured',
    'unavailable',
    'stamp_mismatch',
    'ready',
  ]),
  runtimeReason: nullableString,
  /** Distinct `embedding_model` values present in `memory_items` — the model-change signal. */
  indexedModels: arrayOf(stringValue),
  rowsFromOtherModels: integerValue,
});
export type _BackfillStatusShape = Assert<
  ExactShape<BackfillStatus, typeof memoryBackfillStatusSchema>
>;

/** `202` from `POST /memory-items/backfill` — the run that was just queued. */
export const memoryBackfillAcceptedSchema = objectSchema('MemoryBackfillAccepted', {
  runId: entityId,
  state: stringValue,
  mode: stringEnum(['incremental', 'rebuild']),
  createdAt: timestampValue,
});
