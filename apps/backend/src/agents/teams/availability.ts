import type { Db } from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { serializeAgent } from '../serialize.js';
import { projectExists } from '../store.js';
import type { ProjectAvailableAgentsResource } from './serialize.js';
import {
  findTeamAssignedToProject,
  listAgentsAvailableToProject,
  listTeamMembers,
} from './store.js';

/**
 * `GET /api/v1/projects/{id}/available-agents` — **the read that makes a team mean something.**
 *
 * Without it a team is a named list nothing consults: the roster would be editable and displayable
 * and would change nothing about what an operator can do. This is the consumer.
 *
 * ## What "available" means, and why it is one query
 *
 * It means *bindable to a new Session in this Project*. That rule already existed, but only as a
 * refusal buried inside `AgentBindingResolver.resolveForSession` — an agent from another project
 * is rejected, an archived one is rejected, a session-scoped one is rejected. A rule that exists
 * only as a refusal produces a UI that offers choices which then fail, which is the same defect
 * `GET /agents?includeArchived=false` was written to avoid. `listAgentsAvailableToProject` states
 * the positive form, and the integration tier holds the two to each other: every agent this read
 * returns can actually be bound, and the ones it omits cannot.
 *
 * ## What the team adds
 *
 * Not membership of the set — the scope constraints on `agent_team_members` guarantee every
 * member of an assigned team is already in it. What it adds is **emphasis**: `onTeam` says which
 * of the available agents are the ones this project's operator chose to work with, so a launch
 * picker can lead with them instead of showing an undifferentiated list. That is exactly what
 * PRD §5.7's example (Product Owner, Architect, Developer, QA, Security) is for.
 *
 * ## No pagination, deliberately
 *
 * F5.3 paginates *lists*; this is a composite document (a team and a set), the same shape as
 * `GET /services/health` and `GET /schedule`. The set is bounded by how many agents an operator
 * has defined — tens, on a single-operator install — and a picker that silently omitted one
 * would be the failure this read exists to prevent. If that ever stops being true the fix is a
 * cursor on the `agents` array, not a truncation nobody is told about.
 */
export async function readProjectAvailableAgents(
  db: Db,
  projectId: string,
): Promise<ProjectAvailableAgentsResource> {
  // Checked first so an unknown Project is a `404` rather than an empty roster — "this project
  // has no agents" and "this project does not exist" are different answers.
  if (!(await projectExists(db, projectId))) {
    throw new ApiError('NOT_FOUND', `No project with id ${projectId}`);
  }

  const [agents, assignment] = await Promise.all([
    listAgentsAvailableToProject(db, projectId),
    findTeamAssignedToProject(db, projectId),
  ]);

  if (assignment === null) {
    return {
      projectId,
      team: null,
      agents: agents.map((row) => ({ ...serializeAgent(row), onTeam: false })),
    };
  }

  const members = await listTeamMembers(db, [assignment.team.id]);
  const memberIds = new Set(members.map((member) => member.agentId));

  return {
    projectId,
    team: {
      id: assignment.team.id,
      name: assignment.team.name,
      description: assignment.team.description,
      scope: assignment.team.scope as 'global' | 'project',
      projectId: assignment.team.projectId,
      memberCount: members.length,
      // The seats that exist and cannot be filled. This is the whole reason the count is here:
      // it is the difference between "your team is five people" and the four rows flagged
      // `onTeam` below, and without it that gap is silent.
      archivedMemberCount: members.filter((member) => member.archivedAt !== null).length,
      assignedAt: assignment.assignedAt.toISOString(),
    },
    agents: agents.map((row) => ({ ...serializeAgent(row), onTeam: memberIds.has(row.id) })),
  };
}
