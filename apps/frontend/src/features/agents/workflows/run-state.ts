import type { RunStepView, WorkflowRunView, WorkflowView } from './shape.js';

/**
 * Run and step states, and the reconstruction of the chain from a run's attempts.
 *
 * ## `halted` is not `failed`, and this file is where that is enforced
 *
 * The Backend's vocabulary is four words — `running`, `completed`, `halted`, `stopped` — and
 * **`halted` is not terminal**: a step failed, the chain stopped there rather than handing rejected
 * work to the next agent, and the operator can fix what broke and resume. Nothing was lost: the
 * earlier steps' commits are on disk and their transcripts are intact.
 *
 * So a halted run is drawn in **amber**, with the failing step named, the halt reason quoted
 * verbatim, and the steps that never started counted. It is never drawn as a crash, and the word
 * "failed" is used only for the *step*, which is the only thing that actually failed.
 *
 * ## Why states are classified rather than typed
 *
 * `AGENT_WORKFLOW_RUN_STATES` is a closed set in `@mc/shared/types` and a CHECK constraint behind
 * it, so a fifth value cannot be stored today. The classification exists anyway because the two
 * apps ship separately: this build will meet a Backend newer than itself, and a state word it does
 * not know must render **verbatim, in neutral colours, marked unrecognised** rather than be coerced
 * into the nearest thing this build can draw. Drawing an unknown state as "completed" would report
 * the end of something that is still spending money.
 *
 * ## Colours come from the status ramp, never the session-state ramp
 *
 * `--color-state-*` is keyed verbatim to the six F7 Session states (`theme.css`, consumption rule
 * 1). A run is not a Session — and each step *contains* one, whose own badge sits on the same row.
 * Two meanings in one palette on one row is exactly the ambiguity the token split prevents.
 */

export type RunStateKind = 'running' | 'completed' | 'halted' | 'stopped' | 'unknown';

export type StepStateKind = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';

/**
 * The Backend's four run states, plus the spellings a future one might plausibly use.
 *
 * The aliases are not speculation about *this* Backend — they are what keeps a rename from turning
 * the run screen grey. Anything not listed stays `unknown` and says so.
 */
const RUN_KINDS: Readonly<Record<string, RunStateKind>> = {
  running: 'running',
  in_progress: 'running',
  completed: 'completed',
  succeeded: 'completed',
  halted: 'halted',
  blocked: 'halted',
  stopped: 'stopped',
  cancelled: 'stopped',
  canceled: 'stopped',
};

const STEP_KINDS: Readonly<Record<string, StepStateKind>> = {
  running: 'running',
  in_progress: 'running',
  completed: 'completed',
  succeeded: 'completed',
  failed: 'failed',
  error: 'failed',
  stopped: 'stopped',
  cancelled: 'stopped',
  canceled: 'stopped',
};

export function runStateKind(state: string): RunStateKind {
  return RUN_KINDS[state.trim().toLowerCase()] ?? 'unknown';
}

export function stepStateKind(state: string): StepStateKind {
  return STEP_KINDS[state.trim().toLowerCase()] ?? 'unknown';
}

/**
 * Over: nothing more will launch unless the operator asks again.
 *
 * **`halted` is deliberately absent.** `TERMINAL_AGENT_WORKFLOW_RUN_STATES` in `@mc/shared/types`
 * is `['completed', 'stopped']`, and a halted run is a run waiting for a decision — the whole
 * point of the state.
 */
export function isTerminalRunKind(kind: RunStateKind): boolean {
  return kind === 'completed' || kind === 'stopped';
}

/**
 * Whether Stop is legal.
 *
 * `running` **and** `halted`, transcribed from `AgentWorkflowRunService.stop` — a terminal run
 * answers `409` naming its state, so no button is drawn for one. Halted is included because such a
 * run still holds its Project's single active-run slot until it is stopped or resumed, so stopping
 * it is a real action rather than a no-op on a dead row.
 */
export function canStopRun(kind: RunStateKind): boolean {
  return kind === 'running' || kind === 'halted';
}

/** True when the operator can pick the chain up where it broke. */
export function canResumeRun(kind: RunStateKind): boolean {
  return kind === 'halted';
}

export interface StatePresentation {
  /** Glyph — colour is never the only channel (TDS 06 §2.1.6). */
  readonly glyph: string;
  /** A status-ramp CSS variable, or `null` for the neutral (muted) treatment. */
  readonly colorVar: string | null;
  readonly subtleVar: string | null;
}

const NEUTRAL: StatePresentation = { glyph: '○', colorVar: null, subtleVar: null };
const UNKNOWN: StatePresentation = { glyph: '?', colorVar: null, subtleVar: null };

