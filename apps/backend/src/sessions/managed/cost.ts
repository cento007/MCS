import type { RuntimeResultEvent, RuntimeUsage } from './runtime-events.js';

/**
 * Cost and usage accumulation — TDS 02 §4.2 step 4, F1.5's "the SDK path is the **canonical
 * cost source** for managed sessions".
 *
 * The arithmetic is not obvious, and the installed SDK is explicit about why (0.3.228 doc
 * comments on `SDKResultSuccess`):
 *
 *   - **`total_cost_usd` is cumulative across turns of one `query()` call** — "each result
 *     carries the running total so far, so read the latest result rather than summing across
 *     results". Summing it would multiply a five-turn session's cost by fifteen.
 *   - **`usage` is per-turn** and main-loop only, so it *is* summed.
 *   - **`modelUsage` is cumulative** per `query()` call, so it is replaced per model, not added.
 *   - **"resumed sessions start fresh"** — a new `query()` (in-place resume after a cold pause,
 *     or a resume-as-new Session) restarts the running total at zero. Everything the Session
 *     already accrued therefore has to be carried as a **baseline** read from its row at launch,
 *     or a paused-and-resumed Session would silently report only its most recent leg.
 *
 * The spike (§6) said only "SDK: `ResultMessage.total_cost_usd`", which is true and insufficient:
 * it does not say the field is a running total. That distinction is this file.
 */

/** The `sessions` cost/usage columns this module owns (TDS 03 §3.9). */
export interface SessionCostSnapshot {
  readonly totalCostUsd: number;
  readonly usage: SessionUsageTotals;
  readonly numTurns: number;
  readonly durationMs: number;
  readonly durationApiMs: number;
}

export interface SessionUsageTotals {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_creation_input_tokens: number;
  readonly cache_read_input_tokens: number;
  readonly usage_by_model: Record<string, unknown>;
}

export const ZERO_USAGE: SessionUsageTotals = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  usage_by_model: {},
};

export const ZERO_COST: SessionCostSnapshot = {
  totalCostUsd: 0,
  usage: ZERO_USAGE,
  numTurns: 0,
  durationMs: 0,
  durationApiMs: 0,
};

/**
 * One accumulator per `query()` call — i.e. one per `ManagedSessionController`.
 *
 * Constructed with whatever the Session row already holds; every `apply()` returns the snapshot
 * to persist, so the caller never has to know which fields are running totals and which are
 * per-turn.
 */
export class CostAccumulator {
  readonly #baseline: SessionCostSnapshot;

  /** Latest values reported by this query (already cumulative within it). */
  #queryCostUsd = 0;
  #queryTurns = 0;
  /** Per-result values, summed across this query. */
  #queryDurationMs = 0;
  #queryDurationApiMs = 0;
  #queryUsage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
  #queryModelUsage: Record<string, unknown> = {};

  constructor(baseline: SessionCostSnapshot = ZERO_COST) {
    this.#baseline = baseline;
  }

  apply(result: RuntimeResultEvent): SessionCostSnapshot {
    this.#queryCostUsd = Math.max(0, result.totalCostUsd);
    this.#queryTurns = Math.max(0, result.numTurns);
    this.#queryDurationMs += Math.max(0, result.durationMs);
    this.#queryDurationApiMs += Math.max(0, result.durationApiMs);
    addUsage(this.#queryUsage, result.usage);
    this.#queryModelUsage = { ...this.#queryModelUsage, ...result.modelUsage };

    return this.snapshot();
  }

  snapshot(): SessionCostSnapshot {
    const baseUsage = this.#baseline.usage;
    return {
      // Money never touches floating-point drift beyond the column's six decimals; the store
      // rounds on write (`numeric(12,6)`, F4.2).
      totalCostUsd: this.#baseline.totalCostUsd + this.#queryCostUsd,
      usage: {
        input_tokens: baseUsage.input_tokens + this.#queryUsage.input,
        output_tokens: baseUsage.output_tokens + this.#queryUsage.output,
        cache_creation_input_tokens:
          baseUsage.cache_creation_input_tokens + this.#queryUsage.cacheCreate,
        cache_read_input_tokens: baseUsage.cache_read_input_tokens + this.#queryUsage.cacheRead,
        // Cumulative per query and keyed by model: merge, so a resumed session keeps the models
        // it used before the pause instead of dropping them.
        usage_by_model: { ...baseUsage.usage_by_model, ...this.#queryModelUsage },
      },
      numTurns: this.#baseline.numTurns + this.#queryTurns,
      durationMs: this.#baseline.durationMs + this.#queryDurationMs,
      durationApiMs: this.#baseline.durationApiMs + this.#queryDurationApiMs,
    };
  }
}

/**
 * Read a Session row's persisted totals back into a baseline. Unset columns mean zero.
 *
 * `usage` is typed `unknown` rather than as the schema's `SessionUsage` because the column is
 * JSONB written by this file and possibly by an older version of it: every field is read
 * defensively, so a shape that predates a rename degrades to zero instead of throwing at boot.
 */
export function baselineFrom(row: {
  readonly totalCostUsd: string | null;
  readonly usage: unknown;
  readonly numTurns: number | null;
  readonly durationMs: number | null;
  readonly durationApiMs: number | null;
}): SessionCostSnapshot {
  const usage: Record<string, unknown> =
    typeof row.usage === 'object' && row.usage !== null
      ? (row.usage as Record<string, unknown>)
      : {};
  return {
    totalCostUsd: row.totalCostUsd === null ? 0 : Number.parseFloat(row.totalCostUsd) || 0,
    usage: {
      input_tokens: numberAt(usage, 'input_tokens'),
      output_tokens: numberAt(usage, 'output_tokens'),
      cache_creation_input_tokens: numberAt(usage, 'cache_creation_input_tokens'),
      cache_read_input_tokens: numberAt(usage, 'cache_read_input_tokens'),
      usage_by_model:
        typeof usage['usage_by_model'] === 'object' && usage['usage_by_model'] !== null
          ? (usage['usage_by_model'] as Record<string, unknown>)
          : {},
    },
    numTurns: row.numTurns ?? 0,
    durationMs: row.durationMs ?? 0,
    durationApiMs: row.durationApiMs ?? 0,
  };
}

function addUsage(
  target: { input: number; output: number; cacheCreate: number; cacheRead: number },
  usage: RuntimeUsage,
): void {
  target.input += usage.input_tokens ?? 0;
  target.output += usage.output_tokens ?? 0;
  target.cacheCreate += usage.cache_creation_input_tokens ?? 0;
  target.cacheRead += usage.cache_read_input_tokens ?? 0;
}

function numberAt(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
