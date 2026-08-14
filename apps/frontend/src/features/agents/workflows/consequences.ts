import type { AgentView } from '../../../lib/agents/index.js';
import type { WorkflowStepView } from './shape.js';

/**
 * What a run is actually about to do — the substance of the pre-run screen (PRD §5.5, §5.6).
 *
 * ## Why this file exists
 *
 * Starting a workflow is the first thing in this product that spawns **several** AI sessions in
 * sequence with no further human input. Each one spends money and each one can change files in a
 * real working directory. A single `[Run]` button would make that a one-click act whose
 * consequences are only discoverable afterwards, from a transcript, at which point the commits have
 * happened.
 *
 * So the same argument that produced the Launch dialog's `disallowedTools` disclosure is applied one
 * level up, to a chain: for every step, what the agent may do — derived from the **Backend's own**
 * permission model, never from the step or the workflow, which carry no permissions at all.
 *
 * ## The sharp end: `shell`
 *
 * `repository.shell` is Bash. `apps/backend/src/agents/permissions.ts` argues at length that PRD
 * §5.5's Commit / Create PR / Merge / Delete cannot be separated from it — they are all `git` and
 * `gh` invocations through the one tool — so a step whose agent has `shell` can commit, push and
 * merge, and no smaller true statement is available. That sentence belongs in front of the operator
 * *before* the run, not in the permissions documentation.
 *
 * ## What it refuses to claim
 *
 * - An agent this client cannot resolve produces `agent: null` and blocks the acknowledgement. A
 *   step whose persona cannot be named is a step whose consequences cannot be stated.
 * - `removes: null` means the Backend served no `disallowedTools` for that agent, so enforcement is
 *   unproven. It is reported as unproven and never upgraded — under-claiming makes an operator
 *   careful, over-claiming makes them careless, and only one of those is recoverable.
 */

export type StepCaution = 'shell' | 'unresolved' | 'archived' | 'tools_not_stated';

export interface StepConsequence {
  /** 1-based, matching how the chain is numbered everywhere on screen. */
  readonly position: number;
  readonly step: WorkflowStepView;
  /** `null` when the agent id could not be resolved against this instance's agents. */
  readonly agent: AgentView | null;
  readonly canRead: boolean;
  readonly canWrite: boolean;
  /** Arbitrary command execution — and therefore commit, push and merge. */
  readonly canShell: boolean;
  /** The Backend's derived deny list, verbatim. `null` when it served none. */
  readonly removes: readonly string[] | null;
  /** Every reason this step deserves a second look, most severe first. */
  readonly cautions: readonly StepCaution[];
  /** One sentence: what this step is allowed to do. Rendered as-is. */
  readonly summary: string;
}

function granted(agent: AgentView, key: 'read' | 'write' | 'shell'): boolean {
  return agent.permissions.rows.find((row) => row.key === key)?.granted ?? false;
}

export interface AgentCapabilities {
  readonly canRead: boolean;
  readonly canWrite: boolean;
  readonly canShell: boolean;
  readonly removes: readonly string[] | null;
  readonly summary: string;
}

/**
 * One agent's capabilities, in a sentence.
 *
 * Exported because two surfaces state it and they must state it identically: the chain editor, so a
 * dangerous chain is visible while it is being *designed*, and the pre-run dialog, where it is
 * acknowledged. Two wordings of "this can push to your repository" is how one of them ends up
 * softer than the other.
 */
export function capabilitiesOf(agent: AgentView): AgentCapabilities {
  const canRead = granted(agent, 'read');
  const canWrite = granted(agent, 'write');
  const canShell = granted(agent, 'shell');

  return {
    canRead,
    canWrite,
    canShell,
    removes: agent.permissions.disallowedTools,
    summary: canShell
      ? 'Reads and writes files, and runs any shell command — which is git and gh, so this step can commit, push and merge.'
      : canWrite
        ? 'Reads and writes files. It has no shell, so it cannot commit, push or merge.'
        : canRead
          ? 'Reads files only. It cannot write, and it has no shell.'
          : 'Neither reads nor writes files and has no shell. It can still talk, and it still costs tokens.',
  };
}

