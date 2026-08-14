import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
import { SelectControl, TextAreaControl, TextControl } from '../fields.js';
import { projectName, useAgentProjects, useAgentsList } from '../queries.js';
import { WorkflowField } from './fields.js';
import { idOf, useCreateWorkflow } from './mutations.js';
import { useWorkflows } from './queries.js';
import { StepFields } from './StepFields.js';
import {
  AGENT_WORKFLOW_SCOPES,
  applyWorkflowScopeChange,
  blockingWorkflowIssues,
  MAX_AGENT_WORKFLOW_NAME_LENGTH,
  moveStep,
  newStepDraft,
  newWorkflowDraft,
  partitionAgentsForWorkflow,
  type StepAgentExclusion,
  stepAgentRefusal,
  toCreateWorkflowBody,
  type WorkflowDraft,
  type WorkflowView,
  workflowIssues,
  workflowIssuesFor,
  workflowScopeDescription,
  workflowScopeLabel,
} from './shape.js';

/**
 * `/agents/workflows` — PRD §5.6's chains (`Developer → QA → Security → Architect`).
 *
 * The third tab of the Agents area, and the first one that *does* something rather than defining
 * something: an agent is a persona, a team is a set, and a workflow is the thing that spends money.
 *
 * Four states, and on a fresh install the second is what everybody sees:
 *
 *  - **no route** — this Backend has no `/agent-workflows`. Named, because the fix is a Backend
 *    deploy rather than a button on this page, and because "no workflows" would invite pressing
 *    New workflow.
 *  - **no workflows** — the route works and this instance has none.
 *  - **error** — the F5.4 envelope, with its `requestId`.
 *  - **rows** — with a count of anything that could not be read.
 *
 * There is **no `[Delete]` anywhere in this feature**: a workflow is *archived*, because
 * `agent_workflow_runs.workflow_id` records which chain a run executed and deleting it would
 * rewrite that history — the same argument that makes agents archivable and teams deletable, coming
 * out on the agent side this time.
 */
