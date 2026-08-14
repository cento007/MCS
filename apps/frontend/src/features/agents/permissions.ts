import { type AgentPermissions, isEnforceableAgentPermissions } from '@mc/shared/types';
import type { PermissionsShape } from '../../lib/agents/index.js';
import type { Draft } from '../../lib/forms/dirty.js';

/**
 * The **draft half** of the agent permission model — the part only the Builder form needs.
 *
 * The read half (the three capabilities, their labels, the `disallowedTools` evidence, the
 * summary, and the argument for why PRD §5.5's other nine permissions have no switch) moved to
 * `lib/agents/permissions.ts` when the Launch Session modal had to state what binding an agent
 * *removes* from a session. Two feature slices cannot import each other (TDS 05 §2.1), and two
 * copies of "which tools does denying `write` take away" is precisely the drift that would make
 * one screen's promise differ from another's. It is re-exported below, so nothing in this slice
 * changed its imports.
 */

export {
  type PermissionRow,
  type PermissionSummary,
  type PermissionsShape,
  REPOSITORY_CAPABILITIES,
  REPOSITORY_GROUP,
  type RepositoryCapability,
  readAgentPermissions,
  summarisePermissions,
  UNMODELLED_PERMISSIONS,
} from '../../lib/agents/index.js';

/** Draft keys are the dotted permission paths, prefixed so they cannot collide with a scalar. */
export function permissionDraftKey(path: string): string {
  return `permissions.${path}`;
}

export function toPermissionsDraft(shape: PermissionsShape): Record<string, boolean> {
  const draft: Record<string, boolean> = {};
  for (const row of shape.rows) draft[permissionDraftKey(row.path)] = row.granted;
  return draft;
}

export function permissionsFromDraft(draft: Draft): AgentPermissions {
  return {
    repository: {
      read: draft[permissionDraftKey('repository.read')] === true,
      write: draft[permissionDraftKey('repository.write')] === true,
      shell: draft[permissionDraftKey('repository.shell')] === true,
    },
  };
}

/**
 * The Backend's own invariant, imported rather than restated: **`shell` subsumes `read` and
 * `write`.** A shell can `cat` a file and can `>` one, so `{ read: false, shell: true }` is a
 * denial that does not hold — it is refused at the API boundary and by
 * `ck_agents_permissions_shell_subsumes`.
 *
 * The form consults this so the refusal happens where the operator can act on it, not as a `400`
 * after they press Save. One function, so the two can never disagree about what is storable.
 */
export function isEnforceable(draft: Draft): boolean {
  return isEnforceableAgentPermissions(permissionsFromDraft(draft));
}