export function stepConsequence(
  step: WorkflowStepView,
  position: number,
  agent: AgentView | null,
): StepConsequence {
  if (agent === null) {
    return {
      position,
      step,
      agent: null,
      canRead: false,
      canWrite: false,
      canShell: false,
      removes: null,
      cautions: ['unresolved'],
      summary:
        'This agent could not be read from this instance, so what this step may do cannot be shown.',
    };
  }

  const capabilities = capabilitiesOf(agent);

  const cautions: StepCaution[] = [];
  if (capabilities.canShell) cautions.push('shell');
  // The step's own `agentArchivedAt` is preferred over the Agent resource's: it is the Backend's
  // answer about *this step*, and it is present even when the agents list could not be read.
  if (step.agentArchivedAt !== null || agent.archivedAt !== null) cautions.push('archived');
  if (capabilities.removes === null) cautions.push('tools_not_stated');

  return {
    position,
    step,
    agent,
    canRead: capabilities.canRead,
    canWrite: capabilities.canWrite,
    canShell: capabilities.canShell,
    removes: capabilities.removes,
    cautions,
    summary: capabilities.summary,
  };
}

export interface RunConsequences {
  readonly steps: readonly StepConsequence[];
  /** Positions of steps that can run arbitrary commands. The headline number. */
  readonly shellPositions: readonly number[];
  readonly writePositions: readonly number[];
  readonly unresolvedPositions: readonly number[];
  readonly archivedPositions: readonly number[];
  readonly toolsNotStatedPositions: readonly number[];
  /**
   * Whether the operator must tick the acknowledgement before the run can start.
   *
   * Required when a step can write, run commands, name an agent this client cannot read, or name
   * one whose enforcement the Backend will not confirm — i.e. whenever the consequences are either
   * material or unknown. A read-only chain of resolved agents starts without ceremony, for the same
   * reason the Launch dialog's branch disclosure stays quiet when the branch already matches:
   * ceremony that fires every time is ceremony nobody reads.
   */
  readonly requiresAcknowledgement: boolean;
}

export function runConsequences(
  steps: readonly WorkflowStepView[],
  agentOf: (agentId: string) => AgentView | null,
): RunConsequences {
  // `ordinal + 1`, not the array index: the projection sorts by ordinal, and a chain whose numbers
  // on screen disagree with the numbers a halt reports ("step 3 failed") is a chain nobody can act
  // on.
  const consequences = steps.map((step) =>
    stepConsequence(step, step.ordinal + 1, agentOf(step.agentId)),
  );

  const positionsWith = (caution: StepCaution): readonly number[] =>
    consequences
      .filter((consequence) => consequence.cautions.includes(caution))
      .map((consequence) => consequence.position);

  const shellPositions = positionsWith('shell');
  const writePositions = consequences
    .filter((consequence) => consequence.canWrite)
    .map((consequence) => consequence.position);
  const unresolvedPositions = positionsWith('unresolved');
  const archivedPositions = positionsWith('archived');
  const toolsNotStatedPositions = positionsWith('tools_not_stated');

  return {
    steps: consequences,
    shellPositions,
    writePositions,
    unresolvedPositions,
    archivedPositions,
    toolsNotStatedPositions,
    requiresAcknowledgement:
      shellPositions.length > 0 ||
      writePositions.length > 0 ||
      unresolvedPositions.length > 0 ||
      archivedPositions.length > 0 ||
      toolsNotStatedPositions.length > 0,
  };
}

/** `1, 2 and 4` — positions in prose, because "steps 1,2,4" reads as a filename. */
export function positionList(positions: readonly number[]): string {
  if (positions.length === 0) return '';
  if (positions.length === 1) return String(positions[0]);
  return `${positions.slice(0, -1).join(', ')} and ${positions[positions.length - 1]}`;
}
