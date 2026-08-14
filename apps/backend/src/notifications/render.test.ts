import { describe, expect, it } from 'vitest';
import {
  formatDuration,
  formatUsd,
  renderCostBudgetAlert,
  renderRepositoryProblem,
  renderSessionCompleted,
  renderSessionFailed,
  renderSyncFailed,
  renderWorkflowStepWaiting,
  type SessionNotificationFacts,
  shortReason,
  UNTITLED_SESSION,
  type WorkflowStepWaitingFacts,
} from './render.js';

const session = (overrides: Partial<SessionNotificationFacts> = {}): SessionNotificationFacts => ({
  sessionId: '018f6b2e-1111-7abc-8def-0123456789ab',
  title: 'Refactor the queue port',
  projectName: 'Mission Control',
  sessionType: 'managed',
  durationMs: 3_845_000,
  commitCount: 3,
  totalCostUsd: 1.234_5,
  failureReason: null,
  ...overrides,
});

describe('formatDuration', () => {
  it('renders hours, minutes and seconds in human units', () => {
    expect(formatDuration(3_845_000)).toBe('1h 04m');
    expect(formatDuration(252_000)).toBe('4m 12s');
    expect(formatDuration(8_000)).toBe('8s');
    expect(formatDuration(0)).toBe('0s');
  });

  it('says "unknown" rather than printing a number it does not have', () => {
    expect(formatDuration(null)).toBe('unknown');
    expect(formatDuration(-1)).toBe('unknown');
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });
});

describe('formatUsd', () => {
  it('keeps four decimals below a dollar so a real charge never reads as free', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.9999)).toBe('$0.9999');
  });

  it('uses two decimals from a dollar up', () => {
    expect(formatUsd(1.2345)).toBe('$1.23');
    expect(formatUsd(42)).toBe('$42.00');
  });

  it('says "unknown" for an absent amount', () => {
    expect(formatUsd(null)).toBe('unknown');
  });
});

describe('shortReason', () => {
  it('flattens whitespace and caps the length', () => {
    expect(shortReason('  process   crashed\nbadly ')).toBe('process crashed badly');
    expect(shortReason('x'.repeat(500))?.length).toBe(300);
  });

  it('treats an empty or absent reason as absent', () => {
    expect(shortReason('   ')).toBeNull();
    expect(shortReason(null)).toBeNull();
    expect(shortReason(undefined)).toBeNull();
  });
});

describe('renderSessionCompleted (PRD §9: Summary, Commits, Duration)', () => {
  it('carries all three of the PRD facts', () => {
    const rendered = renderSessionCompleted(session());

    expect(rendered.title).toBe('Session completed — Refactor the queue port');
    expect(rendered.body).toContain('Project: Mission Control');
    expect(rendered.body).toContain('Duration: 1h 04m');
    expect(rendered.body).toContain('Commits: 3');
    expect(rendered.body).toContain('Cost: $1.23');
  });

  it('names an untitled session rather than rendering "null"', () => {
    const rendered = renderSessionCompleted(session({ title: null }));

    expect(rendered.title).toBe(`Session completed — ${UNTITLED_SESSION}`);
    expect(rendered.title).not.toContain('null');
  });

  it('omits the cost line for an observed session instead of claiming $0.00', () => {
    const rendered = renderSessionCompleted(
      session({ sessionType: 'observed', totalCostUsd: null }),
    );

    expect(rendered.body).not.toContain('Cost:');
    expect(rendered.body).toContain('Commits: 3');
  });

  it('drops the project line rather than printing an empty one', () => {
    const rendered = renderSessionCompleted(session({ projectName: null }));

    expect(rendered.body).not.toContain('Project:');
    expect(rendered.body.split('\n').every((line) => line.trim().length > 0)).toBe(true);
  });

  it('reports zero commits explicitly — the absence is the information', () => {
    expect(renderSessionCompleted(session({ commitCount: 0 })).body).toContain('Commits: 0');
  });
});

describe('renderSessionFailed (PRD §9 Alerts: Session Errors)', () => {
  it('leads with the failure reason', () => {
    const rendered = renderSessionFailed(session({ failureReason: 'process_crash' }));

    expect(rendered.title).toBe('Session failed — Refactor the queue port');
    expect(rendered.body).toContain('Reason: process_crash');
  });

  it('says "not recorded" when the runtime gave no reason', () => {
    expect(renderSessionFailed(session({ failureReason: null })).body).toContain(
      'Reason: not recorded',
    );
  });
});

