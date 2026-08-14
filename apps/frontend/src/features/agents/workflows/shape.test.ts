import { describe, expect, it } from 'vitest';
import type { AgentView } from '../../../lib/agents/index.js';
import { readAgent } from '../../../lib/agents/index.js';
import {
  moveStep,
  newRunRequestDraft,
  newStepDraft,
  newWorkflowDraft,
  partitionAgentsForWorkflow,
  readWorkflow,
  readWorkflowRun,
  runRequestIssues,
  toCreateWorkflowBody,
  toPatchWorkflowBody,
  toStartRunBody,
  workflowDirty,
  workflowDraftOf,
  workflowIssues,
} from './shape.js';
import {
  DEVELOPER_ID,
  makeHaltedRun,
  makeReadOnlyAgent,
  makeRun,
  makeShellAgent,
  makeWorkflow,
  QA_ID,
  WORKFLOW_ID,
} from './test-support.js';

function agentOf(raw: Record<string, unknown>): AgentView {
  const agent = readAgent(raw);
  if (agent === null) throw new Error('fixture is not a readable agent');
  return agent;
}

describe('readWorkflow', () => {
  it('reads the chain and its inlined agent summaries', () => {
    const workflow = readWorkflow(makeWorkflow());
    expect(workflow?.name).toBe('Review chain');
    expect(workflow?.steps.map((step) => step.agentName)).toEqual(['Developer', 'QA']);
    expect(workflow?.steps[1]?.instructions).toBe('Review the diff for missing tests.');
    expect(workflow?.stepCount).toBe(2);
    expect(workflow?.unrecognised).toEqual([]);
  });

  it('sorts by ordinal rather than trusting the served order', () => {
    const scrambled = makeWorkflow({
      steps: [
        { ordinal: 1, agentId: QA_ID, agentName: 'QA' },
        { ordinal: 0, agentId: DEVELOPER_ID, agentName: 'Developer' },
      ],
    });
    expect(readWorkflow(scrambled)?.steps.map((step) => step.agentName)).toEqual([
      'Developer',
      'QA',
    ]);
  });

  it('refuses a row with no id and counts a step with no agent', () => {
    expect(readWorkflow({ name: 'nameless' })).toBeNull();
    const workflow = readWorkflow(makeWorkflow({ steps: [{ ordinal: 0 }] }));
    expect(workflow?.steps).toHaveLength(0);
    expect(workflow?.unreadableSteps).toBe(1);
  });

  it('reports fields it does not understand instead of dropping them silently', () => {
    const workflow = readWorkflow(makeWorkflow({ cadence: 'nightly' }));
    expect(workflow?.unrecognised).toEqual(['cadence']);
  });

  it('never defaults an absent scope to global', () => {
    const { scope: _dropped, ...rest } = makeWorkflow();
    expect(readWorkflow(rest)?.scope).toBe('');
  });
});

describe('readWorkflowRun', () => {
  it('reads the nested hand-off rather than flat fields', () => {
    const run = readWorkflowRun(makeRun());
    expect(run?.steps[0]?.handoffState).toBe('none');
    expect(run?.steps[1]?.handoffState).toBe('full');
    expect(run?.steps[1]?.handoffPromptBytes).toBe(8_912);
    expect(run?.workingDirectory).toBe('D:\\Repos\\MCS');
    expect(run?.maxSessions).toBe(5);
    expect(run?.unrecognised).toEqual([]);
  });

  it('orders attempts by position then attempt number', () => {
    const run = readWorkflowRun(
      makeRun({
        steps: [
          { ordinal: 1, attempt: 1, state: 'running' },
          { ordinal: 0, attempt: 0, state: 'completed' },
          { ordinal: 1, attempt: 0, state: 'failed' },
        ],
      }),
    );
    expect(run?.steps.map((step) => [step.ordinal, step.attempt])).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
    ]);
  });

  it('carries the halt reason verbatim', () => {
    const run = readWorkflowRun(makeHaltedRun());
    expect(run?.state).toBe('halted');
    expect(run?.haltReason).toContain('process_crash');
  });
});

describe('step eligibility', () => {
  const global = agentOf(makeShellAgent());
  const project = agentOf(
    makeReadOnlyAgent({ id: QA_ID, scope: 'project', projectId: 'project-a' }),
  );
  const session = agentOf(
    makeReadOnlyAgent({ id: QA_ID, scope: 'session', sessionId: 'session-a', projectId: null }),
  );
  const archived = agentOf(makeReadOnlyAgent({ archivedAt: '2026-08-01T00:00:00.000Z' }));

  it('lets a global workflow hold only global agents', () => {
    const choices = partitionAgentsForWorkflow([global, project], {
      scope: 'global',
      projectId: null,
    });
    expect(choices.eligible.map((agent) => agent.id)).toEqual([global.id]);
    expect(choices.excluded[0]?.reason).toBe('other_project');
  });

  it('lets a project workflow hold global agents and its own project’s', () => {
    const choices = partitionAgentsForWorkflow([global, project], {
      scope: 'project',
      projectId: 'project-a',
    });
    expect(choices.eligible).toHaveLength(2);
  });

  it('never admits a session-scoped agent', () => {
    const choices = partitionAgentsForWorkflow([session], { scope: 'project', projectId: null });
    expect(choices.excluded[0]?.reason).toBe('session_scoped');
  });

  it('excludes an archived agent with a way out', () => {
    const choices = partitionAgentsForWorkflow([archived], { scope: 'global', projectId: null });
    expect(choices.excluded[0]?.reason).toBe('archived');
    expect(choices.excluded[0]?.explanation).toContain('Un-archive');
  });
});