export function runStatePresentation(kind: RunStateKind): StatePresentation {
  switch (kind) {
    case 'running':
      return { glyph: '▶', colorVar: '--color-info', subtleVar: '--color-info-subtle' };
    case 'completed':
      return { glyph: '✓', colorVar: '--color-success', subtleVar: '--color-success-subtle' };
    // Amber, not red. A halt is the design working: the chain stopped where it was told to, and
    // the operator can resume it.
    case 'halted':
      return { glyph: '▲', colorVar: '--color-warning', subtleVar: '--color-warning-subtle' };
    case 'stopped':
      return { glyph: '■', colorVar: '--color-warning', subtleVar: '--color-warning-subtle' };
    default:
      return UNKNOWN;
  }
}

export function stepStatePresentation(kind: StepStateKind): StatePresentation {
  switch (kind) {
    case 'running':
      return { glyph: '▶', colorVar: '--color-info', subtleVar: '--color-info-subtle' };
    case 'completed':
      return { glyph: '✓', colorVar: '--color-success', subtleVar: '--color-success-subtle' };
    case 'failed':
      return { glyph: '✕', colorVar: '--color-danger', subtleVar: '--color-danger-subtle' };
    case 'stopped':
      return { glyph: '■', colorVar: '--color-warning', subtleVar: '--color-warning-subtle' };
    default:
      return UNKNOWN;
  }
}

/** A position the run has not reached. Not a state the Backend stores — see `chainPositions`. */
export const NOT_STARTED: StatePresentation = NEUTRAL;

export function displayState(state: string): string {
  return state.trim().length === 0 ? 'not stated' : state;
}

// -------------------------------------------------------------------------- the chain on screen

export interface ChainPosition {
  /** 0-based, as stored. */
  readonly ordinal: number;
  /** 1-based, as rendered — operators count from one. */
  readonly position: number;
  /** Every attempt at this position, oldest first. Empty when the run never got here. */
  readonly attempts: readonly RunStepView[];
  /** The attempt that decides this position's state — the highest `attempt`. */
  readonly latest: RunStepView | null;
  /** `''` when the run never reached this position. */
  readonly state: string;
  readonly kind: StepStateKind | 'not_started';
  /**
   * Which agent ran, or is expected to run, here.
   *
   * From the attempt when there is one — that is history and is always right. For a position the
   * run never reached it can only come from **today's definition**, which may have been edited
   * since the run started; `agentFromDefinition` says which of the two it is, so the screen can
   * hedge exactly where hedging is warranted and nowhere else.
   */
  readonly agentId: string | null;
  readonly agentFromDefinition: boolean;
}

/**
 * Whether today's definition can be used to name the steps this run has not reached.
 *
 * A run snapshots `stepCount` and nothing else about the chain — deliberately, so that editing a
 * workflow tomorrow cannot rewrite what yesterday's run did. The consequence is that this client
 * must not name the agent of an unreached step from a definition that has moved: it would be
 * confidently wrong, which is worse than blank.
 *
 * Two conditions, both cheap: the step count still matches, and the definition has not been updated
 * since the run started.
 */
export function definitionApplies(run: WorkflowRunView, workflow: WorkflowView | null): boolean {
  if (workflow === null || !workflow.stepsServed) return false;
  if (run.stepCount === null || workflow.steps.length !== run.stepCount) return false;
  if (workflow.updatedAt === null || run.startedAt === null) return false;
  return Date.parse(workflow.updatedAt) <= Date.parse(run.startedAt);
}

/**
 * The chain as a screen renders it: one row per position, attempts folded in.
 *
 * Length is the run's own `stepCount` — the snapshot — extended if the attempts somehow reach
 * further, because an attempt that exists is evidence and a count is only a number.
 */
export function chainPositions(
  run: WorkflowRunView,
  workflow: WorkflowView | null = null,
): readonly ChainPosition[] {
  const highestAttemptOrdinal = run.steps.reduce(
    (highest, step) => Math.max(highest, step.ordinal + 1),
    0,
  );
  const total = Math.max(run.stepCount ?? 0, highestAttemptOrdinal);
  const useDefinition = definitionApplies(run, workflow);

  const positions: ChainPosition[] = [];
  for (let ordinal = 0; ordinal < total; ordinal += 1) {
    const attempts = run.steps
      .filter((step) => step.ordinal === ordinal)
      .sort((a, b) => a.attempt - b.attempt);
    const latest = attempts.length === 0 ? null : (attempts[attempts.length - 1] as RunStepView);
    const definitionStep = useDefinition ? (workflow?.steps[ordinal] ?? null) : null;

    positions.push({
      ordinal,
      position: ordinal + 1,
      attempts,
      latest,
      state: latest?.state ?? '',
      kind: latest === null ? 'not_started' : stepStateKind(latest.state),
      agentId: latest?.agentId ?? definitionStep?.agentId ?? null,
      agentFromDefinition: latest === null && definitionStep !== null,
    });
  }

  return positions;
}

export interface RunProgress {
  readonly total: number;
  readonly completed: number;
  /** 1-based position currently running, or `null`. */
  readonly runningPosition: number | null;
  readonly runningStep: RunStepView | null;
  /** Positions the run never reached. */
  readonly notStarted: number;
}

