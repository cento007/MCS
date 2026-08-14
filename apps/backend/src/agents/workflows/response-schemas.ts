import {
  AGENT_WORKFLOW_HANDOFF_STATES,
  AGENT_WORKFLOW_RUN_STATES,
  AGENT_WORKFLOW_RUN_STEP_STATES,
  AGENT_WORKFLOW_SCOPES,
} from '@mc/shared';
import {
  type Assert,
  arrayOf,
  type ExactShape,
  entityId,
  enumSchema,
  inlineObject,
  integerValue,
  nullable,
  nullableEntityId,
  nullableInteger,
  nullableNumber,
  nullableString,
  nullableTimestamp,
  numberValue,
  objectSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../../http/response-schema.js';
import type { EstimateStep, WorkflowCostEstimate } from './estimate.js';
import type { StopResult } from './runs.js';
import type {
  AgentWorkflowResource,
  AgentWorkflowRunResource,
  AgentWorkflowRunStepResource,
  AgentWorkflowStepResource,
} from './serialize.js';

/**
 * The two `AgentWorkflow` resources plus the cost estimate (PRD §5.6, TDS 04 §13.2.2).
 *
 * A definition and a run are two shapes because they are two entities — one an operator edits,
 * one is history nobody may edit — and the schemas keep that split rather than merging them into
 * one document with half its fields conditionally meaningful.
 */

export const agentWorkflowScopeSchema = enumSchema('AgentWorkflowScope', AGENT_WORKFLOW_SCOPES);

export const agentWorkflowStepSchema = objectSchema('AgentWorkflowStep', {
  ordinal: integerValue,
  agentId: entityId,
  agentName: stringValue,
  agentScope: stringValue,
  agentProjectId: nullableEntityId,
  /** Shown rather than hidden: a run refuses to start while any step names an archived agent. */
  agentArchivedAt: nullableTimestamp,
  instructions: nullableString,
});
export type _AgentWorkflowStepShape = Assert<
  ExactShape<AgentWorkflowStepResource, typeof agentWorkflowStepSchema>
>;

export const agentWorkflowSchema = objectSchema('AgentWorkflow', {
  id: entityId,
  name: stringValue,
  description: nullableString,
  scope: agentWorkflowScopeSchema,
  projectId: nullableEntityId,
  steps: arrayOf(agentWorkflowStepSchema),
  stepCount: integerValue,
  archivedAt: nullableTimestamp,
  createdAt: timestampValue,
  updatedAt: timestampValue,
});
export type _AgentWorkflowShape = Assert<
  ExactShape<AgentWorkflowResource, typeof agentWorkflowSchema>
>;

const handoffSchema = objectSchema('AgentWorkflowHandoff', {
  state: enumSchema('AgentWorkflowHandoffState', AGENT_WORKFLOW_HANDOFF_STATES),
  /** Non-null iff `state === 'degraded'` — the machine reason, also written into the prompt. */
  reason: nullableString,
  /** Bytes of the prompt this step was sent; the text itself is in the Session's transcript. */
  promptBytes: integerValue,
});
export type _HandoffShape = Assert<
  ExactShape<AgentWorkflowRunStepResource['handoff'], typeof handoffSchema>
>;

export const agentWorkflowRunStepSchema = objectSchema('AgentWorkflowRunStep', {
  ordinal: integerValue,
  attempt: integerValue,
  agentId: entityId,
  /** The field that makes this resource useful: what happened is the Session's, not the run's. */
  sessionId: entityId,
  state: enumSchema('AgentWorkflowRunStepState', AGENT_WORKFLOW_RUN_STEP_STATES),
  handoff: handoffSchema,
  /** `null` while the Session's launch is still waiting for a concurrency slot (§6.2.1). */
  promptSentAt: nullableTimestamp,
  error: nullableString,
  startedAt: timestampValue,
  completedAt: nullableTimestamp,
});
export type _AgentWorkflowRunStepShape = Assert<
  ExactShape<AgentWorkflowRunStepResource, typeof agentWorkflowRunStepSchema>
>;

export const agentWorkflowRunSchema = objectSchema('AgentWorkflowRun', {
  id: entityId,
  workflowId: entityId,
  projectId: entityId,
  repositoryId: nullableEntityId,
  task: stringValue,
  workingDirectory: stringValue,
  branch: nullableString,
  model: nullableString,
  state: enumSchema('AgentWorkflowRunState', AGENT_WORKFLOW_RUN_STATES),
  /** The definition's step count **as of the start**, not as of now. */
  stepCount: integerValue,
  /** The furthest ordinal reached, 0-based; `null` before the first attempt row exists. */
  currentStepOrdinal: nullableInteger,
  maxSessions: integerValue,
  sessionsLaunched: integerValue,
  haltReason: nullableString,
  steps: arrayOf(agentWorkflowRunStepSchema),
  startedAt: timestampValue,
  completedAt: nullableTimestamp,
  createdAt: timestampValue,
  updatedAt: timestampValue,
});
export type _AgentWorkflowRunShape = Assert<
  ExactShape<AgentWorkflowRunResource, typeof agentWorkflowRunSchema>
>;

/**
 * `meta.stoppedSession` on `POST /agent-workflow-runs/{id}/stop`.
 *
 * "The run is stopped" and "the Claude Code session it launched is stopped" are two different
 * facts, and the operator pressing Stop is asking about the second one.
 */
export const stoppedSessionMetaSchema = inlineObject({
  stoppedSession: nullable(
    objectSchema('StoppedSession', {
      sessionId: entityId,
      outcome: stringEnum(['ended', 'cancelled', 'already_terminal']),
    }),
  ),
});
export type _StoppedSessionShape = Assert<
  ExactShape<
    StopResult['stoppedSession'],
    (typeof stoppedSessionMetaSchema)['properties']['stoppedSession']
  >
>;

const estimateStepSchema = objectSchema('WorkflowCostEstimateStep', {
  ordinal: integerValue,
  agentId: entityId,
  agentName: stringValue,
  /** `null` when this Agent has never run a Session that recorded a cost. */
  observed: nullable(
    objectSchema('WorkflowCostObserved', {
      sessionCount: integerValue,
      meanUsd: numberValue,
      maxUsd: numberValue,
    }),
  ),
});
export type _EstimateStepShape = Assert<ExactShape<EstimateStep, typeof estimateStepSchema>>;

export const workflowCostEstimateSchema = objectSchema('WorkflowCostEstimate', {
  workflowId: entityId,
  stepCount: integerValue,
  defaultMaxSessions: integerValue,
  /** Always `observed_sessions`. Named so a future basis cannot be mistaken for this one. */
  basis: stringEnum(['observed_sessions']),
  steps: arrayOf(estimateStepSchema),
  /** A floor, not a forecast — `stepsWithoutHistory` is what makes that legible. */
  projected: nullable(
    objectSchema('WorkflowCostProjection', {
      meanUsd: numberValue,
      maxUsd: numberValue,
      coveredSteps: integerValue,
    }),
  ),
  stepsWithoutHistory: integerValue,
  budget: objectSchema('WorkflowCostBudget', {
    dailyUsd: nullableNumber,
    spentTodayUsd: numberValue,
    /** `null` when no daily budget is configured — not `Infinity`, and not `0`. */
    remainingUsd: nullableNumber,
  }),
});
export type _WorkflowCostEstimateShape = Assert<
  ExactShape<WorkflowCostEstimate, typeof workflowCostEstimateSchema>
>;
