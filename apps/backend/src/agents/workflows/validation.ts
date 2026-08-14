import {
  type AgentWorkflowScope,
  MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH,
  MAX_AGENT_WORKFLOW_NAME_LENGTH,
  MAX_AGENT_WORKFLOW_RUN_SESSIONS,
  MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH,
  MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
  MAX_AGENT_WORKFLOW_STEPS,
} from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { normalizeOptionalText } from '../validation.js';

/**
 * Workflow field rules, pure — so every one of them is unit tested with no database and no
 * Fastify, exactly as `agents/validation.ts` and `agents/teams/validation.ts` are.
 *
 * The route schemas already reject the wrong type and the wrong length; what is here is the
 * normalisation the storage layer depends on and the handful of semantic rules a JSON Schema
 * cannot state — scope must agree with its target, a chain must have at least one step, and a
 * Session budget must be able to pay for the chain it is given.
 */

export function normalizeWorkflowName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'name must not be blank', { field: 'name' });
  }
  if (trimmed.length > MAX_AGENT_WORKFLOW_NAME_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `name must be at most ${MAX_AGENT_WORKFLOW_NAME_LENGTH} characters`,
      { field: 'name' },
    );
  }
  return trimmed;
}

export function normalizeWorkflowDescription(value: string | null | undefined): string | null {
  const text = normalizeOptionalText(value);
  if (text !== null && text.length > MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `description must be at most ${MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH} characters`,
      { field: 'description' },
    );
  }
  return text;
}

export function normalizeStepInstructions(value: string | null | undefined): string | null {
  const text = normalizeOptionalText(value);
  if (text !== null && text.length > MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `steps[].instructions must be at most ${MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH} characters`,
      { field: 'steps' },
    );
  }
  return text;
}

/**
 * The operator's goal for a run.
 *
 * Required and non-blank, because it is the *only* thing step 1 is told to do: an Agent's
 * instructions say who it is, a step's instructions say what its position in the chain is for,
 * and neither of them says what the operator actually wants. A run without a task would launch a
 * persona at an empty brief.
 */
export function normalizeRunTask(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'task must not be blank', { field: 'task' });
  }
  if (trimmed.length > MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `task must be at most ${MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH} characters`,
      { field: 'task' },
    );
  }
  return trimmed;
}

/**
 * PRD §5.6's scope, and the target it is required to name.
 *
 * The database refuses every other combination (`ck_agent_workflows_scope_target`), so this
 * function's job is not correctness — it is *the error message*, the same division of labour
 * `assertScopeTarget` keeps for agents.
 */
export function assertWorkflowScopeTarget(input: {
  readonly scope: AgentWorkflowScope;
  readonly projectId: string | null;
}): void {
  if (input.scope === 'project' && input.projectId === null) {
    throw new ApiError('VALIDATION_FAILED', "A 'project' scoped workflow requires projectId", {
      field: 'projectId',
      scope: input.scope,
    });
  }
  if (input.scope === 'global' && input.projectId !== null) {
    throw new ApiError('VALIDATION_FAILED', "A 'global' scoped workflow must not name a project", {
      field: 'projectId',
      scope: input.scope,
    });
  }
}

/**
 * A chain has at least one step and at most `MAX_AGENT_WORKFLOW_STEPS`.
 *
 * The upper bound is also `ck_agent_workflow_steps_ordinal`, so this is the message rather than
 * the guarantee. The **lower** bound has no constraint behind it — a row cannot count its
 * siblings — and it matters more: a zero-step workflow is startable, launches nothing, and
 * completes instantly, which reads as a product defect rather than as the empty definition it is.
 */
export function assertStepCount(count: number): void {
  if (count === 0) {
    throw new ApiError('VALIDATION_FAILED', 'A workflow needs at least one step', {
      field: 'steps',
    });
  }
  if (count > MAX_AGENT_WORKFLOW_STEPS) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `A workflow may have at most ${MAX_AGENT_WORKFLOW_STEPS} steps`,
      { field: 'steps', max: MAX_AGENT_WORKFLOW_STEPS },
    );
  }
}

/**
 * The Session budget for a run — the spend bound the operator controls.
 *
 * It must be able to pay for the chain at least once (otherwise the run is guaranteed to strand
 * mid-way, which is a worse outcome than refusing it) and it may not exceed the absolute ceiling
 * `ck_agent_workflow_runs_max_sessions` enforces. Both refusals name the number, because "invalid
 * maxSessions" tells an operator nothing about which way to move it.
 */
export function assertMaxSessions(maxSessions: number, stepCount: number): void {
  if (maxSessions < stepCount) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `maxSessions must be at least the workflow's step count (${stepCount})`,
      { field: 'maxSessions', stepCount },
    );
  }
  if (maxSessions > MAX_AGENT_WORKFLOW_RUN_SESSIONS) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `maxSessions must be at most ${MAX_AGENT_WORKFLOW_RUN_SESSIONS}`,
      { field: 'maxSessions', max: MAX_AGENT_WORKFLOW_RUN_SESSIONS },
    );
  }
}
