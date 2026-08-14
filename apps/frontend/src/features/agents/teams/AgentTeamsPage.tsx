import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState } from '../../../components/EmptyState.js';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { Modal } from '../../../components/Modal.js';
import { Skeleton } from '../../../components/Skeleton.js';
import { endpoints } from '../../../lib/api/index.js';
import { formatDateTime } from '../../../lib/format/index.js';
import { formatRelativePast } from '../../../lib/format/relative.js';
import { useLiveClock } from '../../../lib/liveness.js';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../../lib/media.js';
import { useChannel } from '../../../lib/ws/context.js';
import { AgentsTabs } from '../AgentsTabs.js';
import { SelectControl } from '../fields.js';
import { projectName, useAgentProjects, useAgentsList } from '../queries.js';
import { TeamField, TeamTextArea, TeamTextControl } from './fields.js';
import { teamIdOf, useCreateAgentTeam } from './mutations.js';
import { useAgentTeams } from './queries.js';
import { RosterField } from './RosterFields.js';
import {
  AGENT_TEAM_SCOPES,
  type AgentTeamView,
  applyTeamScopeChange,
  blockingTeamIssues,
  MAX_AGENT_TEAM_NAME_LENGTH,
  newTeamDraft,
  partitionAgentsForTeam,
  type TeamDraft,
  teamIssueFor,
  teamIssues,
  teamScopeDescription,
  teamScopeLabel,
  toCreateTeamBody,
} from './shape.js';

/**
 * `/agents/teams` — agent teams (PRD §5.7, PRD §8.5's fourth word, TDS 06 §6.2's reserved tab).
 *
 * PRD §5.7 is two sentences: *"Example team: Product Owner, Architect, Developer, QA, Security.
 * Teams can be assigned per project."* Both halves are real now — a team is a roster and a set of
 * projects — and the consumer that makes it mean something is
 * `GET /projects/{id}/available-agents`, which the launch picker reads.
 *
 * Four states, and on a fresh install the second is what everybody sees:
 *
 *  - **no route** — this Backend has no `/agent-teams`. Named, because the fix is a Backend slice
 *    rather than a button on this page, and because "no teams" would invite pressing New team.
 *  - **no teams** — the route works and this instance has none.
 *  - **error** — the envelope, with its `requestId`.
 *  - **rows** — with a count of anything that could not be read.
 *
 * There is **no archived filter**, unlike the Agents list, and that is a contract difference rather
 * than an omission: teams are deleted, not archived.
 */
