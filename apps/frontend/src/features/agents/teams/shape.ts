import {
  AGENT_TEAM_SCOPES,
  type AgentTeamScope,
  isAgentTeamScope,
  MAX_AGENT_TEAM_DESCRIPTION_LENGTH,
  MAX_AGENT_TEAM_MEMBERS,
  MAX_AGENT_TEAM_NAME_LENGTH,
  MAX_AGENT_TEAM_PROJECTS,
} from '@mc/shared/types';
import type { AgentView } from '../../../lib/agents/index.js';

/**
 * The AgentTeam resource, projected and drafted (PRD §5.7, TDS 04 §13.2).
 *
 * ## The contract this was rebuilt against
 *
 * This slice was briefed with a *sketch* —
 * `{ id, name, description, members: [...], archivedAt, createdAt, updatedAt }`, with membership
 * ordering, roles and archived-member handling listed as open — and the Backend landed something
 * sharper. Four differences, all of them the Backend being more decided rather than less:
 *
 *  - **`scope` and `projectId`.** A team is `global` (usable anywhere, may hold only global agents)
 *    or `project` (belongs to one project, may hold global agents plus that project's own). Scope
 *    is immutable after create, exactly as an Agent's is.
 *  - **No `archivedAt`. Teams are `DELETE`d.** The argument that rules deletion out for an Agent —
 *    `sessions.agent_id`, `audit_log_entries.actor_id`, `memory_items.agent_id` all point at it —
 *    does not transfer, because nothing outside its own rows references a team. `DELETE` answers
 *    `204`, or `409` while the team is still assigned to a project.
 *  - **Membership is a first-class array with no role and no ordinal**, and the Backend argues
 *    both omissions: PRD §5.7's "roles" *are* agent names (an Agent's `instructions` define one
 *    persona), and ordering belongs to a workflow rather than to a set. Members come back sorted
 *    by agent name. So this screen draws no role field and no reorder handle — not because the
 *    fields might not exist, but because it is now settled that they do not.
 *  - **Assignment is `projectIds` on the team**, replaced wholesale by `PATCH`, rather than a
 *    sub-route. At most one team per Project.
 *
 * The defensive projection is kept anyway: `unrecognised` still collects everything this build does
 * not read, so the next field to land is visible on the first render rather than silently dropped.
 */

export {
  AGENT_TEAM_SCOPES,
  type AgentTeamScope,
  isAgentTeamScope,
  MAX_AGENT_TEAM_DESCRIPTION_LENGTH,
  MAX_AGENT_TEAM_MEMBERS,
  MAX_AGENT_TEAM_NAME_LENGTH,
  MAX_AGENT_TEAM_PROJECTS,
};

const SCOPE_LABELS: Readonly<Record<AgentTeamScope, string>> = {
  global: 'Global',
  project: 'Project',
};

export function teamScopeLabel(scope: string): string {
  return isAgentTeamScope(scope) ? SCOPE_LABELS[scope] : scope;
}

export function teamScopeDescription(scope: string): string {
  switch (scope) {
    case 'global':
      return 'Reusable across projects, and therefore restricted to global agents: a team that can be assigned anywhere must not contain an agent that is only meaningful inside one project.';
    case 'project':
      return 'Belongs to one project. It may hold global agents and that project’s own agents, and it can only be assigned to that project.';
    default:
      return 'This Backend uses a team scope this build does not recognise. It is shown exactly as served and never rewritten.';
  }
}

/**
 * One roster row.
 *
 * The Backend serves a **summary** rather than the whole Agent, and says why: a five-member team of
 * full `Agent` resources would carry up to 100 KB of persona text. The two fields that decide
 * whether a seat is usable are here — `archivedAt`, and the `scope`/`projectId` pair.
 */
export interface TeamMemberView {
  readonly agentId: string;
  readonly name: string;
  readonly scope: string;
  readonly projectId: string | null;
  readonly runtime: string;
  /** Non-null means retired: still on the roster, not offered to a new Session. */
  readonly archivedAt: string | null;
  readonly addedAt: string | null;
  /** Keys on the member element this build does not read. */
  readonly unrecognised: readonly string[];
  readonly raw: unknown;
}

export interface AgentTeamView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly scope: string;
  /** The team's **own** project (`scope: 'project'`) — not the projects it is assigned to. */
  readonly projectId: string | null;
  readonly members: readonly TeamMemberView[];
  /** The document carried a `members` key. Absent is not the same as empty. */
  readonly membersServed: boolean;
  /** The Projects this team works on (PRD §5.7's "assigned per project"). */
  readonly projectIds: readonly string[];
  readonly projectIdsServed: boolean;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly unrecognised: readonly string[];
  readonly raw: unknown;
}