export function WorkflowsPage() {
  const navigate = useNavigate();
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);
  const clock = useLiveClock();
  const [creating, setCreating] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const includeArchived = searchParams.get('archived') === '1';

  // `agent_workflow.created` / `.updated` and the four `agent_workflow.run.*` names ride the
  // reserved `agents` channel, as `agent_team.*` does (TDS 04 §14.3).
  useChannel('agents');

  const query = useWorkflows(includeArchived);
  const projects = useAgentProjects();
  const { workflows, unreadable } = query.read;

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
            + New workflow
          </button>
        )}
      </div>

      <AgentsTabs active="workflows" />

      <p className="mt-3 max-w-3xl text-sm text-text-secondary leading-150">
        A workflow is an ordered chain of agents (PRD §5.6 —{' '}
        <em>Developer → QA → Security → Architect</em>). Starting one creates a Session per step and
        runs them one after another, each handed the previous step’s context package. Nothing here
        starts on its own: a run begins because a person pressed a button and confirmed what it was
        about to do.
      </p>

      {query.unavailable ? null : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {/*
           * Archived workflows are excluded by the Backend, not by this list, so this chip changes
           * the request rather than a local filter. It exists because archival is the *only*
           * retirement there is — there is no DELETE route — and an archived workflow with no way
           * back on screen is a workflow nobody can restore.
           */}
          <button
            type="button"
            aria-pressed={includeArchived}
            onClick={() =>
              setSearchParams(
                (params) => {
                  if (includeArchived) params.delete('archived');
                  else params.set('archived', '1');
                  return params;
                },
                { replace: true },
              )
            }
            className="rounded-xs border px-2 text-2xs"
            style={{
              minHeight: 24,
              borderColor: includeArchived ? 'var(--color-accent)' : 'var(--color-border)',
              color: includeArchived ? 'var(--color-accent)' : 'var(--color-text-secondary)',
              backgroundColor: includeArchived ? 'var(--color-selected)' : 'transparent',
            }}
          >
            Show archived
          </button>
        </div>
      )}

      <div className="mt-4">
        {query.unavailable ? (
          <RouteMissing />
        ) : query.isPending ? (
          <div className="space-y-2" role="status" aria-busy="true">
            <span className="sr-only">Loading workflows</span>
            <Skeleton height={36} />
            <Skeleton height={36} />
          </div>
        ) : query.isError ? (
          <ErrorPanel
            error={query.error}
            title="The workflows list could not be read"
            onRetry={query.refetch}
          />
        ) : workflows.length === 0 ? (
          <EmptyState
            title="No workflows yet."
            // Two short sentences, and that is a browser finding rather than a style preference:
            // `EmptyState` puts no bound on its hint, so a long one renders as a single grey ribbon
            // the full width of the viewport. The Teams empty state hit the same wall.
            hint="A workflow chains agents that already exist — each step is one Session, bound to one agent. Create the agents first."
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="rounded-sm border border-border-control px-3 text-sm text-text"
                  style={{ height: 'var(--mc-control-md)', minHeight: 24 }}
                >
                  New workflow
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
            {workflows.map((workflow) => (
              <li key={workflow.id}>
                <MobileCard
                  workflow={workflow}
                  project={projectName(projects.data ?? [], workflow.projectId)}
                  onOpen={() => void navigate(`/agents/workflows/${workflow.id}`)}
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
                  Chain
                </th>
                <th scope="col" className="py-2 font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {workflows.map((workflow) => (
                <tr
                  key={workflow.id}
                  className="border-border border-t align-top"
                  style={{ height: 'var(--mc-row-dense)' }}
                >
                  <td className="py-2 pr-3">
                    <Link
                      to={`/agents/workflows/${workflow.id}`}
                      className="block"
                      style={{ minHeight: 24 }}
                    >
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm text-text">{workflow.name}</span>
                        {workflow.archivedAt === null ? null : <ArchivedChip />}
                      </span>
                      {workflow.description.length === 0 ? null : (
                        <span className="block max-w-md truncate text-2xs text-text-muted">
                          {workflow.description}
                        </span>
                      )}
                    </Link>
                  </td>
                  <td className="py-2 pr-3 text-text-secondary text-xs">
                    <ScopeCell
                      workflow={workflow}
                      project={projectName(projects.data ?? [], workflow.projectId)}
                    />
                  </td>
                  <td className="py-2 pr-3 text-text-secondary text-xs">
                    <ChainCell workflow={workflow} />
                  </td>
                  <td
                    className="py-2 text-text-secondary text-xs"
                    title={
                      workflow.updatedAt === null ? undefined : formatDateTime(workflow.updatedAt)
                    }
                  >
                    {workflow.updatedAt === null
                      ? '—'
                      : formatRelativePast(workflow.updatedAt, clock.now)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {unreadable > 0 ? (
          <p
            role="note"
            data-testid="workflows-unreadable"
            className="mt-3 text-2xs text-text-muted leading-150"
          >
            <span aria-hidden="true">▲</span> {unreadable}{' '}
            {unreadable === 1 ? 'row was' : 'rows were'} served without an id or a name and{' '}
            {unreadable === 1 ? 'is' : 'are'} not shown. The count is here rather than nowhere: a
            list that is quietly short looks exactly like one that is genuinely short.
          </p>
        ) : null}
      </div>

      <CreateWorkflowModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          if (id !== null) void navigate(`/agents/workflows/${id}`);
        }}
      />
    </section>
  );
}

function ScopeCell({ workflow, project }: { workflow: WorkflowView; project: string | null }) {
  if (workflow.scope.length === 0) {
    return (
      <span className="text-text-muted" title="This Backend served no scope for this workflow.">
        not stated
      </span>
    );
  }
  return (
    <span className="flex flex-col">
      <span>{workflowScopeLabel(workflow.scope)}</span>
      {project === null ? null : (
        <span className="truncate text-2xs text-text-muted">{project}</span>
      )}
    </span>
  );
}

/**
 * `Developer → QA → Security` — the chain itself, which is the only thing that distinguishes one
 * workflow from another at a glance. A step count would be a number where the answer is a shape.
 */
function ChainCell({ workflow }: { workflow: WorkflowView }) {
  if (!workflow.stepsServed) {
    return (
      <span className="text-text-muted" title="This list carried no steps for this workflow.">
        not listed here
      </span>
    );
  }
  if (workflow.steps.length === 0) {
    return (
      <span className="text-text-muted" title="A workflow with no steps cannot be run.">
        no steps
      </span>
    );
  }

  const shown = workflow.steps.slice(0, 4);
  const rest = workflow.steps.length - shown.length;
  const archived = workflow.steps.filter((step) => step.agentArchivedAt !== null).length;

  return (
    <span className="flex flex-col">
      <span className="truncate">
        {shown.map((step) => (step.agentName.length > 0 ? step.agentName : 'unnamed')).join(' → ')}
        {rest > 0 ? ` → +${rest}` : ''}
      </span>
      {archived === 0 ? null : (
        <span className="text-2xs" style={{ color: 'var(--color-warning)' }}>
          {archived} archived {archived === 1 ? 'agent' : 'agents'} — a run refuses to start
        </span>
      )}
    </span>
  );
}

function ArchivedChip() {
  return (
    <span
      className="rounded-xs border border-border px-2 text-2xs text-text-muted"
      title="Retired. It cannot be started; PATCH { archived: false } brings it back. Its past runs are untouched."
    >
      archived
    </span>
  );
}

function MobileCard({
  workflow,
  project,
  onOpen,
}: {
  workflow: WorkflowView;
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
      <span className="flex items-center gap-2">
        <span className="truncate text-sm text-text">{workflow.name}</span>
        {workflow.archivedAt === null ? null : <ArchivedChip />}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <span>
          {workflow.scope.length === 0 ? 'scope not stated' : workflowScopeLabel(workflow.scope)}
        </span>
        {project === null ? null : <span>{project}</span>}
      </span>
      <span className="mt-1 block text-2xs text-text-secondary">
        <ChainCell workflow={workflow} />
      </span>
    </button>
  );
}

function RouteMissing() {
  return (
    <div
      role="note"
      data-testid="workflows-route-missing"
      className="rounded-md border p-4"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span> This Backend does not serve{' '}
        <code className="font-mono text-xs">/api/v1{endpoints.agentWorkflows.list}</code> yet.
      </p>
      <p className="mt-1 max-w-3xl text-2xs text-text-muted leading-150">
        The screen is built to PRD §5.6 and stays out of the way until the route exists. It is not
        showing you an empty list, because “no workflows” and “no workflows API” are different facts
        with different fixes, and only one of them is solved by pressing New workflow.
      </p>
    </div>
  );
}

/**
 * Create a workflow — name, scope and the chain.
 *
 * Scope is here and nowhere else: it decides which agents the steps may name
 * (`ck_agent_workflow_steps_agent_scope`), so moving it afterwards could strand steps the workflow
 * is no longer allowed to hold. The chain is offered at create because a workflow created empty is
 * a workflow the operator has to visit twice — and because `POST` takes `steps`.
 */
function CreateWorkflowModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (workflowId: string | null) => void;
}) {
  const [draft, setDraft] = useState<WorkflowDraft>(() => newWorkflowDraft());
  const [attempted, setAttempted] = useState(false);
  const create = useCreateWorkflow();
  const projects = useAgentProjects();
  const agents = useAgentsList(false);

  // Two primitives rather than an object literal, so the memo below depends on values that are
  // stable across renders — an inline `{ scope, projectId }` would re-partition the whole agent
  // list on every keystroke in the name field.
  const scope = draft.scope;
  const scopeProjectId = draft.projectId.length === 0 ? null : draft.projectId;
  const choices = useMemo(
    () => partitionAgentsForWorkflow(agents.read.agents, { scope, projectId: scopeProjectId }),
    [agents.read.agents, scope, scopeProjectId],
  );

  const agentById = useMemo(
    () => new Map(agents.read.agents.map((agent) => [agent.id, agent])),
    [agents.read.agents],
  );

  const ineligibleSteps = useMemo<readonly StepAgentExclusion[]>(() => {
    const exclusions: StepAgentExclusion[] = [];
    for (const step of draft.steps) {
      const agent = agentById.get(step.agentId);
      if (agent === undefined) continue;
      const refusal = stepAgentRefusal(agent, { scope, projectId: scopeProjectId });
      if (refusal !== null) exclusions.push(refusal);
    }
    return exclusions;
  }, [draft.steps, agentById, scope, scopeProjectId]);

  const issues = workflowIssues(draft, {
    mode: 'create',
    projectsAvailable: !projects.isError,
    ineligibleSteps,
  });
  const blocking = blockingWorkflowIssues(issues);
  const shown = attempted ? issues : [];

  const submit = (): void => {
    setAttempted(true);
    if (blocking.length > 0) return;
    create.mutate(
      { body: toCreateWorkflowBody(draft) },
      {
        onSuccess: (workflow) => {
          setDraft(newWorkflowDraft());
          setAttempted(false);
          onCreated(idOf(workflow));
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New workflow"
      width="wide"
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
            {create.isPending ? 'Creating…' : 'Create workflow'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <WorkflowField
          label="Name"
          required
          issues={workflowIssuesFor(shown, 'name')}
          description="Unique among live workflows in the same scope."
        >
          {({ id, describedBy }) => (
            <TextControl
              id={id}
              describedBy={describedBy}
              value={draft.name}
              maxLength={MAX_AGENT_WORKFLOW_NAME_LENGTH}
              placeholder="Review chain"
              onChange={(value) => setDraft((previous) => ({ ...previous, name: value }))}
            />
          )}
        </WorkflowField>

        <WorkflowField label="Description" issues={workflowIssuesFor(shown, 'description')}>
          {({ id }) => (
            <TextAreaControl
              id={id}
              rows={2}
              value={draft.description}
              onChange={(value) => setDraft((previous) => ({ ...previous, description: value }))}
            />
          )}
        </WorkflowField>

        <WorkflowField
          label="Scope"
          required
          issues={workflowIssuesFor(shown, 'scope')}
          description={
            <>
              {workflowScopeDescription(draft.scope)}{' '}
              <strong>Scope cannot be changed after the workflow is created.</strong>
            </>
          }
        >
          {({ id, describedBy }) => (
            <SelectControl
              id={id}
              describedBy={describedBy}
              value={draft.scope}
              options={AGENT_WORKFLOW_SCOPES.map((value) => ({
                value,
                label: workflowScopeLabel(value),
              }))}
              onChange={(value) =>
                setDraft((previous) => applyWorkflowScopeChange(previous, value))
              }
            />
          )}
        </WorkflowField>

        {draft.scope === 'project' ? (
          <WorkflowField label="Project" required issues={workflowIssuesFor(shown, 'projectId')}>
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
          </WorkflowField>
        ) : null}

        <WorkflowField
          label="Chain"
          required
          issues={workflowIssuesFor(shown, 'steps')}
          description="Steps run in this order, one Session each. The next step starts only when the previous one finishes."
        >
          {() => (
            <StepFields
              steps={draft.steps}
              choices={choices}
              agentOf={(agentId) => agentById.get(agentId) ?? null}
              disabled={create.isPending}
              agentsUnavailable={agents.unavailable || agents.isError}
              onChange={(index, next) =>
                setDraft((previous) => ({
                  ...previous,
                  steps: previous.steps.map((step, position) => (position === index ? next : step)),
                }))
              }
              onMove={(index, direction) =>
                setDraft((previous) => ({
                  ...previous,
                  steps: moveStep(previous.steps, index, direction),
                }))
              }
              onRemove={(index) =>
                setDraft((previous) => ({
                  ...previous,
                  steps: previous.steps.filter((_, position) => position !== index),
                }))
              }
              onAdd={() =>
                setDraft((previous) => ({
                  ...previous,
                  steps: [...previous.steps, newStepDraft()],
                }))
              }
            />
          )}
        </WorkflowField>

        <p className="text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span> Creating a workflow starts nothing. A run is a separate,
          deliberate act with its own confirmation — and it is always started by a person, because
          scheduled and autonomous runs are Phase 5 (PRD §15).
        </p>

        {create.isError ? (
          <ErrorPanel error={create.error} title="The workflow was not created" />
        ) : null}
      </div>
    </Modal>
  );
}
