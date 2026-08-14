import { AGENT_TEAM_SCOPES } from '@mc/shared';
import {
  type Assert,
  arrayOf,
  booleanValue,
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
import { agentRuntimeSchema, agentSchema, agentScopeSchema } from '../response-schemas.js';
import type {
  AgentTeamMemberResource,
  AgentTeamResource,
  AssignedTeamResource,
  AvailableAgentResource,
  ProjectAvailableAgentsResource,
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

export const projectAvailableAgentsSchema = objectSchema('ProjectAvailableAgents', {
  projectId: entityId,
  /** `null` when no team is assigned — a Project without a team still has available agents. */
  team: nullable(assignedTeamSchema),
  agents: arrayOf(availableAgentSchema),
});
export type _ProjectAvailableAgentsShape = Assert<
  ExactShape<ProjectAvailableAgentsResource, typeof projectAvailableAgentsSchema>
>;
