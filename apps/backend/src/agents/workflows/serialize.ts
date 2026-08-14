import type {
  AgentWorkflowHandoffState,
  AgentWorkflowRunState,
  AgentWorkflowRunStepState,
  AgentWorkflowScope,
} from '@mc/shared';
import type {
  AgentWorkflowRow,
  AgentWorkflowRunRow,
  RunStepView,
  WorkflowStepView,
} from './store.js';

/**
 * Rows -> the two API resources (TDS 04 §13.2.2).
 *
 * Two shapes, because a workflow and a run are two entities and not two views of one: a workflow
 * is a definition an operator edits, a run is history nobody may edit. Merging them would put a
 * mutable `name` next to an immutable `task` in one document and invite a `PATCH` that means
 * different things per field.
 */

/** A step of the definition. The agent is summarised, never inlined whole. */
export interface AgentWorkflowStepResource {
  readonly ordinal: number;
  readonly agentId: string;
  readonly agentName: string;
  readonly agentScope: string;
  readonly agentProjectId: string | null;
  /**
   * Non-null when this step's Agent has been retired.
   *
   * Shown rather than hidden, for the reason a team shows archived members: a four-step chain
   * silently rendering three steps is a chain the operator cannot debug. It is also actionable —
   * a run refuses to start while any step names an archived agent, and this is the field that
   * says which one.
   */
  readonly agentArchivedAt: string | null;
  readonly instructions: string | null;
}

export interface AgentWorkflowResource {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentWorkflowScope;
  readonly projectId: string | null;
  readonly steps: readonly AgentWorkflowStepResource[];
  readonly stepCount: number;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeWorkflow(
  row: AgentWorkflowRow,
  steps: readonly WorkflowStepView[],
): AgentWorkflowResource {
  const mine = steps
    .filter((step) => step.workflowId === row.id)
    .map((step) => ({
      ordinal: step.ordinal,
      agentId: step.agentId,
      agentName: step.agentName,
      agentScope: step.agentScope,
      agentProjectId: step.agentProjectId,
      agentArchivedAt: step.agentArchivedAt?.toISOString() ?? null,
      instructions: step.instructions,
    }));

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as AgentWorkflowScope,
    projectId: row.projectId,
    steps: mine,
    stepCount: mine.length,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * One attempt at one step.
 *
 * `sessionId` is the field that makes this resource useful: everything about *what happened* —
 * the transcript, the cost, the files, the commits — is the Session's, and this document's job is
 * to say which Session that is rather than to restate any of it.
 */
export interface AgentWorkflowRunStepResource {
  readonly ordinal: number;
  readonly attempt: number;
  readonly agentId: string;
  readonly sessionId: string;
  readonly state: AgentWorkflowRunStepState;
  readonly handoff: {
    readonly state: AgentWorkflowHandoffState;
    /** Non-null iff `state === 'degraded'` — the machine reason, also written into the prompt. */
    readonly reason: string | null;
    /** Bytes of the prompt this step was sent. The text itself is in the Session's transcript. */
    readonly promptBytes: number;
  };
  /**
   * When the prompt actually reached the runtime.
   *
   * `null` while the Session's launch is still waiting for a concurrency slot (TDS 04 §6.2.1) —
   * which is a real, visible state of a run and not an error: the step exists, the Session
   * exists, and nothing has been said to it yet.
   */
  readonly promptSentAt: string | null;
  readonly error: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface AgentWorkflowRunResource {
  readonly id: string;
  readonly workflowId: string;
  readonly projectId: string;
  readonly repositoryId: string | null;
  readonly task: string;
  readonly workingDirectory: string;
  readonly branch: string | null;
  readonly model: string | null;
  readonly state: AgentWorkflowRunState;
  /** The definition's step count **as of the start**, not as of now. See the table's header. */
  readonly stepCount: number;
  /** The furthest ordinal reached, 0-based; `null` before the first attempt row exists. */
  readonly currentStepOrdinal: number | null;
  /** The spend bound: how many Sessions this run may launch, and how many it has. */
  readonly maxSessions: number;
  readonly sessionsLaunched: number;
  readonly haltReason: string | null;
  readonly steps: readonly AgentWorkflowRunStepResource[];
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeRun(
  row: AgentWorkflowRunRow,
  steps: readonly RunStepView[],
): AgentWorkflowRunResource {
  const mine = steps.filter((step) => step.runId === row.id);

  return {
    id: row.id,
    workflowId: row.workflowId,
    projectId: row.projectId,
    repositoryId: row.repositoryId,
    task: row.task,
    workingDirectory: row.workingDir,
    branch: row.branch,
    model: row.model,
    state: row.state as AgentWorkflowRunState,
    stepCount: row.stepCount,
    currentStepOrdinal: mine.length === 0 ? null : Math.max(...mine.map((step) => step.ordinal)),
    maxSessions: row.maxSessions,
    sessionsLaunched: row.sessionsLaunched,
    haltReason: row.haltReason,
    steps: mine.map((step) => ({
      ordinal: step.ordinal,
      attempt: step.attempt,
      agentId: step.agentId,
      sessionId: step.sessionId,
      state: step.state as AgentWorkflowRunStepState,
      handoff: {
        state: step.handoffState as AgentWorkflowHandoffState,
        reason: step.handoffReason,
        promptBytes: step.promptBytes,
      },
      promptSentAt: step.promptSentAt?.toISOString() ?? null,
      error: step.error,
      startedAt: step.startedAt.toISOString(),
      completedAt: step.completedAt?.toISOString() ?? null,
    })),
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
