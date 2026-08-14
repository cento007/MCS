import { describe, expect, it } from 'vitest';
import { buildCostEstimate } from './estimate.js';
import type { AgentCostHistory, WorkflowStepView } from './store.js';

/**
 * The cost estimate, unit tier.
 *
 * The claim under test is not arithmetic — it is **honesty**: an agent that has never run must
 * report `null` rather than a plausible number, and a partially-measured chain must say how much
 * of itself it could not measure. An operator acts on this figure before spending real money, so
 * a confident guess here is worse than an admitted gap.
 */

const BUDGET = { dailyUsd: 10, perSessionUsd: null, alertThresholdPercent: 80 };

function step(ordinal: number, agentId: string, agentName: string): WorkflowStepView {
  return {
    workflowId: 'w',
    ordinal,
    agentId,
    agentName,
    agentScope: 'global',
    agentProjectId: null,
    agentArchivedAt: null,
    instructions: null,
  };
}

function history(
  agentId: string,
  sessionCount: number,
  meanUsd: number,
  maxUsd: number,
): AgentCostHistory {
  return { agentId, sessionCount, meanUsd, maxUsd };
}

describe('with history for every step', () => {
  const estimate = buildCostEstimate({
    workflowId: 'w',
    steps: [step(0, 'dev', 'Developer'), step(1, 'qa', 'QA')],
    history: [history('dev', 4, 0.5, 1.25), history('qa', 2, 0.2, 0.3)],
    defaultMaxSessions: 5,
    budget: BUDGET,
    spentTodayUsd: 2,
  });

  it('sums the measured means and maxima', () => {
    expect(estimate.projected).toEqual({ meanUsd: 0.7, maxUsd: 1.55, coveredSteps: 2 });
    expect(estimate.stepsWithoutHistory).toBe(0);
  });

  it('reports the budget the run will be measured against', () => {
    expect(estimate.budget).toEqual({ dailyUsd: 10, spentTodayUsd: 2, remainingUsd: 8 });
  });

  it('names its basis, so a future one cannot be mistaken for this one', () => {
    expect(estimate.basis).toBe('observed_sessions');
  });
});

describe('with no history at all', () => {
  const estimate = buildCostEstimate({
    workflowId: 'w',
    steps: [step(0, 'dev', 'Developer')],
    history: [],
    defaultMaxSessions: 4,
    budget: BUDGET,
    spentTodayUsd: 0,
  });

  it('projects null rather than zero', () => {
    // Zero would read as "this run is free", which is the one wrong answer available.
    expect(estimate.projected).toBeNull();
    expect(estimate.steps[0]?.observed).toBeNull();
    expect(estimate.stepsWithoutHistory).toBe(1);
  });
});

describe('with history for some steps', () => {
  const estimate = buildCostEstimate({
    workflowId: 'w',
    steps: [step(0, 'dev', 'Developer'), step(1, 'sec', 'Security')],
    history: [history('dev', 3, 1, 2)],
    defaultMaxSessions: 5,
    budget: BUDGET,
    spentTodayUsd: 0,
  });

  it('projects the covered half and says how much it could not measure', () => {
    expect(estimate.projected).toEqual({ meanUsd: 1, maxUsd: 2, coveredSteps: 1 });
    expect(estimate.stepsWithoutHistory).toBe(1);
  });
});

describe('the budget half', () => {
  it('is null-not-Infinity when no daily budget is configured', () => {
    const estimate = buildCostEstimate({
      workflowId: 'w',
      steps: [step(0, 'dev', 'Developer')],
      history: [history('dev', 1, 1, 1)],
      defaultMaxSessions: 4,
      budget: { dailyUsd: null, perSessionUsd: null, alertThresholdPercent: 80 },
      spentTodayUsd: 3,
    });

    expect(estimate.budget.dailyUsd).toBeNull();
    expect(estimate.budget.remainingUsd).toBeNull();
  });

  it('clamps an exceeded budget at zero rather than reporting a credit', () => {
    const estimate = buildCostEstimate({
      workflowId: 'w',
      steps: [step(0, 'dev', 'Developer')],
      history: [history('dev', 1, 1, 1)],
      defaultMaxSessions: 4,
      budget: BUDGET,
      spentTodayUsd: 14.5,
    });

    expect(estimate.budget.remainingUsd).toBe(0);
  });
});

describe('an agent with a history row but no sessions', () => {
  it('is treated as unmeasured', () => {
    const estimate = buildCostEstimate({
      workflowId: 'w',
      steps: [step(0, 'dev', 'Developer')],
      history: [history('dev', 0, 0, 0)],
      defaultMaxSessions: 4,
      budget: BUDGET,
      spentTodayUsd: 0,
    });

    expect(estimate.steps[0]?.observed).toBeNull();
    expect(estimate.projected).toBeNull();
  });
});