const KNOWN_FIELDS = new Set([
  'id',
  'name',
  'description',
  'scope',
  'projectId',
  'members',
  'projectIds',
  'createdAt',
  'updatedAt',
]);

const KNOWN_MEMBER_FIELDS = new Set([
  'agentId',
  'name',
  'scope',
  'projectId',
  'runtime',
  'archivedAt',
  'addedAt',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringAt(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** `null` when the element carries no `agentId` — a seat with no occupant cannot be rendered. */
export function readTeamMember(raw: unknown): TeamMemberView | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const agentId = stringAt(record, 'agentId');
  if (agentId === null) return null;

  return {
    agentId,
    // Falls back to the id rather than to a blank: a roster row with no label is unusable, and the
    // id is a worse name than a name but a much better one than nothing.
    name: stringAt(record, 'name') ?? agentId,
    scope: stringAt(record, 'scope') ?? '',
    projectId: stringAt(record, 'projectId'),
    runtime: stringAt(record, 'runtime') ?? '',
    archivedAt: stringAt(record, 'archivedAt'),
    addedAt: stringAt(record, 'addedAt'),
    unrecognised: Object.keys(record).filter((key) => !KNOWN_MEMBER_FIELDS.has(key)),
    raw,
  };
}

export function readAgentTeam(raw: unknown): AgentTeamView | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const id = stringAt(record, 'id');
  const name = typeof record['name'] === 'string' ? (record['name'] as string) : null;
  if (id === null || name === null) return null;

  const rawMembers = record['members'];
  const rawProjectIds = record['projectIds'];

  return {
    id,
    name,
    description: typeof record['description'] === 'string' ? (record['description'] as string) : '',
    // Never defaulted to `global`: a silent default would widen where a team is offered, and `''`
    // renders as "not stated".
    scope: stringAt(record, 'scope') ?? '',
    projectId: stringAt(record, 'projectId'),
    members: Array.isArray(rawMembers)
      ? rawMembers.map(readTeamMember).filter((member): member is TeamMemberView => member !== null)
      : [],
    membersServed: Array.isArray(rawMembers),
    projectIds: Array.isArray(rawProjectIds)
      ? rawProjectIds.filter((value): value is string => typeof value === 'string')
      : [],
    projectIdsServed: Array.isArray(rawProjectIds),
    createdAt: stringAt(record, 'createdAt'),
    updatedAt: stringAt(record, 'updatedAt'),
    unrecognised: Object.keys(record).filter((key) => !KNOWN_FIELDS.has(key)),
    raw,
  };
}

export interface AgentTeamListRead {
  readonly teams: readonly AgentTeamView[];
  readonly unreadable: number;
}

export function readAgentTeamList(rows: readonly unknown[]): AgentTeamListRead {
  const teams: AgentTeamView[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const team = readAgentTeam(row);
    if (team === null) unreadable += 1;
    else teams.push(team);
  }
  return { teams, unreadable };
}

// -------------------------------------------------------------------------------- eligibility

export type MemberRefusal = 'session_scoped' | 'other_project' | 'archived';

export interface MemberExclusion {
  readonly agent: AgentView;
  readonly reason: MemberRefusal;
  readonly explanation: string;
}

export interface TeamScopeTarget {
  readonly scope: string;
  readonly projectId: string | null;
}

/**
 * Why this agent may not sit on this team, or `null` if it may.
 *
 * The Backend's `#resolveMembers` refuses exactly three things, and the codes differ for a reason
 * this UI has to preserve: the first two are `VALIDATION_FAILED` and **permanent** (an agent's
 * scope is immutable), while the third is a `CONFLICT` about a *state* the operator can undo. So
 * the roster picker hides the permanent ones and explains them once, and treats archival as a
 * blocking condition with an action attached.
 */
export function memberRefusal(agent: AgentView, team: TeamScopeTarget): MemberExclusion | null {
  const refuse = (reason: MemberRefusal, explanation: string): MemberExclusion => ({
    agent,
    reason,
    explanation,
  });

  if (agent.scope === 'session') {
    return refuse(
      'session_scoped',
      'Session-scoped. A session agent belongs to one conversation and dies with it, so it cannot hold a standing seat on a roster.',
    );
  }
  if (agent.scope === 'project' && agent.projectId !== team.projectId) {
    return refuse(
      'other_project',
      team.scope === 'global'
        ? 'Scoped to a project. A global team may hold only global agents — it has to be safe to assign anywhere, and this agent is only meaningful inside its own project.'
        : 'Scoped to a different project than this team.',
    );
  }
  if (agent.archivedAt !== null) {
    return refuse(
      'archived',
      'Archived. It cannot be added to a team — un-archive it on the Agents screen first. An archived agent already on a roster keeps its seat.',
    );
  }
  return null;
}

export interface RosterChoices {
  readonly eligible: readonly AgentView[];
  readonly excluded: readonly MemberExclusion[];
}

export function partitionAgentsForTeam(
  agents: readonly AgentView[],
  team: TeamScopeTarget,
): RosterChoices {
  const eligible: AgentView[] = [];
  const excluded: MemberExclusion[] = [];
  for (const agent of agents) {
    const refusal = memberRefusal(agent, team);
    if (refusal === null) eligible.push(agent);
    else excluded.push(refusal);
  }
  return { eligible, excluded };
}

// ------------------------------------------------------------------------------------ drafting

export interface TeamDraft {
  readonly name: string;
  readonly description: string;
  /** Create only — scope is immutable once the team exists. */
  readonly scope: string;
  readonly projectId: string;
  readonly agentIds: readonly string[];
  readonly projectIds: readonly string[];
}

export function newTeamDraft(initialProjectId: string | null = null): TeamDraft {
  return {
    name: '',
    description: '',
    // `global` because it is the only scope true of every install and it needs no target.
    scope: initialProjectId === null ? 'global' : 'project',
    projectId: initialProjectId ?? '',
    agentIds: [],
    projectIds: [],
  };
}

export function teamDraftOf(team: AgentTeamView | null): TeamDraft {
  if (team === null) return newTeamDraft();
  return {
    name: team.name,
    description: team.description,
    scope: team.scope,
    projectId: team.projectId ?? '',
    agentIds: team.members.map((member) => member.agentId),
    projectIds: [...team.projectIds],
  };
}

/** Switching to `global` clears the project rather than leaving it to fail validation. */
export function applyTeamScopeChange(draft: TeamDraft, scope: string): TeamDraft {
  if (scope === 'project') return { ...draft, scope };
  return { ...draft, scope, projectId: '' };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export interface TeamDirty {
  readonly changedFields: readonly string[];
  readonly count: number;
  readonly isDirty: boolean;
}

export function teamDirty(baseline: TeamDraft, draft: TeamDraft): TeamDirty {
  const changedFields = [
    draft.name !== baseline.name ? 'name' : null,
    draft.description !== baseline.description ? 'description' : null,
    sameIds(draft.agentIds, baseline.agentIds) ? null : 'agentIds',
    sameIds(draft.projectIds, baseline.projectIds) ? null : 'projectIds',
  ].filter((entry): entry is string => entry !== null);

  return { changedFields, count: changedFields.length, isDirty: changedFields.length > 0 };
}

// ---------------------------------------------------------------------------------- validating

export type TeamIssueSeverity = 'blocking' | 'advisory';
export type TeamIssueField = 'name' | 'description' | 'scope' | 'projectId' | 'agentIds';

export interface TeamFormIssue {
  readonly field: TeamIssueField;
  readonly severity: TeamIssueSeverity;
  readonly message: string;
  readonly why: string;
}

export interface TeamValidationContext {
  readonly mode: 'create' | 'edit';
  /** The agents named by `agentIds` that this client knows are archived. */
  readonly archivedMembers: readonly AgentView[];
  /** False when `GET /projects` failed — a project cannot be chosen from a list that is not there. */
  readonly projectsAvailable: boolean;
}

export function teamIssues(
  draft: TeamDraft,
  context: TeamValidationContext,
): readonly TeamFormIssue[] {
  const issues: TeamFormIssue[] = [];
  const name = draft.name.trim();

  if (name.length === 0) {
    issues.push({
      field: 'name',
      severity: 'blocking',
      message: 'A team needs a name.',
      why: 'It is the only thing a person reads when assigning a team to a project, and the Backend enforces uniqueness on it within a scope.',
    });
  } else if (name.length > MAX_AGENT_TEAM_NAME_LENGTH) {
    issues.push({
      field: 'name',
      severity: 'blocking',
      message: `The name is ${name.length} characters; the limit is ${MAX_AGENT_TEAM_NAME_LENGTH}.`,
      why: 'The Backend rejects a longer one at the route schema, so saving would fail rather than truncate.',
    });
  }

  if (draft.description.trim().length > MAX_AGENT_TEAM_DESCRIPTION_LENGTH) {
    issues.push({
      field: 'description',
      severity: 'blocking',
      message: `The description is ${draft.description.trim().length} characters; the limit is ${MAX_AGENT_TEAM_DESCRIPTION_LENGTH}.`,
      why: 'The route schema rejects a longer one.',
    });
  }

  if (context.mode === 'create') {
    if (draft.scope.length === 0) {
      issues.push({
        field: 'scope',
        severity: 'blocking',
        message: 'Choose a scope.',
        why: 'Scope decides where this team can be assigned and which agents it may hold, and it cannot be changed afterwards.',
      });
    }
    if (draft.scope === 'project' && draft.projectId.length === 0) {
      issues.push({
        field: 'projectId',
        severity: 'blocking',
        message: 'A project team needs a project.',
        why: context.projectsAvailable
          ? 'A project-scoped team belongs to exactly one project, may hold that project’s own agents, and can be assigned only there. `ck_agent_teams_scope_target` makes the combination unstorable. If this team should be usable everywhere, its scope is Global.'
          : 'The projects list could not be read, so there is nothing to choose from. Retry it before saving — or scope this team Global, which needs no project at all.',
      });
    }
  }

  if (draft.agentIds.length > MAX_AGENT_TEAM_MEMBERS) {
    issues.push({
      field: 'agentIds',
      severity: 'blocking',
      message: `${draft.agentIds.length} members; the request limit is ${MAX_AGENT_TEAM_MEMBERS}.`,
      why: 'A team write emits one event per assigned project, so the route bounds how much work one request can ask for.',
    });
  }

  /**
   * The sharp edge of this screen, and the one an operator cannot otherwise discover.
   *
   * `PATCH { agentIds }` **replaces the whole roster**, and the Backend refuses any `agentIds`
   * containing an archived agent with a `CONFLICT`. So a team that has had a member archived
   * cannot have *any* roster change saved while that member is still listed — the save fails on a
   * seat the operator did not touch. There are exactly two ways out and both are named.
   */
  if (context.archivedMembers.length > 0) {
    const names = context.archivedMembers.map((agent) => agent.name).join(', ');
    issues.push({
      field: 'agentIds',
      severity: 'blocking',
      message: `${names} ${context.archivedMembers.length === 1 ? 'is' : 'are'} archived and still on this roster.`,
      why: 'Saving sends the whole roster, and the Backend refuses a roster containing an archived agent — so this save would fail on a seat you did not touch. Either remove the member here, or un-archive the agent on the Agents screen and keep the seat.',
    });
  }

  return issues;
}

export function blockingTeamIssues(issues: readonly TeamFormIssue[]): readonly TeamFormIssue[] {
  return issues.filter((issue) => issue.severity === 'blocking');
}

export function teamIssueFor(
  issues: readonly TeamFormIssue[],
  field: TeamIssueField,
): TeamFormIssue | undefined {
  return issues.find((issue) => issue.field === field);
}

// ------------------------------------------------------------------------------------- writing

/**
 * `POST /agent-teams` — the whole document, because there is nothing on the server to merge with.
 *
 * `agentIds` and `projectIds` are sent even when empty: the create schema treats an omitted array
 * as "none" anyway, and sending `[]` makes the request say exactly what the form shows.
 */
export function toCreateTeamBody(draft: TeamDraft): Record<string, unknown> {
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    description: description.length === 0 ? null : description,
    scope: draft.scope,
    projectId: draft.scope === 'project' && draft.projectId.length > 0 ? draft.projectId : null,
    agentIds: [...draft.agentIds],
    projectIds: [...draft.projectIds],
  };
}

/**
 * `PATCH /agent-teams/{id}` — **only what changed**.
 *
 * `scope` and `projectId` are never sent: they are absent from the update schema, which is
 * `additionalProperties: false`, so including them is a `400` naming the field rather than a no-op.
 *
 * Each array goes **whole** when any of it moved, because that is what the route means by it — an
 * omitted array leaves the set alone and `[]` empties it. There is no partial form, so a roster
 * edit always re-states every seat, which is why an archived member is a blocking issue above
 * rather than something the save can quietly route around.
 */
export function toPatchTeamBody(baseline: TeamDraft, draft: TeamDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (draft.name !== baseline.name) body['name'] = draft.name.trim();
  if (draft.description !== baseline.description) {
    const description = draft.description.trim();
    body['description'] = description.length === 0 ? null : description;
  }
  if (!sameIds(draft.agentIds, baseline.agentIds)) body['agentIds'] = [...draft.agentIds];
  if (!sameIds(draft.projectIds, baseline.projectIds)) body['projectIds'] = [...draft.projectIds];

  return body;
}
