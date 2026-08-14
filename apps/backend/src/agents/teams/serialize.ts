import type { AgentRuntime, AgentScope, AgentTeamScope } from '@mc/shared';
import type { AgentResource } from '../serialize.js';
import type { AgentTeamRow, TeamAssignmentView, TeamMemberView } from './store.js';

/**
 * `agent_teams` rows -> the `AgentTeam` API resource (TDS 04 §13.2, structure per PRD §5.7).
 *
 * ## Why a member is a summary and not an `Agent`
 *
 * `AgentResource` carries `instructions`, which `MAX_AGENT_INSTRUCTIONS_LENGTH` caps at 20 000
 * characters. PRD §5.7's example team has five members, so inlining the full resource would put
 * up to 100 KB of persona text into every team read — and a team screen shows a roster, not five
 * system prompts. The summary is exactly the fields a roster row needs, plus the two that decide
 * whether a seat is usable: `archivedAt`, and the `scope`/`projectId` pair that says where the
 * member is valid. `GET /agents/{id}` is one click away for everything else.
 *
 * ## `archivedAt` is on the member, and members are never filtered
 *
 * An Agent can be archived while a team still names it. The membership row survives — archive is
 * reversible, so dropping the seat would make un-archiving unable to restore the roster — and the
 * team resource keeps showing it with `archivedAt` set. Hiding it would turn a five-member team
 * into a four-member team with no explanation, which is the one thing worse than showing a
 * retired member: an operator cannot fix a gap they cannot see.
 *
 * The **project availability read** makes the opposite choice for the opposite reason — it is a
 * picker, and an archived agent cannot be bound, so offering one there would be offering a choice
 * that then fails. See `availability.ts`.
 */

/** One roster row: which Agent holds the seat, and whether the seat is usable. */
export interface AgentTeamMemberResource {
  readonly agentId: string;
  readonly name: string;
  readonly scope: AgentScope;
  readonly projectId: string | null;
  readonly runtime: AgentRuntime;
  /** Non-null means the agent is retired: still on the roster, not offered to a new Session. */
  readonly archivedAt: string | null;
  /** When the seat was first taken. */
  readonly addedAt: string;
}

export interface AgentTeamResource {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentTeamScope;
  /** The team's **own** project (`scope: 'project'`), not the projects it is assigned to. */
  readonly projectId: string | null;
  /** The roster, ordered by agent name. Includes archived members — see the header. */
  readonly members: readonly AgentTeamMemberResource[];
  /**
   * The Projects this team works on (PRD §5.7), ascending. At most one team per Project, so a
   * Project appears in exactly one team's list or in none.
   */
  readonly projectIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeAgentTeam(
  row: AgentTeamRow,
  members: readonly TeamMemberView[],
  assignments: readonly TeamAssignmentView[],
): AgentTeamResource {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as AgentTeamScope,
    projectId: row.projectId,
    members: members
      .filter((member) => member.teamId === row.id)
      .map((member) => ({
        agentId: member.agentId,
        name: member.name,
        scope: member.scope as AgentScope,
        projectId: member.projectId,
        runtime: member.runtime as AgentRuntime,
        archivedAt: member.archivedAt?.toISOString() ?? null,
        addedAt: member.addedAt.toISOString(),
      })),
    projectIds: assignments
      .filter((assignment) => assignment.teamId === row.id)
      .map((assignment) => assignment.projectId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The team block of `GET /projects/{id}/available-agents` — the same team, without its roster.
 *
 * The roster is not repeated because the `agents` array beside it already carries every member
 * that is usable here, each flagged `onTeam`. What that array cannot carry is a member it has
 * excluded, so the two counts are: `memberCount` is the size of the roster, and
 * `archivedMemberCount` is how much of it is retired. `5` and `1` together are the whole
 * explanation for why four agents are flagged `onTeam`; without the second number the operator
 * sees a team that quietly shrank.
 */
export interface AssignedTeamResource {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentTeamScope;
  readonly projectId: string | null;
  readonly memberCount: number;
  readonly archivedMemberCount: number;
  readonly assignedAt: string;
}

/** An agent a Session in this Project may be launched as, and whether it is on the team. */
export type AvailableAgentResource = AgentResource & { readonly onTeam: boolean };

export interface ProjectAvailableAgentsResource {
  readonly projectId: string;
  /** `null` when no team is assigned — a Project without a team still has available agents. */
  readonly team: AssignedTeamResource | null;
  readonly agents: readonly AvailableAgentResource[];
}
