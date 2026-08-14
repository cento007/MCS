import type { CostBudget } from '@mc/shared';
import type { AgentCostHistory, WorkflowStepView } from './store.js';

/**
 * `GET /api/v1/agent-workflows/{id}/cost-estimate` — **what this run will cost, before it is
 * started.**
 *
 * This endpoint exists because of one requirement and one fact.
 *
 * The requirement: a workflow run is the first thing in this product that launches Claude Code
 * Sessions without a human between them. An operator who cannot see the bill coming has no way to
 * consent to it, and "stop it afterwards" is not consent.
 *
 * The fact: **nothing here can predict a model's spend.** There is no pricing table, no token
 * forecast and no model in this request path. So the estimate is *history* — how much each step's
 * Agent has actually cost across its own completed Sessions — and where an Agent has never run,
 * the answer is `null` and the document says so. That is the same rule the context package follows
 * when it refuses to summarise: an invented number an operator would act on is worse than an
 * absent one, because only the absent one is true.
 *
 * Pure, so every arm — no history at all, partial history, no budget configured, a budget already
 * exceeded — is unit tested without a database.
 */

export interface EstimateStep {
  readonly ordinal: number;
  readonly agentId: string;
  readonly agentName: string;
  /** `null` when this Agent has never run a Session that recorded a cost. */
  readonly observed: {
    readonly sessionCount: number;
    readonly meanUsd: number;
    readonly maxUsd: number;
  } | null;
}

export interface WorkflowCostEstimate {
  readonly workflowId: string;
  readonly stepCount: number;
  /** The default Session budget a run of this chain would get — the worst case in Sessions. */
  readonly defaultMaxSessions: number;
  /** Always `observed_sessions`. Named so a future basis cannot be mistaken for this one. */
  readonly basis: 'observed_sessions';
  readonly steps: readonly EstimateStep[];
  /**
   * The sum over the steps that **have** history, or `null` when none of them do.
   *
   * It is a floor, not a forecast, and `stepsWithoutHistory` is what makes that legible: with two
   * of four steps unmeasured, `projected.meanUsd` is the cost of half a chain and saying
   * otherwise would be the invention this module refuses.
   */
  readonly projected: {
    readonly meanUsd: number;
    readonly maxUsd: number;
    readonly coveredSteps: number;
  } | null;
  readonly stepsWithoutHistory: number;
  /**
   * `integrations.claudeCode.costBudget` and today's spend, so the estimate lands next to the
   * limit it will be measured against instead of in a vacuum.
   */
  readonly budget: {
    readonly dailyUsd: number | null;
    readonly spentTodayUsd: number;
    /** `null` when no daily budget is configured — not `Infinity`, and not `0`. */
    readonly remainingUsd: number | null;
  };
}

export function buildCostEstimate(input: {
  readonly workflowId: string;
  readonly steps: readonly WorkflowStepView[];
  readonly history: readonly AgentCostHistory[];
  readonly defaultMaxSessions: number;
  readonly budget: CostBudget;
  readonly spentTodayUsd: number;
}): WorkflowCostEstimate {
  const byAgent = new Map(input.history.map((row) => [row.agentId, row]));

  const steps: EstimateStep[] = input.steps.map((step) => {
    const observed = byAgent.get(step.agentId);
    return {
      ordinal: step.ordinal,
      agentId: step.agentId,
      agentName: step.agentName,
      observed:
        observed === undefined || observed.sessionCount === 0
          ? null
          : {
              sessionCount: observed.sessionCount,
              meanUsd: round6(observed.meanUsd),
              maxUsd: round6(observed.maxUsd),
            },
    };
  });

  const covered = steps.filter((step) => step.observed !== null);
  const projected =
    covered.length === 0
      ? null
      : {
          meanUsd: round6(covered.reduce((sum, step) => sum + (step.observed?.meanUsd ?? 0), 0)),
          maxUsd: round6(covered.reduce((sum, step) => sum + (step.observed?.maxUsd ?? 0), 0)),
          coveredSteps: covered.length,
        };

  const dailyUsd = input.budget.dailyUsd;

  return {
    workflowId: input.workflowId,
    stepCount: steps.length,
    defaultMaxSessions: input.defaultMaxSessions,
    basis: 'observed_sessions',
    steps,
    projected,
    stepsWithoutHistory: steps.length - covered.length,
    budget: {
      dailyUsd,
      spentTodayUsd: round6(input.spentTodayUsd),
      // Clamped at zero: a budget already exceeded has nothing left, and a negative "remaining"
      // reads as a credit. Whether the run should still be allowed is the operator's call — this
      // endpoint informs, it does not gate.
      remainingUsd: dailyUsd === null ? null : round6(Math.max(0, dailyUsd - input.spentTodayUsd)),
    },
  };
}

/** `sessions.total_cost_usd` is `numeric(12,6)`; keep the arithmetic inside that precision. */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