export function runProgress(positions: readonly ChainPosition[]): RunProgress {
  const running = positions.find((entry) => entry.kind === 'running') ?? null;
  return {
    total: positions.length,
    completed: positions.filter((entry) => entry.kind === 'completed').length,
    runningPosition: running?.position ?? null,
    runningStep: running?.latest ?? null,
    notStarted: positions.filter((entry) => entry.kind === 'not_started').length,
  };
}

export interface RunHalt {
  /** A step failed and the chain stopped there. */
  readonly halted: boolean;
  /** 1-based position of the failed step. `null` when nothing failed. */
  readonly failedPosition: number | null;
  readonly failedStep: RunStepView | null;
  /** Positions after the failure that never started. The evidence the chain stopped. */
  readonly unstarted: number;
  /** Positions that completed before the failure — work that is done and is not rolled back. */
  readonly completedBefore: number;
  readonly total: number;
}

/**
 * What actually happened to the chain, derived from the attempts rather than from the state word.
 *
 * Deliberately independent of `run.state`: the sentence *"step 3 of 4 failed and step 4 never
 * started"* is true whether the Backend calls the run `halted`, `failed` or something this build
 * has never seen. The screens lead with this and use the state word as a label, not as the
 * explanation — which is what stops a halt from ever rendering as a crash.
 */
export function runHalt(positions: readonly ChainPosition[]): RunHalt {
  const failedIndex = positions.findIndex((entry) => entry.kind === 'failed');

  if (failedIndex === -1) {
    return {
      halted: false,
      failedPosition: null,
      failedStep: null,
      unstarted: positions.filter((entry) => entry.kind === 'not_started').length,
      completedBefore: positions.filter((entry) => entry.kind === 'completed').length,
      total: positions.length,
    };
  }

  const failed = positions[failedIndex] as ChainPosition;
  return {
    halted: true,
    failedPosition: failed.position,
    failedStep: failed.latest,
    unstarted: positions.slice(failedIndex + 1).filter((entry) => entry.kind === 'not_started')
      .length,
    completedBefore: positions.slice(0, failedIndex).filter((entry) => entry.kind === 'completed')
      .length,
    total: positions.length,
  };
}

// ------------------------------------------------------- the run's story vs the Session's own

/**
 * When the run's account of a step and the Session's own F7 state disagree, say so.
 *
 * This exists because of **Stop**. Stopping is documented to end the in-flight Session, and the way
 * to keep that claim honest is to keep rendering the thing that would contradict it: the Session's
 * own state, beside the step's, on the same row. A "stop" that left a Session running would be the
 * worst lie this screen could tell, and this check makes telling it impossible rather than
 * unlikely.
 *
 * `null` when they agree, when the step state is unknown, or when there is no Session to compare.
 */
export function stepSessionDisagreement(
  stepState: string,
  sessionState: string | null,
): string | null {
  if (sessionState === null) return null;
  const kind = stepStateKind(stepState);

  const sessionLive = sessionState === 'running' || sessionState === 'paused';
  const sessionOver =
    sessionState === 'completed' || sessionState === 'failed' || sessionState === 'archived';

  if ((kind === 'completed' || kind === 'failed' || kind === 'stopped') && sessionLive) {
    return `The run records this step as ‹${stepState}›, but its session is still ‹${sessionState}›. The session is the process — open it and end it there if it should not be running.`;
  }
  if (kind === 'running' && sessionOver) {
    return `The run records this step as ‹${stepState}›, but its session is already ‹${sessionState}›. The run may not have caught up yet; the session is the truth about the process.`;
  }
  return null;
}

// ------------------------------------------------------------------------------- the hand-off

export interface HandoffNote {
  readonly kind: 'none' | 'full' | 'degraded' | 'unknown';
  readonly text: string;
}

/**
 * What this step was handed by the one before it (`AGENT_WORKFLOW_HANDOFF_STATES`).
 *
 * Rendered because it is the crux of a chain: QA cannot review what it cannot see. `degraded`
 * always carries a reason — the database refuses the row otherwise — and that reason is quoted
 * verbatim, because it is the same text that was written into the agent's own prompt.
 */
export function handoffNote(step: RunStepView): HandoffNote | null {
  switch (step.handoffState) {
    case '':
      return null;
    case 'none':
      return {
        kind: 'none',
        text: 'First step — there was no previous session to hand anything over from.',
      };
    case 'full':
      return {
        kind: 'full',
        text: 'Received the previous step’s context package whole: working tree, files touched, commits, ADRs and related memory.',
      };
    case 'degraded':
      return {
        kind: 'degraded',
        text:
          step.handoffReason ??
          'The hand-off was incomplete and the Backend served no reason, which the schema says should be impossible.',
      };
    default:
      return {
        kind: 'unknown',
        text: `Hand-off state ‹${step.handoffState}› is not one this build recognises. It is shown exactly as served.`,
      };
  }
}