describe('renderWorkflowStepWaiting (PRD §5.6 — your turn)', () => {
  const waiting = (
    overrides: Partial<WorkflowStepWaitingFacts> = {},
  ): WorkflowStepWaitingFacts => ({
    workflowName: 'Review chain',
    agentName: 'QA',
    stepOrdinal: 1,
    stepCount: 4,
    projectName: 'Mission Control',
    sessionTitle: 'Review chain · step 2 · QA',
    ...overrides,
  });

  it('names the position, the agent and what ending the session does next', () => {
    const rendered = renderWorkflowStepWaiting(waiting());

    expect(rendered.title).toBe('Workflow step 2 of 4 is waiting — Review chain');
    expect(rendered.body).toContain('Step: QA');
    expect(rendered.body).toContain('Project: Mission Control');
    expect(rendered.body).toContain('the next step starts');
  });

  it('says the run finishes when the waiting step is the last one', () => {
    const rendered = renderWorkflowStepWaiting(waiting({ stepOrdinal: 3, stepCount: 4 }));

    expect(rendered.title).toBe('Workflow step 4 of 4 is waiting — Review chain');
    // Promising a next step that does not exist is the one thing this sentence must not do.
    expect(rendered.body).toContain('completes the run');
    expect(rendered.body).not.toContain('next step');
  });

  it('drops the lines it has no facts for rather than printing an absence', () => {
    const rendered = renderWorkflowStepWaiting(waiting({ projectName: null, sessionTitle: null }));

    expect(rendered.body).not.toContain('Project:');
    expect(rendered.body).not.toContain('Session:');
    expect(rendered.body).toContain('Step: QA');
  });
});

describe('renderRepositoryProblem (PRD §9 Alerts: Repository Problems)', () => {
  it('names the repository and the reason', () => {
    const rendered = renderRepositoryProblem({
      repositoryId: 'r1',
      name: 'mcs',
      reason: 'Token rejected by GitHub (401)',
      localPath: 'D:\\Repos\\MCS',
    });

    expect(rendered.title).toBe('Repository sync failed — mcs');
    expect(rendered.body).toContain('Reason: Token rejected by GitHub (401)');
    expect(rendered.body).toContain('Path: D:\\Repos\\MCS');
  });

  it('degrades to a stated placeholder when the row is gone', () => {
    const rendered = renderRepositoryProblem({
      repositoryId: 'r1',
      name: null,
      reason: null,
      localPath: null,
    });

    expect(rendered.title).toContain('Unknown repository');
    expect(rendered.body).toContain('Reason: not recorded');
    expect(rendered.body).not.toContain('Path:');
  });
});

describe('renderSyncFailed (PRD §9 Alerts: Failed Syncs)', () => {
  it('names the run and the reason', () => {
    const rendered = renderSyncFailed({ syncRunId: 'run-1', reason: 'vault path unreadable' });

    expect(rendered.title).toBe('Obsidian sync failed');
    expect(rendered.body).toContain('Reason: vault path unreadable');
    expect(rendered.body).toContain('Sync run: run-1');
  });
});

describe('renderCostBudgetAlert (PRD §4.4.2)', () => {
  it('states the percentage, the amounts and the day it is talking about', () => {
    const rendered = renderCostBudgetAlert({
      status: 'alert',
      spentUsd: 8.5,
      budgetUsd: 10,
      thresholdPercent: 80,
      timezone: 'Europe/Amsterdam',
      localDate: '2026-08-13',
    });

    expect(rendered.title).toBe('Daily spend at 85% of budget');
    expect(rendered.body).toContain('$8.50 of $10.00 (85%)');
    expect(rendered.body).toContain('Alert threshold: 80%');
    expect(rendered.body).toContain('2026-08-13 (Europe/Amsterdam)');
  });

  it('says "over budget" outright once the budget is exceeded', () => {
    const rendered = renderCostBudgetAlert({
      status: 'over',
      spentUsd: 12.75,
      budgetUsd: 10,
      thresholdPercent: 80,
      timezone: 'UTC',
      localDate: '2026-08-13',
    });

    expect(rendered.title).toBe('Daily spend is over budget — $12.75');
    expect(rendered.body).toContain('(127%)');
  });
});
