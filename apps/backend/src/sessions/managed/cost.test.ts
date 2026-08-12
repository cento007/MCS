import { describe, expect, it } from 'vitest';
import { baselineFrom, CostAccumulator, ZERO_COST } from './cost.js';
import type { RuntimeResultEvent } from './runtime-events.js';

/**
 * The cost arithmetic (F1.5 canonical cost source, TDS 02 §4.2 step 4).
 *
 * Every case here exists because getting it wrong is silent: a session's cost is a number nobody
 * can sanity-check by eye, so an over- or under-count survives until an invoice contradicts it.
 */

function result(overrides: Partial<RuntimeResultEvent> = {}): RuntimeResultEvent {
  return {
    type: 'result',
    subtype: 'success',
    isError: false,
    stopReason: 'end_turn',
    totalCostUsd: 0.01,
    usage: { input_tokens: 100, output_tokens: 20 },
    modelUsage: {},
    numTurns: 1,
    durationMs: 1000,
    durationApiMs: 900,
    rateLimited: false,
    errors: [],
    ...overrides,
  };
}

describe('CostAccumulator', () => {
  it('reads total_cost_usd as a running total instead of summing results', () => {
    const accumulator = new CostAccumulator();

    accumulator.apply(result({ totalCostUsd: 0.01, numTurns: 1 }));
    const snapshot = accumulator.apply(result({ totalCostUsd: 0.025, numTurns: 2 }));

    // Summing would say 0.035 and would keep drifting further with every turn.
    expect(snapshot.totalCostUsd).toBeCloseTo(0.025, 6);
    expect(snapshot.numTurns).toBe(2);
  });

  it('sums per-turn usage counters', () => {
    const accumulator = new CostAccumulator();

    accumulator.apply(
      result({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 } }),
    );
    const snapshot = accumulator.apply(
      result({
        usage: { input_tokens: 300, output_tokens: 40, cache_creation_input_tokens: 7 },
      }),
    );

    expect(snapshot.usage).toMatchObject({
      input_tokens: 400,
      output_tokens: 60,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 7,
    });
  });

  it('sums per-result durations', () => {
    const accumulator = new CostAccumulator();
    accumulator.apply(result({ durationMs: 1000, durationApiMs: 900 }));
    const snapshot = accumulator.apply(result({ durationMs: 2500, durationApiMs: 2000 }));

    expect(snapshot.durationMs).toBe(3500);
    expect(snapshot.durationApiMs).toBe(2900);
  });

  it('adds a resumed query on top of the baseline, because the runtime restarts its own total', () => {
    // A Session that cost $0.40 before a cold pause. The resumed query() starts fresh at zero,
    // so without the baseline the Session would appear to have become cheaper by resuming.
    const accumulator = new CostAccumulator({
      ...ZERO_COST,
      totalCostUsd: 0.4,
      numTurns: 6,
      durationMs: 60_000,
      usage: {
        input_tokens: 5_000,
        output_tokens: 1_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        usage_by_model: { 'claude-opus-4-6': { costUSD: 0.4 } },
      },
    });

    const snapshot = accumulator.apply(
      result({
        totalCostUsd: 0.05,
        numTurns: 1,
        modelUsage: { 'claude-sonnet-4-5': { costUSD: 0.05 } },
      }),
    );

    expect(snapshot.totalCostUsd).toBeCloseTo(0.45, 6);
    expect(snapshot.numTurns).toBe(7);
    expect(snapshot.usage.input_tokens).toBe(5_100);
    // Per-model totals merge rather than replace: the pre-pause model must not disappear.
    expect(Object.keys(snapshot.usage.usage_by_model).sort()).toEqual([
      'claude-opus-4-6',
      'claude-sonnet-4-5',
    ]);
  });

  it('replaces per-model totals within one query, because modelUsage is itself cumulative', () => {
    const accumulator = new CostAccumulator();
    accumulator.apply(result({ modelUsage: { 'claude-sonnet-4-5': { costUSD: 0.01 } } }));
    const snapshot = accumulator.apply(
      result({ modelUsage: { 'claude-sonnet-4-5': { costUSD: 0.03 } } }),
    );

    expect(snapshot.usage.usage_by_model).toEqual({ 'claude-sonnet-4-5': { costUSD: 0.03 } });
  });

  it('never lets a nonsense negative from the runtime move a total backwards', () => {
    const accumulator = new CostAccumulator();
    const snapshot = accumulator.apply(result({ totalCostUsd: -5, numTurns: -1, durationMs: -10 }));

    expect(snapshot.totalCostUsd).toBe(0);
    expect(snapshot.numTurns).toBe(0);
    expect(snapshot.durationMs).toBe(0);
  });
});

describe('baselineFrom', () => {
  it('reads the persisted columns, including the numeric cost string', () => {
    const baseline = baselineFrom({
      totalCostUsd: '0.421000',
      usage: {
        input_tokens: 10,
        output_tokens: 2,
        usage_by_model: { 'claude-sonnet-4-5': { costUSD: 0.421 } },
      },
      numTurns: 3,
      durationMs: 9_000,
      durationApiMs: 8_000,
    });

    expect(baseline.totalCostUsd).toBeCloseTo(0.421, 6);
    expect(baseline.usage.input_tokens).toBe(10);
    expect(baseline.numTurns).toBe(3);
    expect(baseline.usage.usage_by_model).toEqual({ 'claude-sonnet-4-5': { costUSD: 0.421 } });
  });

  it('treats an unset or unrecognizable row as zero rather than throwing at launch', () => {
    expect(
      baselineFrom({
        totalCostUsd: null,
        usage: null,
        numTurns: null,
        durationMs: null,
        durationApiMs: null,
      }),
    ).toEqual(ZERO_COST);

    expect(
      baselineFrom({
        totalCostUsd: 'not-a-number',
        usage: 'a string where an object was expected',
        numTurns: null,
        durationMs: null,
        durationApiMs: null,
      }),
    ).toEqual(ZERO_COST);
  });
});
