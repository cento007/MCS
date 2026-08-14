import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { ConfirmDialog } from '../../../components/Modal.js';
import { Skeleton } from '../../../components/Skeleton.js';
import {
  DirtyFormProvider,
  UnsavedChangesGuard,
  useDirtyForms,
} from '../../../components/UnsavedChangesGuard.js';
import type { AgentView } from '../../../lib/agents/index.js';
import { endpoints } from '../../../lib/api/index.js';
import { formatDateTime } from '../../../lib/format/index.js';
import { changeCountLabel } from '../../../lib/forms/dirty.js';
import { useChannel } from '../../../lib/ws/context.js';
import { BuilderSection } from '../fields.js';
import { projectName, useAgentProjects, useAgentsList } from '../queries.js';
import { TeamField, TeamTextArea, TeamTextControl } from './fields.js';
import { useDeleteAgentTeam, useUpdateAgentTeam } from './mutations.js';
import { useAgentTeam } from './queries.js';
import { AssignmentField, RosterField } from './RosterFields.js';
import {
  type AgentTeamView,
  blockingTeamIssues,
  MAX_AGENT_TEAM_NAME_LENGTH,
  partitionAgentsForTeam,
  type TeamDraft,
  teamDirty,
  teamDraftOf,
  teamIssueFor,
  teamIssues,
  teamScopeDescription,
  teamScopeLabel,
  toPatchTeamBody,
} from './shape.js';

/**
 * `/agents/teams/:teamId` — one agent team (PRD §5.7).
 *
 * ## What is editable, and what is a fact
 *
 * Editable: **name**, **description**, the **roster** (`agentIds`) and the **project assignment**
 * (`projectIds`). Both arrays are whole-set replacements on the wire, which is why the Save bar
 * counts them as one change each and why an ineligible seat blocks the whole save rather than
 * being quietly dropped.
 *
 * A fact: **scope**. `PATCH /agent-teams/{id}` has no `scope` or `projectId` and its schema is
 * `additionalProperties: false`, so a select here would be a control whose every use is a `400`. It
 * renders as a stated fact with the reason attached, exactly as the Agent Builder does.
 *
 * ## No role field and no reorder handle, and now for a settled reason
 *
 * The brief listed both as open questions. They are closed: `agent_team_members` has neither
 * column, and the Backend argues why — PRD §5.7's "roles" *are* agent names (one Agent's
 * `instructions` define exactly one persona), and ordering belongs to a workflow rather than a set.
 * Members come back sorted by agent name, which is the order shown.
 *
 * ## Deleted, not archived
 *
 * There is a `[Delete team]` here and there is deliberately none on the Agent Builder. The
 * asymmetry is the Backend's and it is sound: an Agent is referenced as *history*, a team is
 * referenced only by its own rows. A delete while the team is still assigned is a `409`, so the
 * confirm says so before the operator finds out from a toast.
 */
export function AgentTeamPage() {
  const { teamId } = useParams();

  return (
    <DirtyFormProvider>
      <TeamDetail key={teamId ?? 'none'} teamId={teamId ?? null} />
      <UnsavedChangesGuard />
    </DirtyFormProvider>
  );
}

const PANEL_ID = 'agent-team';

