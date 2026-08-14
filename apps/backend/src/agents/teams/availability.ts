import type { Db } from '@mc/shared';
import { ApiError } from '../../http/errors.js';
import { agentBindingRefusal } from '../binding.js';
import { serializeAgent } from '../serialize.js';
import { projectExists } from '../store.js';
import type { ProjectAvailableAgentsResource, RefusedAgentResource } from './serialize.js';
import { serializeRefusedAgent } from './serialize.js';
import {
  findSessionProjectId,
  findTeamAssignedToProject,
  listAgentsForBinding,
  listTeamMembers,
} from './store.js';

/**
 * `GET /api/v1/projects/{id}/available-agents` — **the read that makes a team mean something, and
 * the read that makes bindability a server answer.**
 *
 * Without it a team is a named list nothing consults: the roster would be editable and displayable
 * and would change nothing about what an operator can do. This is the consumer.
 *
 * ## What "available" means, and why it is now one *function* rather than one query
 *
 * It means *bindable to a new Session in this Project*. That rule already existed, but only as a
 * refusal buried inside `AgentBindingResolver.resolveForSession` — an agent from another project
 * is rejected, an archived one is rejected, a session-scoped one is rejected. A rule that exists
 * only as a refusal produces a UI that offers choices which then fail, which is the same defect
 * `GET /agents?includeArchived=false` was written to avoid.
 *
 * The first fix for that was a SQL query stating the positive form, and it was half a fix: the
 * query and the throws were two implementations of one rule, and the launch picker then wrote a
 * third in TypeScript so it could *explain* the exclusions. This read now calls
 * `agentBindingRefusal` — the same function `POST /sessions` and `PATCH /sessions/{id}` enforce —
 * once per Agent, and reports both halves of its answer. A sixth refusal added to that function
 * appears here on the same commit, with its sentence, or it appears nowhere.
 *
 * ## Why the refused agents are returned at all
 *
 * Because the alternative is an absence. A picker fed only the available set cannot answer "where
 * did my Architect go" — and the answer is never "it does not exist". `refused` is the list of
 * agents this Project's launch picker must be able to name, each with the reason the API would
 * give and the sentence an operator can act on. `reason` distinguishes the one refusal that is
 * temporary: `session_not_yet` means *this agent is bindable, but only after the Session exists*,
 * which is a different instruction from "never here" and must not be flattened into a boolean.
 *
 * ## `?sessionId=` — the same question, asked about a Session that exists
 *
 * Without it this read can only answer the **create-time** question, and that turned a temporary
 * refusal into a permanent one for the surface that binds an *existing* Session
 * (`PATCH /sessions/{id}`): a session-scoped agent is `session_not_yet` against every context with
 * no Session, including the Session it belongs to. So the picker on that surface could never offer
 * the one agent that exists solely for it.
 *
 * The parameter supplies the missing half of `AgentBindingContext`, and nothing else changes: the
 * same function decides, so the agent that names this Session moves into `agents`, agents naming a
 * different one become `session_elsewhere`, and every other refusal is unaffected. A Session in
 * another Project is refused rather than answered, because the two halves of the context would
 * then disagree and every answer would be about a pairing that cannot exist.
 *
 * The context is echoed back as `sessionId` for the same reason `projectId` is: a cached document
 * whose answer was computed against a different Session is otherwise indistinguishable from a
 * fresh one, and `session_not_yet` versus `session_elsewhere` is exactly the distinction that
 * would be misread.
 *
 * ## What the team adds
 *
 * Not membership of the set — the scope constraints on `agent_team_members` guarantee every
 * member of an assigned team is already in it. What it adds is **emphasis**: `onTeam` says which
 * of the available agents are the ones this project's operator chose to work with, so a launch
 * picker can lead with them instead of showing an undifferentiated list. That is exactly what
 * PRD §5.7's example (Product Owner, Architect, Developer, QA, Security) is for.
 *
 * `onTeam` is deliberately **not** repeated on a refused row. The only way a team member can be
 * refused is by being archived — `session` agents cannot be members and a project team's members
 * are pinned to its project — and the team block already reports exactly that as
 * `archivedMemberCount`. A second spelling of one number is how two numbers start to disagree.
 *
 * ## No pagination, deliberately
 *
 * F5.3 paginates *lists*; this is a composite document (a team and two sets), the same shape as
 * `GET /services/health` and `GET /schedule`. The set is bounded by how many agents an operator
 * has defined — tens, on a single-operator install — and a picker that silently omitted one
 * would be the failure this read exists to prevent. If that ever stops being true the fix is a
 * cursor on the `agents` array, not a truncation nobody is told about.
 */
export async function readProjectAvailableAgents(
  db: Db,
  projectId: string,
  options: { readonly sessionId?: string | undefined } = {},
): Promise<ProjectAvailableAgentsResource> {
  // Checked first so an unknown Project is a `404` rather than an empty roster — "this project
  // has no agents" and "this project does not exist" are different answers.
  if (!(await projectExists(db, projectId))) {
    throw new ApiError('NOT_FOUND', `No project with id ${projectId}`);
  }

  const sessionId = options.sessionId ?? null;
  if (sessionId !== null) {
    const sessionProjectId = await findSessionProjectId(db, sessionId);
    if (sessionProjectId === null) {
      // A `400` naming the field, not a `404`: the Project in the path exists, and it is the
      // *query* that names something that does not.
      throw new ApiError('VALIDATION_FAILED', 'sessionId does not reference a known Session', {
        field: 'sessionId',
      });
    }
    if (sessionProjectId !== projectId) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'sessionId names a Session in a different Project, so there is no binding to answer about',
        { field: 'sessionId', sessionProjectId },
      );
    }
  }

  const [rows, assignment] = await Promise.all([
    listAgentsForBinding(db),
    findTeamAssignedToProject(db, projectId),
  ]);

  const members = assignment === null ? [] : await listTeamMembers(db, [assignment.team.id]);
  const memberIds = new Set(members.map((member) => member.agentId));

  const agents: ProjectAvailableAgentsResource['agents'][number][] = [];
  const refused: RefusedAgentResource[] = [];

  for (const row of rows) {
    // `sessionId: null` — the default — is the create-time context: "which agent may a *new*
    // Session in this project be launched as", which is what makes every session-scoped agent
    // `session_not_yet` rather than `session_elsewhere`. With `?sessionId=` it is the same
    // question about a Session that exists, decided by the same function.
    const refusal = agentBindingRefusal(row, { projectId, sessionId });
    if (refusal === null) {
      agents.push({ ...serializeAgent(row), onTeam: memberIds.has(row.id) });
      continue;
    }
    refused.push(serializeRefusedAgent(row, refusal));
  }

  return {
    projectId,
    sessionId,
    team:
      assignment === null
        ? null
        : {
            id: assignment.team.id,
            name: assignment.team.name,
            description: assignment.team.description,
            scope: assignment.team.scope as 'global' | 'project',
            projectId: assignment.team.projectId,
            memberCount: members.length,
            // The seats that exist and cannot be filled. This is the whole reason the count is
            // here: it is the difference between "your team is five people" and the four rows
            // flagged `onTeam` below, and without it that gap is silent.
            archivedMemberCount: members.filter((member) => member.archivedAt !== null).length,
            assignedAt: assignment.assignedAt.toISOString(),
          },
    agents,
    refused,
  };
}
