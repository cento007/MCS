import {
  type AgentPermissions,
  type AgentScope,
  isEnforceableAgentPermissions,
  MAX_AGENT_DESCRIPTION_LENGTH,
  MAX_AGENT_INSTRUCTIONS_LENGTH,
  MAX_AGENT_NAME_LENGTH,
  normalizeAgentPermissions,
} from '@mc/shared';
import { ApiError } from '../http/errors.js';

/**
 * Agent field rules, pure — so every one of them is unit tested with no database and no Fastify.
 *
 * The route schemas already reject the wrong *type* and the wrong *length*; what is here is the
 * normalisation the storage layer depends on (one representation for "unset") and the two
 * semantic rules a JSON Schema cannot state: scope must agree with its target, and a permission
 * set must be one the runtime can actually deliver.
 */

/** Trim, and collapse "" / whitespace-only to `null` — one storage representation for "unset". */
export function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function normalizeAgentName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ApiError('VALIDATION_FAILED', 'name must not be blank', { field: 'name' });
  }
  if (trimmed.length > MAX_AGENT_NAME_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `name must be at most ${MAX_AGENT_NAME_LENGTH} characters`,
      { field: 'name' },
    );
  }
  return trimmed;
}

export function normalizeAgentDescription(value: string | null | undefined): string | null {
  const text = normalizeOptionalText(value);
  if (text !== null && text.length > MAX_AGENT_DESCRIPTION_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `description must be at most ${MAX_AGENT_DESCRIPTION_LENGTH} characters`,
      { field: 'description' },
    );
  }
  return text;
}

export function normalizeAgentInstructions(value: string | null | undefined): string | null {
  const text = normalizeOptionalText(value);
  if (text !== null && text.length > MAX_AGENT_INSTRUCTIONS_LENGTH) {
    throw new ApiError(
      'VALIDATION_FAILED',
      `instructions must be at most ${MAX_AGENT_INSTRUCTIONS_LENGTH} characters`,
      { field: 'instructions' },
    );
  }
  return text;
}

/**
 * PRD §5.2's scope, and the target it is required to name.
 *
 * The database refuses every other combination (`ck_agents_scope_target`), so this function's job
 * is not correctness — it is *the error message*. Without it an operator who posts a
 * project-scoped agent with no `projectId` gets a constraint violation rendered as
 * `DATABASE_SCHEMA_MISMATCH`, which names the wrong problem and blames the wrong thing.
 */
export function assertScopeTarget(input: {
  readonly scope: AgentScope;
  readonly projectId: string | null;
  readonly sessionId: string | null;
}): void {
  const { scope, projectId, sessionId } = input;

  const required: Record<AgentScope, 'projectId' | 'sessionId' | null> = {
    global: null,
    project: 'projectId',
    session: 'sessionId',
  };

  const expected = required[scope];

  if (expected === 'projectId' && projectId === null) {
    throw new ApiError('VALIDATION_FAILED', "A 'project' scoped agent requires projectId", {
      field: 'projectId',
      scope,
    });
  }
  if (expected === 'sessionId' && sessionId === null) {
    throw new ApiError('VALIDATION_FAILED', "A 'session' scoped agent requires sessionId", {
      field: 'sessionId',
      scope,
    });
  }
  if (expected !== 'projectId' && projectId !== null) {
    throw new ApiError('VALIDATION_FAILED', `A '${scope}' scoped agent must not name a project`, {
      field: 'projectId',
      scope,
    });
  }
  if (expected !== 'sessionId' && sessionId !== null) {
    throw new ApiError('VALIDATION_FAILED', `A '${scope}' scoped agent must not name a session`, {
      field: 'sessionId',
      scope,
    });
  }
}

/**
 * Turn a request's `permissions` into the canonical document, refusing one the runtime cannot
 * deliver.
 *
 * `normalizeAgentPermissions` would silently *drop* an unenforceable `shell` — correct for
 * repairing an untrusted stored row, wrong for a request, where the operator asked for something
 * specific and deserves to be told it cannot be had. So the raw value is normalised, then
 * compared: if the normalisation had to remove anything, this is a 400 rather than a quiet
 * downgrade.
 */
export function normalizeRequestedPermissions(raw: unknown): AgentPermissions {
  const object = isRecord(raw) ? raw : {};
  const repository = isRecord(object['repository']) ? object['repository'] : {};
  const askedForShell = repository['shell'] === true;

  const permissions = normalizeAgentPermissions(raw);

  if (askedForShell && !permissions.repository.shell) {
    throw new ApiError(
      'VALIDATION_FAILED',
      'repository.shell grants arbitrary command execution, which subsumes read and write; ' +
        'grant those two as well, or drop shell',
      { field: 'permissions.repository.shell' },
    );
  }

  /* c8 ignore next 5 — unreachable while the normalizer clamps `shell`; asserted anyway because
     the invariant, not the normalizer, is what the rest of the system relies on. */
  if (!isEnforceableAgentPermissions(permissions)) {
    throw new ApiError('VALIDATION_FAILED', 'repository.shell requires read and write', {
      field: 'permissions.repository.shell',
    });
  }

  return permissions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
