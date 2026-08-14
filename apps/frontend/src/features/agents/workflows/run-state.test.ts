import { describe, expect, it } from 'vitest';
import {
  canResumeRun,
  canStopRun,
  chainPositions,
  definitionApplies,
  handoffNote,
  isTerminalRunKind,
  runHalt,
  runProgress,
  runStateKind,
  stepSessionDisagreement,
  stepStateKind,
} from './run-state.js';
import { readWorkflow, readWorkflowRun, type WorkflowRunView } from './shape.js';
import {
  DEVELOPER_ID,
  makeHaltedRun,
  makeRun,
  makeRunStep,
  makeWorkflow,
  QA_ID,
} from './test-support.js';

function run(raw: Record<string, unknown>): WorkflowRunView {
  const view = readWorkflowRun(raw);
  if (view === null) throw new Error('fixture is not a readable run');
  return view;
}

describe('state classification', () => {
  it('knows the Backend’s four run states', () => {
    expect(runStateKind('running')).toBe('running');
    expect(runStateKind('completed')).toBe('completed');
    expect(runStateKind('halted')).toBe('halted');
    expect(runStateKind('stopped')).toBe('stopped');
  });

  it('classifies anything else as unknown rather than guessing', () => {
    expect(runStateKind('paused')).toBe('unknown');
    expect(runStateKind('')).toBe('unknown');
    expect(stepStateKind('pending')).toBe('unknown');
  });

  it('treats halted as non-terminal, resumable and stoppable', () => {
    expect(isTerminalRunKind('halted')).toBe(false);
    expect(canResumeRun('halted')).toBe(true);
    expect(canStopRun('halted')).toBe(true);

    expect(isTerminalRunKind('completed')).toBe(true);
    expect(canStopRun('completed')).toBe(false);
    expect(canResumeRun('completed')).toBe(false);
    expect(canStopRun('stopped')).toBe(false);
  });
});

describe('chainPositions', () => {
  it('fills the run’s snapshotted step count, including positions with no attempt', () => {
    const positions = chainPositions(run(makeHaltedRun()));
    expect(positions).toHaveLength(3);
    expect(positions.map((position) => position.kind)).toEqual([
      'completed',
      'failed',
      'not_started',
    ]);
  });

  it('folds retries into one position and reports the latest attempt’s state', () => {
    const positions = chainPositions(
      run(
        makeRun({
          stepCount: 2,
          steps: [
            makeRunStep(),
            makeRunStep({ ordinal: 1, attempt: 0, state: 'failed', agentId: QA_ID }),
            makeRunStep({ ordinal: 1, attempt: 1, state: 'running', agentId: QA_ID }),
          ],
        }),
      ),
    );
    expect(positions[1]?.attempts).toHaveLength(2);
    expect(positions[1]?.kind).toBe('running');
    expect(positions[1]?.latest?.attempt).toBe(1);
  });

  it('extends past the snapshot when an attempt exists beyond it', () => {
    const positions = chainPositions(
      run(makeRun({ stepCount: 1, steps: [makeRunStep(), makeRunStep({ ordinal: 1 })] })),
    );
    expect(positions).toHaveLength(2);
  });

  it('names an unreached step’s agent only from a definition that still applies', () => {
    const workflow = readWorkflow(makeWorkflow({ updatedAt: '2026-08-13T00:00:00.000Z' }));
    const halted = run(makeHaltedRun({ stepCount: 2 }));
    expect(definitionApplies(halted, workflow)).toBe(true);

    const edited = readWorkflow(makeWorkflow({ updatedAt: '2026-08-15T00:00:00.000Z' }));
    expect(definitionApplies(halted, edited)).toBe(false);

    const threeStep = run(makeHaltedRun());
    // The definition has two steps and the run recorded three — it has been edited since.
    expect(definitionApplies(threeStep, workflow)).toBe(false);
    expect(chainPositions(threeStep, workflow)[2]?.agentId).toBeNull();
  });
});

describe('runHalt', () => {
  it('reports a failed step and the steps that never started', () => {
    const halt = runHalt(chainPositions(run(makeHaltedRun())));
    expect(halt).toMatchObject({
      halted: true,
      failedPosition: 2,
      unstarted: 1,
      completedBefore: 1,
      total: 3,
    });
  });

  it('is derived from the steps, not from the run’s state word', () => {
    // The same attempts under a state word this build has never seen still read as a halt.
    const halt = runHalt(chainPositions(run(makeHaltedRun({ state: 'exploded' }))));
    expect(halt.halted).toBe(true);
    expect(halt.failedPosition).toBe(2);
  });

  it('reports no halt for a healthy run', () => {
    const halt = runHalt(chainPositions(run(makeRun())));
    expect(halt.halted).toBe(false);
    expect(halt.failedPosition).toBeNull();
  });
});

describe('runProgress', () => {
  it('counts completed steps and locates the running one', () => {
    expect(runProgress(chainPositions(run(makeRun())))).toMatchObject({
      total: 2,
      completed: 1,
      runningPosition: 2,
    });
  });
});

describe('stepSessionDisagreement', () => {
  it('flags a step the run calls finished whose session is still alive', () => {
    expect(stepSessionDisagreement('stopped', 'running')).toContain('still ‹running›');
    expect(stepSessionDisagreement('completed', 'paused')).not.toBeNull();
  });

  it('flags a step the run calls running whose session is already over', () => {
    expect(stepSessionDisagreement('running', 'failed')).toContain('already ‹failed›');
  });

  it('says nothing when they agree or when there is nothing to compare', () => {
    expect(stepSessionDisagreement('running', 'running')).toBeNull();
    expect(stepSessionDisagreement('completed', 'completed')).toBeNull();
    expect(stepSessionDisagreement('completed', null)).toBeNull();
  });
});

describe('handoffNote', () => {
  const step = (handoffState: string, handoffReason: string | null = null) => ({
    ordinal: 0,
    attempt: 0,
    agentId: DEVELOPER_ID,
    sessionId: null,
    state: 'running',
    handoffState,
    handoffReason,
    handoffPromptBytes: null,
    error: null,
    startedAt: null,
    completedAt: null,
    promptSentAt: null,
    unrecognised: [],
    raw: null,
  });

  it('quotes a degraded hand-off’s reason verbatim', () => {
    const note = handoffNote(
      step('degraded', 'context package unavailable: session 3 has no messages'),
    );
    expect(note?.kind).toBe('degraded');
    expect(note?.text).toBe('context package unavailable: session 3 has no messages');
  });

  it('does not call the first step degraded', () => {
    expect(handoffNote(step('none'))?.kind).toBe('none');
    expect(handoffNote(step('full'))?.kind).toBe('full');
  });

  it('says so when the state is one this build does not recognise', () => {
    expect(handoffNote(step('partial'))?.kind).toBe('unknown');
    expect(handoffNote(step(''))).toBeNull();
  });
});