function TeamDetail({ teamId }: { teamId: string | null }) {
  const navigate = useNavigate();
  const headingRef = useRef<HTMLHeadingElement>(null);
  useChannel('agents');

  const detail = useAgentTeam(teamId);
  const update = useUpdateAgentTeam();
  const remove = useDeleteAgentTeam();
  const registry = useDirtyForms();
  const projects = useAgentProjects();
  // Archived agents included: a roster can hold one, and this page has to be able to name it.
  const agents = useAgentsList(true);

  const team = detail.team;
  const baseline = useMemo<TeamDraft>(() => teamDraftOf(team), [team]);

  const [edited, setEdited] = useState<TeamDraft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const draft = edited ?? baseline;

  // A refetch landing mid-edit must not overwrite typing; one landing on a clean form adopts the
  // new server truth. The same rule, and the same mechanism, as the Agent Builder.
  const baselineRef = useRef(baseline);
  const editedRef = useRef(edited);
  editedRef.current = edited;
  useEffect(() => {
    const previous = baselineRef.current;
    baselineRef.current = baseline;
    if (previous === baseline) return;
    const held = editedRef.current;
    if (held === null || !teamDirty(previous, held).isDirty) setEdited(null);
  }, [baseline]);

  const summary = useMemo(() => {
    const dirty = teamDirty(baseline, draft);
    return { ...dirty, changedSecrets: [] as readonly string[], secretCount: 0 };
  }, [baseline, draft]);

  // Two primitives rather than an object literal, so the memo depends on values that are stable
  // across renders — an inline `{ scope, projectId }` would re-partition the whole agent list on
  // every keystroke in the name field.
  const scope = draft.scope;
  const scopeProjectId = draft.projectId.length === 0 ? null : draft.projectId;
  const choices = useMemo(
    () => partitionAgentsForTeam(agents.read.agents, { scope, projectId: scopeProjectId }),
    [agents.read.agents, scope, scopeProjectId],
  );

  /**
   * Roster members this client knows to be archived.
   *
   * Read from the **draft**, not from the served team, because removing the seat is what clears the
   * blocking issue — and the served document still lists it until the save lands.
   */
  const archivedMembers = useMemo<readonly AgentView[]>(() => {
    const byId = new Map(agents.read.agents.map((agent) => [agent.id, agent]));
    return draft.agentIds
      .map((agentId) => byId.get(agentId))
      .filter((agent): agent is AgentView => agent !== undefined && agent.archivedAt !== null);
  }, [agents.read.agents, draft.agentIds]);

  const issues = teamIssues(draft, {
    mode: 'edit',
    archivedMembers,
    projectsAvailable: !projects.isError,
  });
  const blockingAll = blockingTeamIssues(issues);
  const shown = attempted || summary.isDirty ? issues : [];
  const blockingShown = blockingTeamIssues(shown);

  const readOnly =
    detail.unavailable || detail.isError || detail.unreadable || team === null || update.isPending;

  const setDraft = useCallback((update_: (previous: TeamDraft) => TeamDraft) => {
    setEdited((previous) => update_(previous ?? baselineRef.current));
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    setAttempted(true);
    if (team === null || blockingAll.length > 0) return false;
    const body = toPatchTeamBody(baseline, draft);
    // An empty PATCH is not a request: nothing changed. It happens when the guard's `[Save]` fires
    // on a form whose only change was typing a value and typing it back.
    if (Object.keys(body).length === 0) {
      setEdited(null);
      return true;
    }
    try {
      await update.mutateAsync({ teamId: team.id, body });
      setEdited(null);
      return true;
    } catch {
      // The toast named the failure with its `requestId`; the form stays dirty so nothing is lost.
      return false;
    }
  }, [team, blockingAll.length, baseline, draft, update]);

  const discard = useCallback(() => setEdited(null), []);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const saveRef = useRef(save);
  saveRef.current = save;
  const discardRef = useRef(discard);
  discardRef.current = discard;
  const { publish, withdraw } = registry;
  const { isDirty, count } = summary;
  const label = `Team → ${baseline.name || 'untitled'}`;

  useEffect(() => {
    if (!isDirty) {
      withdraw(PANEL_ID);
      return;
    }
    publish(
      { panelId: PANEL_ID, label, count, secretCount: 0 },
      { save: () => saveRef.current(), discard: () => discardRef.current() },
    );
    return () => withdraw(PANEL_ID);
  }, [isDirty, count, label, publish, withdraw]);

  return (
    <section className="flex flex-col gap-4 px-4 py-4 md:px-6">
      <div>
        <Link
          to="/agents/teams"
          className="rounded-xs text-2xs text-text-muted underline decoration-dotted underline-offset-2"
          style={{ minHeight: 24 }}
        >
          ← Teams
        </Link>
      </div>

      <div className="flex flex-wrap items-baseline gap-3">
        <h1 ref={headingRef} tabIndex={-1} className="font-medium text-text text-xl outline-none">
          {team?.name ?? 'Team'}
        </h1>
        {team === null ? null : (
          <span className="flex flex-wrap items-center gap-3 text-2xs text-text-muted">
            <code className="font-mono">{team.id}</code>
            {team.updatedAt === null ? null : <span>updated {formatDateTime(team.updatedAt)}</span>}
          </span>
        )}
      </div>

      {detail.unavailable ? <RouteMissing /> : null}
      {detail.isError ? (
        <ErrorPanel
          error={detail.error}
          title="This team could not be read"
          onRetry={detail.refetch}
        />
      ) : null}
      {detail.unreadable ? <Unreadable /> : null}

      {detail.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading team</span>
          <Skeleton height={120} />
          <Skeleton height={160} />
        </div>
      ) : (
        <>
          <BuilderSection title="Identity">
            <TeamField
              label="Name"
              required
              changed={summary.changedFields.includes('name')}
              issue={teamIssueFor(shown, 'name')}
            >
              {({ id, describedBy }) => (
                <TeamTextControl
                  id={id}
                  describedBy={describedBy}
                  value={draft.name}
                  disabled={readOnly}
                  maxLength={MAX_AGENT_TEAM_NAME_LENGTH}
                  onChange={(value) => setDraft((previous) => ({ ...previous, name: value }))}
                />
              )}
            </TeamField>

            <TeamField
              label="Description"
              changed={summary.changedFields.includes('description')}
              issue={teamIssueFor(shown, 'description')}
            >
              {({ id }) => (
                <TeamTextArea
                  id={id}
                  value={draft.description}
                  disabled={readOnly}
                  onChange={(value) =>
                    setDraft((previous) => ({ ...previous, description: value }))
                  }
                />
              )}
            </TeamField>
          </BuilderSection>

          <BuilderSection title="Scope">
            <ScopeFact
              team={team}
              projectLabel={projectName(projects.data ?? [], team?.projectId ?? null)}
            />
          </BuilderSection>

          <BuilderSection
            title="Members"
            description="The agents on this team, sorted by name — the order the API returns them in. A team is a set; there is no ordering to configure, because order belongs to a workflow and workflows are not built."
          >
            {!(team?.membersServed ?? true) ? (
              <p
                role="note"
                data-testid="members-not-served"
                className="text-sm text-text-secondary leading-150"
              >
                <span aria-hidden="true">ⓘ</span> This Backend served no{' '}
                <code className="font-mono text-xs">members</code> for this team, so the roster
                cannot be shown — a different fact from an empty team, and this screen will not
                print the second when it only knows the first.
              </p>
            ) : (
              <>
                <RosterField
                  choices={choices}
                  selected={draft.agentIds}
                  disabled={readOnly}
                  archivedMembers={archivedMembers}
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
                {teamIssueFor(shown, 'agentIds') === undefined ? null : (
                  <p
                    role="alert"
                    data-testid="team-issue-agentIds"
                    className="text-2xs leading-150"
                    style={{ color: 'var(--color-danger)' }}
                  >
                    <span aria-hidden="true">✕</span>{' '}
                    <strong>{teamIssueFor(shown, 'agentIds')?.message}</strong>{' '}
                    <span className="text-text-muted">{teamIssueFor(shown, 'agentIds')?.why}</span>
                  </p>
                )}
              </>
            )}
          </BuilderSection>

          <BuilderSection
            title="Assigned projects"
            description="PRD §5.7’s “teams can be assigned per project”. A project’s team is what the Launch dialog leads with when choosing an agent — an unassigned team changes nothing anywhere."
          >
            {!(team?.projectIdsServed ?? true) ? (
              <p
                role="note"
                data-testid="assignments-not-served"
                className="text-sm text-text-secondary leading-150"
              >
                <span aria-hidden="true">ⓘ</span> This Backend served no{' '}
                <code className="font-mono text-xs">projectIds</code> for this team.
              </p>
            ) : (
              <AssignmentField
                projects={projects.data ?? []}
                selected={draft.projectIds}
                disabled={readOnly}
                restrictedTo={draft.scope === 'project' ? (team?.projectId ?? null) : null}
                projectsUnavailable={projects.isError}
                onToggle={(projectId, on) =>
                  setDraft((previous) => ({
                    ...previous,
                    projectIds: on
                      ? [...previous.projectIds, projectId]
                      : previous.projectIds.filter((id) => id !== projectId),
                  }))
                }
              />
            )}
          </BuilderSection>

          {team !== null && team.unrecognised.length > 0 ? (
            <p
              role="note"
              data-testid="team-unrecognised"
              className="text-2xs text-text-muted leading-150"
            >
              <span aria-hidden="true">ⓘ</span> Served on this team and not shown here:{' '}
              <code className="font-mono">{team.unrecognised.join(', ')}</code>. A save sends only
              the fields that changed, so {team.unrecognised.length === 1 ? 'it is' : 'they are'}{' '}
              left alone.
            </p>
          ) : null}

          {summary.isDirty ? (
            <div
              data-testid="team-save-bar"
              className="sticky bottom-0 flex flex-col gap-2 rounded-md border border-border px-4 py-3"
              style={{ backgroundColor: 'var(--color-surface-raised)' }}
            >
              {blockingShown.length > 0 ? (
                <ul data-testid="team-blocking" className="flex flex-col gap-1">
                  {blockingShown.map((issue) => (
                    <li
                      key={issue.field}
                      className="text-2xs leading-150"
                      style={{ color: 'var(--color-danger)' }}
                    >
                      <span aria-hidden="true">✕</span> <strong>{issue.message}</strong>{' '}
                      <span className="text-text-muted">{issue.why}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex flex-wrap items-center justify-end gap-3">
                <p aria-live="polite" className="mr-auto font-medium text-sm text-text">
                  {changeCountLabel(summary)}
                </p>
                <button
                  type="button"
                  onClick={discard}
                  disabled={update.isPending}
                  className="rounded-sm border border-border-control px-3 text-sm text-text disabled:opacity-50"
                  style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={readOnly || blockingAll.length > 0}
                  className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
                  style={{
                    height: 'var(--mc-control-md)',
                    minHeight: 24,
                    backgroundColor: 'var(--color-accent)',
                    color: 'var(--color-on-accent)',
                  }}
                >
                  {update.isPending ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </div>
          ) : null}

          {team === null ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                data-testid="team-delete"
                onClick={() => setConfirmingDelete(true)}
                disabled={remove.isPending}
                className="rounded-sm border px-3 text-sm disabled:opacity-50"
                style={{
                  height: 'var(--mc-control-md)',
                  minHeight: 24,
                  borderColor: 'var(--color-danger)',
                  color: 'var(--color-danger)',
                }}
              >
                Delete team
              </button>
              <span className="text-2xs text-text-muted leading-150">
                Teams are deleted rather than archived — unlike agents, nothing outside a team’s own
                rows refers to it, so no history is rewritten. A team still assigned to a project
                cannot be deleted.
              </span>
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete this team?"
        body={
          draft.projectIds.length > 0
            ? `This team is assigned to ${draft.projectIds.length} ${draft.projectIds.length === 1 ? 'project' : 'projects'}. The API refuses to delete an assigned team — unassign it above and save first.`
            : 'The team and its roster are removed. The agents themselves are untouched, and no session that ran as one of them is affected.'
        }
        confirmLabel="Delete team"
        destructive
        pending={remove.isPending}
        onConfirm={() => {
          setConfirmingDelete(false);
          if (team === null) return;
          void remove.mutateAsync({ teamId: team.id }).then(
            () => void navigate('/agents/teams'),
            () => {
              // The toast named the refusal — a `409` while assigned is a decision to make, not a
              // retry — and the operator stays on the page that can act on it.
            },
          );
        }}
        onCancel={() => setConfirmingDelete(false)}
      />
    </section>
  );
}

/**
 * Scope, as a fact rather than a disabled control.
 *
 * A greyed-out select invites the operator to look for the thing that would ungrey it. There is
 * nothing: `PATCH /agent-teams/{id}` does not accept `scope` or `projectId` at all, and its schema
 * is `additionalProperties: false`, so sending one is a `400` naming the field.
 */
function ScopeFact({
  team,
  projectLabel,
}: {
  team: AgentTeamView | null;
  projectLabel: string | null;
}) {
  const scope = team?.scope ?? '';

  return (
    <div data-testid="team-scope-fact">
      <p className="text-sm text-text">
        {scope.length === 0 ? (
          <span className="text-text-muted">This Backend served no scope for this team.</span>
        ) : (
          <>
            <strong>{teamScopeLabel(scope)}</strong>
            {projectLabel === null ? null : (
              <span className="text-text-secondary"> · {projectLabel}</span>
            )}
          </>
        )}
      </p>
      <p className="mt-1 max-w-2xl text-2xs text-text-muted leading-150">
        {teamScopeDescription(scope)} <strong>Scope is fixed once a team exists.</strong> Changing
        it could strand members the team is no longer allowed to hold, so the API does not accept a
        change to it. Create a new team in the scope you want and delete this one.
      </p>
    </div>
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
        <code className="font-mono text-xs">/api/v1{endpoints.agentTeams.list}/…</code> yet.
      </p>
      <p className="mt-1 max-w-3xl text-2xs text-text-muted leading-150">
        The fields below are built to TDS 04 §13.2 and are disabled until the route exists. Nothing
        is shown from a local default: a value here that had never been saved would be
        indistinguishable from a stored one.
      </p>
    </div>
  );
}

function Unreadable() {
  return (
    <div
      role="alert"
      data-testid="team-unreadable"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-danger-subtle)',
        borderColor: 'var(--color-danger)',
      }}
    >
      <p className="text-sm text-text leading-150">
        The Backend answered, and the document was not a team this screen can read.
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        It carried no <code className="font-mono">id</code> or no{' '}
        <code className="font-mono">name</code>. Editing is disabled rather than started from a
        guess — a form seeded with blanks would save those blanks over whatever is actually stored.
      </p>
    </div>
  );
}
