import { AGENT_RUNTIMES, AGENT_SCOPES, type AgentPermissions } from '@mc/shared';
import {
  type Assert,
  arrayOf,
  booleanValue,
  describe,
  type ExactShape,
  entityId,
  enumSchema,
  inlineObject,
  nullableEntityId,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { AgentResource } from './serialize.js';

/** The `Agent` response shape (TDS 04 §13.2, structure per PRD §5.3). */

export const agentScopeSchema = enumSchema('AgentScope', AGENT_SCOPES);
export const agentRuntimeSchema = enumSchema('AgentRuntime', AGENT_RUNTIMES);

/**
 * The permission document, spelled out to the same depth the *request* schema spells it.
 *
 * Three names, because three are the ones that map onto a control surface: the six PRD §5.5
 * permissions that are absent are argued in `packages/shared/src/entities/agent.ts`. Publishing a
 * fourth here would document a switch that does nothing.
 */
export const agentPermissionsSchema = objectSchema('AgentPermissions', {
  repository: inlineObject({
    read: booleanValue,
    write: booleanValue,
    shell: booleanValue,
  }),
});
export type _AgentPermissionsShape = Assert<
  ExactShape<AgentPermissions, typeof agentPermissionsSchema>
>;

export const agentSchema = objectSchema('Agent', {
  id: entityId,
  name: stringValue,
  description: nullableString,
  scope: agentScopeSchema,
  projectId: nullableEntityId,
  sessionId: nullableEntityId,
  runtime: agentRuntimeSchema,
  permissions: agentPermissionsSchema,
  /**
   * Derived from `permissions` by the same function the launch path calls, and never accepted on
   * a write. It is on the resource so the permission model can be *audited* rather than trusted —
   * `permissions` says what was asked for, this says what happens to the runtime.
   */
  disallowedTools: describe(
    arrayOf(stringValue),
    'Derived from `permissions` by the same function the launch path calls, and never accepted on a write. `permissions` says what was asked for; this says what actually happens to the runtime, so the model can be audited rather than trusted.',
  ),
  instructions: nullableString,
  archivedAt: nullableTimestamp,
  createdAt: timestampValue,
  updatedAt: timestampValue,
});
export type _AgentShape = Assert<ExactShape<AgentResource, typeof agentSchema>>;
