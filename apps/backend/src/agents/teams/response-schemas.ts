import { AGENT_TEAM_SCOPES } from '@mc/shared';
import {
  type Assert,
  arrayOf,
  booleanValue,
  type Covers,
  describe,
  type ExactShape,
  entityId,
  enumSchema,
  integerValue,
  nullable,
  nullableEntityId,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringValue,
  timestampValue,
} from '../../http/response-schema.js';
import { AGENT_BINDING_REFUSALS, type AgentBindingRefusalReason } from '../binding.js';
import { agentRuntimeSchema, agentSchema, agentScopeSchema } from '../response-schemas.js';
import type {
  AgentTeamMemberResource,
  AgentTeamResource,
  AssignedTeamResource,
  AvailableAgentResource,
  ProjectAvailableAgentsResource,
  RefusedAgentResource,
} from './serialize.js';

/** The `AgentTeam` response shapes (TDS 04 §13.2.1, structure per PRD §5.7). */

export const agentTeamScopeSchema = enumSchema('AgentTeamScope', AGENT_TEAM_SCOPES);

export const agentTeamMemberSchema = objectSchema('AgentTeamMember', {
  agentId: entityId,
  name: stringValue,
  scope: agentScopeSchema,
  projectId: nullableEntityId,
  runtime: agentRuntimeSchema,
  /** Non-null means retired: still on the roster, not offered to a new Session. */
  archivedAt: nullableTimestamp,
  addedAt: timestampValue,
});
export type _AgentTeamMemberShape = Assert<
  ExactShape<AgentTeamMemberResource, typeof agentTeamMemberSchema>
>;

export const agentTeamSchema = objectSchema('AgentTeam', {
  id: entityId,
  name: stringValue,
  description: nullableString,
  scope: agentTeamScopeSchema,
  /** The team's **own** project (`scope: 'project'`), not the projects it is assigned to. */
  projectId: nullableEntityId,
  /** Ordered by agent name, and **includes archived members** — see `serialize.ts`. */
  members: arrayOf(agentTeamMemberSchema),
  projectIds: arrayOf(entityId),
  createdAt: timestampValue,
  updatedAt: timestampValue,
});
export type _AgentTeamShape = Assert<ExactShape<AgentTeamResource, typeof agentTeamSchema>>;

export const assignedTeamSchema = objectSchema('AssignedTeam', {
  id: entityId,
  name: stringValue,
  description: nullableString,
  scope: agentTeamScopeSchema,
  projectId: nullableEntityId,
  /** The roster size and how much of it is retired — together they explain the `agents` array. */
  memberCount: integerValue,
  archivedMemberCount: integerValue,
  assignedAt: timestampValue,
});
export type _AssignedTeamShape = Assert<
  ExactShape<AssignedTeamResource, typeof assignedTeamSchema>
>;

export const availableAgentSchema = objectSchema('AvailableAgent', {
  ...agentSchema.properties,
  onTeam: booleanValue,
});
export type _AvailableAgentShape = Assert<
  ExactShape<AvailableAgentResource, typeof availableAgentSchema>
>;

/**
 * The reasons `agentBindingRefusal` can give, as the document's own enum.
 *
 * `Covers<>` on the union is what stops this list drifting from the function: the array in
 * `agents/binding.ts` is spread in directly, so a sixth refusal is published here by construction.
 */
export const agentBindingRefusalSchema = enumSchema(
  // `…Reason`, not `AgentBindingRefusal`: the frontend's `lib/agents/binding.ts` already exports
  // that name for its own union, and two `export *` sources declaring one name silently remove it
  // from the `lib/api` barrel (see `http/response-schema.ts` on `ListEnvelopeMeta`).
  'AgentBindingRefusalReason',
  AGENT_BINDING_REFUSALS,
  'Why an Agent cannot be bound to a new Session in this Project. `session_not_yet` is the one temporary refusal: that agent becomes bindable through PATCH /sessions/{id} once its Session exists.',
);
export type _AgentBindingRefusalValues = Assert<
  Covers<AgentBindingRefusalReason, typeof AGENT_BINDING_REFUSALS>
>;

export const refusedAgentSchema = objectSchema('RefusedAgent', {
  agentId: entityId,
  name: stringValue,
  scope: agentScopeSchema,
  projectId: nullableEntityId,
  sessionId: nullableEntityId,
  runtime: agentRuntimeSchema,
  archivedAt: nullableTimestamp,
  reason: agentBindingRefusalSchema,
  /** The Backend's own sentence — the same one the write path answers with. See `serialize.ts`. */
  explanation: describe(
    stringValue,
    'The rule and the way out of it, in one operator-facing sentence. This is the identical string `POST /sessions` and `PATCH /sessions/{id}` answer with when the binding is attempted, because both come from one function.',
  ),
});
export type _RefusedAgentShape = Assert<
  ExactShape<RefusedAgentResource, typeof refusedAgentSchema>
>;

export const projectAvailableAgentsSchema = objectSchema('ProjectAvailableAgents', {
  projectId: entityId,
  /** The `?sessionId=` the refusals were computed against; `null` for the create-time question. */
  sessionId: describe(
    nullableEntityId,
    'The Session the refusals were computed against (`?sessionId=`), or null for the create-time question. It is what separates `session_not_yet` from `session_elsewhere`.',
  ),
  /** `null` when no team is assigned — a Project without a team still has available agents. */
  team: nullable(assignedTeamSchema),
  agents: arrayOf(availableAgentSchema),
  /** Every other Agent in the install, with the reason it is not offered here. */
  refused: arrayOf(refusedAgentSchema),
});
export type _ProjectAvailableAgentsShape = Assert<
  ExactShape<ProjectAvailableAgentsResource, typeof projectAvailableAgentsSchema>
>;
