import {
  type AgentTeamScope,
  MAX_AGENT_TEAM_DESCRIPTION_LENGTH,
  MAX_AGENT_TEAM_NAME_LENGTH,
} from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { normalizeOptionalText } from '../validation.js';

/**
 * AgentTeam field rules, pure — so every one of them is unit tested with no database and no
 * Fastify, exactly as `agents/validation.ts` is.
 *
 * The route schemas already reject the wrong *type*, the wrong *length* and an array that is too
 * long; what is here is the normalisation the storage layer depends on and the two semantic rules
 * a JSON Schema cannot state: scope must agree with its target, and an id list must be a set.
 */

export function normalizeTeamName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'name must not be blank', { field: 'name' });
  }
  if (trimmed.length > MAX_AGENT_TEAM_NAME_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `name must be at most ${MAX_AGENT_TEAM_NAME_LENGTH} characters`,
      { field: 'name' },
    );
  }
  return trimmed;
}

export function normalizeTeamDescription(value: string | null | undefined): string | null {
  const text = normalizeOptionalText(value);
  if (text !== null && text.length > MAX_AGENT_TEAM_DESCRIPTION_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `description must be at most ${MAX_AGENT_TEAM_DESCRIPTION_LENGTH} characters`,
      { field: 'description' },
    );
  }
  return text;
}

/**
 * PRD §5.7's two kinds of team, and the target each one names.
 *
 * The database refuses every other combination (`ck_agent_teams_scope_target`), so this
 * function's job is not correctness — it is *the error message*. Without it an operator who
 * posts a project-scoped team with no `projectId` gets a constraint violation rendered as
 * `DATABASE_SCHEMA_MISMATCH`, which names the wrong problem and blames the wrong thing. Same
 * division of labour as `assertScopeTarget` for agents.
 */
export function assertTeamScopeTarget(input: {
  readonly scope: AgentTeamScope;
  readonly projectId: string | null;
}): void {
  const { scope, projectId } = input;

  if (scope === 'project' && projectId === null) {
    throw new ApiError('VALIDATION_FAILED', "A 'project' scoped team requires projectId", {
      field: 'projectId',
      scope,
    });
  }
  if (scope === 'global' && projectId !== null) {
    throw new ApiError('VALIDATION_FAILED', "A 'global' scoped team must not name a project", {
      field: 'projectId',
      scope,
    });
  }
}

/**
 * An id list, de-duplicated, order preserved.
 *
 * Repeats are **not** an error: `{"agentIds": ["a", "a"]}` says the same thing twice, and
 * `ux_agent_team_members_team_agent` would turn the second one into a `409` describing a
 * conflict the caller did not create. Collapsing is the reading that matches what the field
 * means — a roster is a set (see `entities/agent-team.ts`) — and it keeps the write idempotent.
 * The *order* is preserved anyway so that error messages name ids in the order they were sent.
 */
export function normalizeIdList(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
