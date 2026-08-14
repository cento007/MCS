/**
 * `GET /agent-workflows/{id}/cost-estimate`, projected — **what this run will cost, before it is
 * started.**
 *
 * ## Why the projection is so careful about `null`
 *
 * The Backend is explicit that this is **history, not a forecast**: it reports what each step's
 * Agent has actually cost across its own completed Sessions, and `null` where an Agent has never
 * run. `projected` is therefore the sum over the steps that *have* history — a floor, and with two
 * of four steps unmeasured it is the cost of half a chain.
 *
 * A client that rendered `projected.meanUsd` as "this run costs $0.42" would convert a careful
 * refusal into exactly the invented number the endpoint exists to avoid. So `coverage` is carried
 * beside every figure and the dialog prints both, always, in the same sentence.
 */

export interface EstimateStepView {
  readonly ordinal: number;
  readonly agentId: string;
  readonly agentName: string;
  /** `null` when this agent has never recorded a session cost. Never coerced to zero. */
  readonly observed: {
    readonly sessionCount: number;
    readonly meanUsd: number;
    readonly maxUsd: number;
  } | null;
}

export interface CostEstimateView {
  readonly stepCount: number | null;
  readonly defaultMaxSessions: number | null;
  /** Always `observed_sessions` today. Read so a future basis cannot be mistaken for this one. */
  readonly basis: string;
  readonly steps: readonly EstimateStepView[];
  readonly projected: {
    readonly meanUsd: number;
    readonly maxUsd: number;
    readonly coveredSteps: number;
  } | null;
  readonly stepsWithoutHistory: number | null;
  readonly budget: {
    /** `null` when no daily budget is configured — not `Infinity`, and not `0`. */
    readonly dailyUsd: number | null;
    readonly spentTodayUsd: number | null;
    readonly remainingUsd: number | null;
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readCostEstimate(raw: unknown): CostEstimateView | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const rawSteps = record['steps'];
  const steps: EstimateStepView[] = [];
  if (Array.isArray(rawSteps)) {
    rawSteps.forEach((entry, index) => {
      const step = asRecord(entry);
      if (step === null) return;
      const agentId = typeof step['agentId'] === 'string' ? step['agentId'] : '';
      const observed = asRecord(step['observed']);
      steps.push({
        ordinal: numberAt(step, 'ordinal') ?? index,
        agentId,
        agentName: typeof step['agentName'] === 'string' ? step['agentName'] : '',
        observed:
          observed === null
            ? null
            : {
                sessionCount: numberAt(observed, 'sessionCount') ?? 0,
                meanUsd: numberAt(observed, 'meanUsd') ?? 0,
                maxUsd: numberAt(observed, 'maxUsd') ?? 0,
              },
      });
    });
    steps.sort((a, b) => a.ordinal - b.ordinal);
  }

  const projected = asRecord(record['projected']);
  const budget = asRecord(record['budget']);

  return {
    stepCount: numberAt(record, 'stepCount'),
    defaultMaxSessions: numberAt(record, 'defaultMaxSessions'),
    basis: typeof record['basis'] === 'string' ? record['basis'] : '',
    steps,
    projected:
      projected === null
        ? null
        : {
            meanUsd: numberAt(projected, 'meanUsd') ?? 0,
            maxUsd: numberAt(projected, 'maxUsd') ?? 0,
            coveredSteps: numberAt(projected, 'coveredSteps') ?? 0,
          },
    stepsWithoutHistory: numberAt(record, 'stepsWithoutHistory'),
    budget: {
      dailyUsd: budget === null ? null : numberAt(budget, 'dailyUsd'),
      spentTodayUsd: budget === null ? null : numberAt(budget, 'spentTodayUsd'),
      remainingUsd: budget === null ? null : numberAt(budget, 'remainingUsd'),
    },
  };
}

export interface EstimateCoverage {
  readonly measured: number;
  readonly total: number;
  /** True when no step has ever run, so there is no floor at all — only the session bound. */
  readonly nothingMeasured: boolean;
  /** True when some steps are unmeasured, so the figure is a floor rather than a total. */
  readonly partial: boolean;
}

export function estimateCoverage(estimate: CostEstimateView): EstimateCoverage {
  const total = estimate.stepCount ?? estimate.steps.length;
  const measured = estimate.projected?.coveredSteps ?? 0;
  return {
    measured,
    total,
    nothingMeasured: measured === 0,
    partial: measured > 0 && measured < total,
  };
}