export function AgentTeamsPage() {
  const navigate = useNavigate();
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);
  const clock = useLiveClock();
  const [creating, setCreating] = useState(false);

  // `agent_team.created` / `.updated` / `.deleted` and `agent.assigned` all ride the `agents`
  // channel (TDS 04 §14.3) — the Backend declined a `teams` channel because a client that cares
  // about one cares about the other.
  useChannel('agents');

  const query = useAgentTeams();
  const projects = useAgentProjects();
  const { teams, unreadable } = query.read;

  return (
    <section className="px-4 py-4 md:px-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-medium text-text text-xl">Agents</h1>
        {query.unavailable ? null : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="ml-auto flex items-center rounded-sm px-3 font-medium text-sm"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            + New team
          </button>
        )}
      </div>

      <AgentsTabs active="teams" />

      <p className="mt-3 max-w-3xl text-sm text-text-secondary leading-150">
        A team is a named set of agents assigned to the projects it works on (PRD §5.7 — Product
        Owner, Architect, Developer, QA, Security). A project has at most one team, and its team is
        what the Launch dialog leads with when choosing an agent.
      </p>

      <div className="mt-4">
        {query.unavailable ? (
          <RouteMissing />
        ) : query.isPending ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <span className="sr-only">Loading teams</span>
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : query.isError ? (
          <ErrorPanel
            error={query.error}
            title="The teams list could not be read"
            onRetry={query.refetch}
          />
        ) : teams.length === 0 ? (
          <EmptyState
            title="No teams yet."
            // Two sentences, matching the Agents list's empty state. `EmptyState` puts no bound on
            // its hint, so a long one runs the full width of the viewport as one grey ribbon —
            // observed in the browser on 2026-08-14.
            hint="A team collects agents that already exist — PRD §5.7’s example is Product Owner, Architect, Developer, QA and Security — so a launch in that project leads with those five. Create the agents first; a team groups them, it does not replace them."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="rounded-sm border border-border-control px-3 text-sm text-text"
                  style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
                >
                  New team
                </button>
                <Link
                  to="/agents"
                  className="flex items-center rounded-sm px-3 text-sm text-text-secondary underline decoration-dotted underline-offset-2"
                  style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
                >
                  See the agents
                </Link>
              </div>
            }
          />
        ) : mobile ? (
          <ul className="flex flex-col gap-2">
            {teams.map((team) => (
              <li key={team.id}>
                <MobileCard
                  team={team}
                  project={projectName(projects.data ?? [], team.projectId)}
                  onOpen={() => void navigate(`/agents/teams/${team.id}`)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-2xs text-text-secondary uppercase">
                <th scope="col" className="py-2 pr-3 font-medium">
                  Name
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Scope
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Members
                </th>
                <th scope="col" className="py-2 pr-3 font-medium">
                  Assigned to
                </th>
                <th scope="col" className="py-2 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr
                  key={team.id}
                  className="border-border border-t align-top"
                  style={{ height: 'var(--mc-row-dense)' }}
                >
                  <td className="py-2 pr-3">
                    <Link
                      to={`/agents/teams/${team.id}`}
                      className="block"
                      style={{ minHeight: 24 }}
                    >
                      <span className="truncate text-sm text-text">{team.name}</span>
                      {team.description.length === 0 ? null : (
                        <span className="block max-w-md truncate text-2xs text-text-muted">
                          {team.description}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-text-secondary text-xs">
                    <ScopeCell
                      team={team}
                      project={projectName(projects.data ?? [], team.projectId)}
                    />
                  </td>
                  <td className="py-2 pr-3 text-text-secondary text-xs">
                    <MemberCount team={team} />
                  </td>
                  <td className="py-2 pr-3 text-text-secondary text-xs">
                    <AssignmentCell team={team} />
                  </td>
                  <td
                    className="py-2 text-text-secondary text-xs"
                    title={team.updatedAt === null ? undefined : formatDateTime(team.updatedAt)}
                  >
                    {team.updatedAt === null ? '—' : formatRelativePast(team.updatedAt, clock.now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {unreadable > 0 ? (
          <p
            role="note"
            data-testid="teams-unreadable"
            className="mt-3 text-2xs text-text-muted leading-150"
          >
            <span aria-hidden="true">▲</span> {unreadable}{' '}
            {unreadable === 1 ? 'row was' : 'rows were'} served without an id or a name and{' '}
            {unreadable === 1 ? 'is' : 'are'} not shown. The count is here rather than nowhere: a
            list that is quietly short looks exactly like one that is genuinely short.
          </p>
        ) : null}
      </div>

      <CreateTeamModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          if (id !== null) void navigate(`/agents/teams/${id}`);
        }}
      />
    </section>
  );
}

function ScopeCell({ team, project }: { team: AgentTeamView; project: string | null }) {
  if (team.scope.length === 0) {
    return (
      <span className="text-text-muted" title="This Backend served no scope for this team.">
        not stated
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span>{teamScopeLabel(team.scope)}</span>
      {project === null ? null : (
        <span className="truncate text-2xs text-text-muted">{project}</span>
      )}
    </span>
  );
}

/**
 * `5 members · 1 archived`, or an honest silence.
 *
 * The archived count is the column's reason for existing beyond arithmetic: a team of five with one
 * retired member offers four, and a bare `5` would be a number that quietly stopped being true.
 */
function MemberCount({ team }: { team: AgentTeamView }) {
  if (!team.membersServed) {
    return (
      <span className="text-text-muted" title="This list carried no members for this team.">
        not listed here
      </span>
    );
  }
  const archived = team.members.filter((member) => member.archivedAt !== null).length;
  return (
    <span>
      {team.members.length} {team.members.length === 1 ? 'member' : 'members'}
      {archived === 0 ? null : (
        <span style={{ color: 'var(--color-warning)' }}> · {archived} archived</span>
      )}
    </span>
  );
}

function AssignmentCell({ team }: { team: AgentTeamView }) {
  if (!team.projectIdsServed) {
    return (
      <span className="text-text-muted" title="This list carried no projectIds for this team.">
        not listed here
      </span>
    );
  }
  if (team.projectIds.length === 0) {
    return (
      <span
        className="text-text-muted"
        title="Nothing consults this team: available-agents returns team: null for every project."
      >
        no project
      </span>
    );
  }
  return (
    <span>
      {team.projectIds.length} {team.projectIds.length === 1 ? 'project' : 'projects'}
    </span>
  );
}

function MobileCard({
  team,
  project,
  onOpen,
}: {
  team: AgentTeamView;
  project: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-border p-3 text-left"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <span className="truncate text-sm text-text">{team.name}</span>
      <span className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <span>{team.scope.length === 0 ? 'scope not stated' : teamScopeLabel(team.scope)}</span>
        {project === null ? null : <span>{project}</span>}
        <MemberCount team={team} />
      </span>
    </button>
  );
}

function RouteMissing() {
  return (
    <div
      role="note"
      data-testid="teams-route-missing"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span> This Backend does not serve{' '}
        <code className="font-mono text-xs">/api/v1{endpoints.agentTeams.list}</code> yet.
      </p>
      <p className="mt-1 max-w-3xl text-2xs text-text-muted leading-150">
        The screen is built to TDS 04 §13.2 and stays out of the way until the route exists. It is
        not showing you an empty list, because “no teams” and “no teams API” are different facts
        with different fixes, and only one of them is solved by pressing New team.
      </p>
    </div>
  );
}

/**
 * Create a team.
 *
 * Scope is here and nowhere else — it is immutable after create, exactly as an Agent's is, and for
 * the same reason: the scope decides which agents a team may hold, so moving one afterwards could
 * strand members it is no longer allowed to contain.
 *
 * The roster is offered at create because `POST` accepts `agentIds`, and because a team created
 * empty is a team the operator has to visit twice.
 */
function CreateTeamModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (teamId: string | null) => void;
}) {
  const [draft, setDraft] = useState<TeamDraft>(() => newTeamDraft());
  const [attempted, setAttempted] = useState(false);
  const create = useCreateAgentTeam();
  const projects = useAgentProjects();
  const agents = useAgentsList(false);

  // The scope target is two primitives rather than an object literal, so the memo below depends on
  // values that are actually stable across renders: an inline `{ scope, projectId }` would be a new
  // identity every time and would re-partition the whole agent list on every keystroke in the name
  // field.
  const scope = draft.scope;
  const scopeProjectId = draft.projectId.length === 0 ? null : draft.projectId;
  const choices = useMemo(
    () => partitionAgentsForTeam(agents.read.agents, { scope, projectId: scopeProjectId }),
    [agents.read.agents, scope, scopeProjectId],
  );

  const issues = teamIssues(draft, {
    mode: 'create',
    // A create form cannot hold an archived member: the picker only offers eligible agents.
    archivedMembers: [],
    projectsAvailable: !projects.isError,
  });
  const blocking = blockingTeamIssues(issues);
  const shown = attempted ? issues : [];

  const submit = (): void => {
    setAttempted(true);
    if (blocking.length > 0) return;
    create.mutate(
      { body: toCreateTeamBody(draft) },
      {
        onSuccess: (team) => {
          setDraft(newTeamDraft());
          setAttempted(false);
          onCreated(teamIdOf(team));
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New team"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm border border-border-control px-3 text-sm text-text"
            style={{ height: 'var(--mc-control-md)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={create.isPending}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {create.isPending ? 'Creating…' : 'Create team'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TeamField
          label="Name"
          required
          issue={teamIssueFor(shown, 'name')}
          description="Unique among live teams in the same scope."
        >
          {({ id, describedBy }) => (
            <TeamTextControl
              id={id}
              describedBy={describedBy}
              value={draft.name}
              maxLength={MAX_AGENT_TEAM_NAME_LENGTH}
              placeholder="Feature squad"
              onChange={(value) => setDraft((previous) => ({ ...previous, name: value }))}
            />
          )}
        </TeamField>

        <TeamField label="Description" issue={teamIssueFor(shown, 'description')}>
          {({ id }) => (
            <TeamTextArea
              id={id}
              rows={2}
              value={draft.description}
              onChange={(value) => setDraft((previous) => ({ ...previous, description: value }))}
            />
          )}
        </TeamField>

        <TeamField
          label="Scope"
          required
          issue={teamIssueFor(shown, 'scope')}
          description={
            <>
              {teamScopeDescription(draft.scope)}{' '}
              <strong>Scope cannot be changed after the team is created.</strong>
            </>
          }
        >
          {({ id, describedBy }) => (
            <SelectControl
              id={id}
              describedBy={describedBy}
              value={draft.scope}
              options={AGENT_TEAM_SCOPES.map((scope) => ({
                value: scope,
                label: teamScopeLabel(scope),
              }))}
              onChange={(value) => setDraft((previous) => applyTeamScopeChange(previous, value))}
            />
          )}
        </TeamField>

        {draft.scope === 'project' ? (
          <TeamField label="Project" required issue={teamIssueFor(shown, 'projectId')}>
            {({ id, describedBy }) => (
              <SelectControl
                id={id}
                describedBy={describedBy}
                value={draft.projectId}
                disabled={projects.isError}
                options={(projects.data ?? []).map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
                unsetLabel={projects.isError ? '— projects unavailable' : '— choose a project'}
                onChange={(value) => setDraft((previous) => ({ ...previous, projectId: value }))}
              />
            )}
          </TeamField>
        ) : null}

        <TeamField
          label="Members"
          issue={teamIssueFor(shown, 'agentIds')}
          description="Which agents are on this team. It can be changed at any time; scope cannot."
        >
          {() => (
            <RosterField
              choices={choices}
              selected={draft.agentIds}
              disabled={create.isPending}
              archivedMembers={[]}
              agentsUnavailable={agents.unavailable || agents.isError}
              onToggle={(agentId, on) =>
                setDraft((previous) => ({
                  ...previous,
                  agentIds: on
                    ? [...previous.agentIds, agentId]
                    : previous.agentIds.filter((id) => id !== agentId),
                }))
              }
            />
          )}
        </TeamField>

        <p className="text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span> A new team is assigned to no project. Assign it from the
          team’s own page — a project has at most one team, so the refusal for an already-claimed
          one names the team holding it.
        </p>

        {create.isError ? (
          <ErrorPanel error={create.error} title="The team was not created" />
        ) : null}
      </div>
    </Modal>
  );
}