describe('drafting and validation', () => {
  it('reorders steps without losing their contents', () => {
    const steps = [
      { ...newStepDraft(DEVELOPER_ID), instructions: 'first' },
      { ...newStepDraft(QA_ID), instructions: 'second' },
    ];
    const moved = moveStep(steps, 0, 1);
    expect(moved.map((step) => step.instructions)).toEqual(['second', 'first']);
    // Out of range is a no-op rather than a crash or a silent truncation.
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 1, 1)).toBe(steps);
  });

  it('blocks a chain with no steps and one with a row naming no agent', () => {
    const empty = workflowIssues(
      { ...newWorkflowDraft(), name: 'x', steps: [] },
      { mode: 'create', projectsAvailable: true, ineligibleSteps: [] },
    );
    expect(empty.some((issue) => issue.field === 'steps' && issue.severity === 'blocking')).toBe(
      true,
    );

    const partial = workflowIssues(
      { ...newWorkflowDraft(), name: 'x', steps: [newStepDraft(DEVELOPER_ID), newStepDraft()] },
      { mode: 'create', projectsAvailable: true, ineligibleSteps: [] },
    );
    expect(partial.some((issue) => issue.message.includes('names no agent'))).toBe(true);
  });

  it('requires a project for a project-scoped chain, and says Global is the alternative', () => {
    const issues = workflowIssues(
      { ...newWorkflowDraft(), name: 'x', scope: 'project', projectId: '' },
      { mode: 'create', projectsAvailable: true, ineligibleSteps: [] },
    );
    const issue = issues.find((entry) => entry.field === 'projectId');
    expect(issue?.severity).toBe('blocking');
    expect(issue?.why).toContain('Global');
  });

  it('counts a reorder as one change', () => {
    const workflow = readWorkflow(makeWorkflow());
    const baseline = workflowDraftOf(workflow);
    const reordered = { ...baseline, steps: moveStep(baseline.steps, 0, 1) };
    expect(workflowDirty(baseline, reordered)).toMatchObject({ count: 1, isDirty: true });
    expect(workflowDirty(baseline, baseline).isDirty).toBe(false);
  });
});

describe('request bodies', () => {
  it('sends steps as { agentId, instructions } and never an ordinal', () => {
    const draft = {
      ...newWorkflowDraft(),
      name: '  Review chain  ',
      steps: [
        { ...newStepDraft(DEVELOPER_ID), instructions: ' build it ' },
        { ...newStepDraft(QA_ID), instructions: '' },
        newStepDraft(''),
      ],
    };
    const body = toCreateWorkflowBody(draft);
    expect(body['name']).toBe('Review chain');
    expect(body['steps']).toEqual([
      { agentId: DEVELOPER_ID, instructions: 'build it' },
      { agentId: QA_ID, instructions: null },
    ]);
    // The route's step schema is `additionalProperties: false` with exactly two properties, so an
    // ordinal here would be a 400 naming the field.
    for (const step of body['steps'] as Record<string, unknown>[]) {
      expect(Object.keys(step).sort()).toEqual(['agentId', 'instructions']);
    }
  });

  it('patches only what changed, and never scope or projectId', () => {
    const baseline = workflowDraftOf(readWorkflow(makeWorkflow()));
    expect(toPatchWorkflowBody(baseline, baseline)).toEqual({});

    const renamed = { ...baseline, name: 'Release chain' };
    expect(toPatchWorkflowBody(baseline, renamed)).toEqual({ name: 'Release chain' });

    const reordered = { ...baseline, steps: moveStep(baseline.steps, 0, 1) };
    const body = toPatchWorkflowBody(baseline, reordered);
    expect(Object.keys(body)).toEqual(['steps']);
    expect(body['scope']).toBeUndefined();
    expect(body['projectId']).toBeUndefined();
  });

  it('starts a run with the four required fields and omits empty optional ones', () => {
    const draft = {
      ...newRunRequestDraft(2, 'project-a'),
      task: '  ship it  ',
      workingDirectory: '  D:\\Repos\\MCS  ',
    };
    const body = toStartRunBody(WORKFLOW_ID, draft);
    expect(body).toEqual({
      workflowId: WORKFLOW_ID,
      projectId: 'project-a',
      task: 'ship it',
      workingDirectory: 'D:\\Repos\\MCS',
      maxSessions: 5,
    });
    expect('repositoryId' in body).toBe(false);
    expect('branch' in body).toBe(false);
  });

  it('defaults the session budget to the chain plus a retry budget', () => {
    expect(newRunRequestDraft(2, null).maxSessions).toBe(5);
    // Clamped at the absolute ceiling rather than growing with the chain.
    expect(newRunRequestDraft(10, null).maxSessions).toBe(13);
  });
});

describe('runRequestIssues', () => {
  const base = { ...newRunRequestDraft(2, 'project-a'), task: 'x', workingDirectory: 'D:\\x' };

  it('accepts a complete request', () => {
    expect(runRequestIssues(base, 2)).toEqual([]);
  });

  it('requires a task, a working directory and a project', () => {
    const issues = runRequestIssues(
      { ...base, task: '   ', workingDirectory: '', projectId: '' },
      2,
    );
    expect(issues.map((issue) => issue.field).sort()).toEqual([
      'projectId',
      'task',
      'workingDirectory',
    ]);
  });

  it('refuses a session budget that cannot pay for the chain, naming both bounds', () => {
    const issue = runRequestIssues({ ...base, maxSessions: 1 }, 2)[0];
    expect(issue?.field).toBe('maxSessions');
    expect(issue?.message).toContain('between 2 and 20');

    expect(runRequestIssues({ ...base, maxSessions: 21 }, 2)).toHaveLength(1);
  });
});
