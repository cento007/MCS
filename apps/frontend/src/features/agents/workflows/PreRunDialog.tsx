import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ErrorPanel } from '../../../components/ErrorPanel.js';
import { Modal } from '../../../components/Modal.js';
import { agentScopeLabel } from '../../../lib/agents/index.js';
import { formatCostUsd, formatMoneyUsd } from '../../../lib/format/index.js';
import { SelectControl, TextAreaControl, TextControl } from '../fields.js';
import { useAgentProjects, useAgentsList } from '../queries.js';
import { positionList, runConsequences, type StepConsequence } from './consequences.js';
import { estimateCoverage } from './estimate.js';
import { idOf, useStartWorkflowRun } from './mutations.js';
import { useWorkflowCostEstimate, useWorkflowRepositories } from './queries.js';
import {
  MAX_AGENT_WORKFLOW_RUN_SESSIONS,
  newRunRequestDraft,
  type RunRequestDraft,
  type RunRequestIssueField,
  runRequestIssues,
  toStartRunBody,
  type WorkflowView,
} from './shape.js';

/**
 * **The screen that has to be right.** What a run is about to do, before it does it (PRD §5.6).
 *
 * ## Why a whole dialog rather than a confirm
 *
 * This is the first thing in Mission Control that spawns *several* AI sessions in sequence with no
 * human between them. Each one spends money on the operator's account and each one can change files
 * in a real working directory — and unlike the Launch dialog, the operator is not choosing the
 * agent here: they chose it days ago, on another screen, and are now about to hand it a task. So
 * the four questions that decide whether starting is safe are all answered *here*, in this order:
 *
 *   1. **How many sessions** — one per step, plus the retry budget, with a hard ceiling the
 *      operator sets. The number is the closest thing to a cost estimate that is honest; a dollar
 *      figure would be a guess about what four agents will decide to do.
 *   2. **Which agents, in which order** — the chain, numbered, with each agent's scope.
 *   3. **What each one is allowed to do** — derived from the Backend's own permission model. A step
 *      whose agent has `shell` can commit, push and merge, because those are all `git`/`gh` through
 *      one Bash tool (`apps/backend/src/agents/permissions.ts`), and that sentence appears in front
 *      of the operator rather than in the permissions documentation.
 *   4. **Where** — the resolved absolute working directory, shown verbatim, exactly as the Launch
 *      dialog shows it. "MCS" is not a directory.
 *
 * ## The acknowledgement
 *
 * Required whenever any step can write, run commands, or name an agent this client cannot fully
 * read — i.e. whenever the consequences are material or unknown. A read-only chain of resolved
 * agents starts without ceremony, because ceremony that fires every time is ceremony nobody reads.
 * The checkbox names the positions and the directory, so it is a sentence about *this* run rather
 * than a legal formality.
 *
 * ## What it deliberately does not offer
 *
 * No schedule, no repeat, no trigger. PRD §15 puts autonomous review flows in Phase 5, and a
 * disabled "run nightly" control here would be a promise this product has not made.
 */

export interface PreRunDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly workflow: WorkflowView;
}

export function PreRunDialog({ open, onClose, workflow }: PreRunDialogProps) {
  const navigate = useNavigate();
  const start = useStartWorkflowRun();
  const projects = useAgentProjects();
  // Archived included: a step may name a retired agent, and this dialog has to be able to say so
  // rather than showing an unresolvable id.
  const agents = useAgentsList(true);

  const [draft, setDraft] = useState<RunRequestDraft>(() =>
    newRunRequestDraft(workflow.steps.length, workflow.projectId),
  );
  const [attempted, setAttempted] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  // Re-seeded on open rather than at mount: this dialog stays mounted between openings, and a task
  // typed for a run that was cancelled must not be silently re-submitted with the next one.
  useEffect(() => {
    if (!open) return;
    setDraft(newRunRequestDraft(workflow.steps.length, workflow.projectId));
    setAttempted(false);
    setAcknowledged(false);
  }, [open, workflow.steps.length, workflow.projectId]);

  const repositories = useWorkflowRepositories(
    draft.projectId.length === 0 ? null : draft.projectId,
    open,
  );
  const estimate = useWorkflowCostEstimate(workflow.id, open);

  const agentById = useMemo(
    () => new Map(agents.read.agents.map((agent) => [agent.id, agent])),
    [agents.read.agents],
  );

  const consequences = useMemo(
    () => runConsequences(workflow.steps, (agentId) => agentById.get(agentId) ?? null),
    [workflow.steps, agentById],
  );

  const repository =
    (repositories.data ?? []).find((candidate) => candidate.id === draft.repositoryId) ?? null;

  // Choosing a repository fills the path from server truth; the operator can still override it,
  // because a run may legitimately work somewhere other than a repository root.
  useEffect(() => {
    if (repository === null) return;
    setDraft((previous) => ({
      ...previous,
      workingDirectory: repository.localPath,
      branch: previous.branch === '' ? repository.defaultBranch : previous.branch,
    }));
  }, [repository]);

  const issues = runRequestIssues(draft, workflow.steps.length);
  const shownIssues = attempted ? issues : [];
  const issueFor = (field: RunRequestIssueField): string | null => {
    const issue = shownIssues.find((entry) => entry.field === field);
    return issue === undefined ? null : `${issue.message} ${issue.why}`;
  };

  const archivedSteps = consequences.archivedPositions;
  const blockedByArchived = archivedSteps.length > 0;
  const blockedByEmptyChain = workflow.steps.length === 0;
  const blockedByArchivedWorkflow = workflow.archivedAt !== null;
  const needsAcknowledgement = consequences.requiresAcknowledgement && !acknowledged;

  const canStart =
    issues.length === 0 &&
    !needsAcknowledgement &&
    !blockedByArchived &&
    !blockedByEmptyChain &&
    !blockedByArchivedWorkflow &&
    !start.isPending;

  /**
   * Why `[Start run]` is disabled, in words, next to the button.
   *
   * A disabled primary with no explanation makes an operator hunt for the control that would
   * re-enable it — the same argument the Agent picker makes about its own disabled state. The
   * per-field errors only appear after an attempt (so a dialog does not open shouting), but the
   * *summary* is always there, because the button is disabled from the first render.
   */
  const blockers: string[] = [];
  if (draft.projectId.length === 0) blockers.push('choose a project');
  if (draft.task.trim().length === 0) blockers.push('write the task');
  if (draft.workingDirectory.trim().length === 0) blockers.push('give a working directory');
  if (issues.some((issue) => issue.field === 'maxSessions'))
    blockers.push('fix the session budget');
  if (needsAcknowledgement) blockers.push('tick the acknowledgement');

  const submit = (): void => {
    setAttempted(true);
    if (!canStart) return;
    start.mutate(
      { workflowId: workflow.id, body: toStartRunBody(workflow.id, draft) },
      {
        onSuccess: (run) => {
          const runId = idOf(run);
          onClose();
          if (runId !== null) void navigate(`/agents/runs/${runId}`);
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Start ${workflow.name}?`}
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
            data-testid="start-run"
            onClick={submit}
            disabled={!canStart}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {start.isPending
              ? 'Starting…'
              : `Start run · up to ${draft.maxSessions} session${draft.maxSessions === 1 ? '' : 's'}`}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Headline workflow={workflow} draft={draft} />
        <CostSection estimate={estimate} maxSessions={draft.maxSessions} />

        <section>
          <h3 className="mb-2 font-medium text-2xs text-text-secondary uppercase">
            What this run will do
          </h3>
          <ol data-testid="prerun-chain" className="flex flex-col gap-2">
            {consequences.steps.map((consequence) => (
              <li key={`${consequence.position}-${consequence.step.agentId}`}>
                <StepCard consequence={consequence} />
              </li>
            ))}
          </ol>
          {blockedByEmptyChain ? (
            <p
              role="alert"
              data-testid="prerun-empty-chain"
              className="text-sm leading-150"
              style={{ color: 'var(--color-danger)' }}
            >
              This workflow has no steps, so there is nothing to run. Add at least one on the page
              behind this dialog.
            </p>
          ) : null}
        </section>

        <ShellWarning consequences={consequences} workingDirectory={draft.workingDirectory} />

        {consequences.unresolvedPositions.length > 0 ? (
          <Caution testId="prerun-unresolved">
            {consequences.unresolvedPositions.length === 1 ? 'Step' : 'Steps'}{' '}
            {positionList(consequences.unresolvedPositions)}{' '}
            {consequences.unresolvedPositions.length === 1 ? 'names' : 'name'} an agent this client
            could not read
            {agents.unavailable
              ? ' — this Backend does not serve /agents at all'
              : agents.isError
                ? ' — the agents list could not be read'
                : ''}
            . What {consequences.unresolvedPositions.length === 1 ? 'it' : 'they'} may do cannot be
            shown here, so this dialog cannot tell you what starting costs you in permissions.
          </Caution>
        ) : null}

        {consequences.toolsNotStatedPositions.length > 0 ? (
          <Caution testId="prerun-tools-not-stated">
            This Backend served no <code className="font-mono">disallowedTools</code> for the agent
            of {consequences.toolsNotStatedPositions.length === 1 ? 'step' : 'steps'}{' '}
            {positionList(consequences.toolsNotStatedPositions)}, so there is no evidence its
            permission switches reach the runtime. They are still applied at launch — this screen
            simply cannot prove it.
          </Caution>
        ) : null}

        {blockedByArchived ? (
          <Blocker testId="prerun-archived-agent">
            {archivedSteps.length === 1 ? 'Step' : 'Steps'} {positionList(archivedSteps)} name an
            archived agent. An archived agent cannot be bound to a new session, so the run would be
            refused. Un-archive it on the Agents screen, or change the step.
          </Blocker>
        ) : null}

        {blockedByArchivedWorkflow ? (
          <Blocker testId="prerun-archived-workflow">
            This workflow is archived, so it cannot be started. Restore it first — its past runs are
            unaffected either way.
          </Blocker>
        ) : null}

        <section className="flex flex-col gap-3">
          <h3 className="font-medium text-2xs text-text-secondary uppercase">Where and what</h3>

          {workflow.scope === 'project' ? (
            <Field label="Project">
              <p data-testid="prerun-project-fixed" className="text-sm text-text">
                {projectLabel(projects.data ?? [], draft.projectId)}
              </p>
              <p className="mt-1 text-2xs text-text-muted leading-150">
                This workflow belongs to one project, so its runs work there. That is what lets its
                steps use that project’s own agents.
              </p>
            </Field>
          ) : (
            <Field label="Project" htmlFor="prerun-project" issue={issueFor('projectId')}>
              <SelectControl
                id="prerun-project"
                value={draft.projectId}
                disabled={projects.isError}
                options={(projects.data ?? []).map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
                unsetLabel={projects.isError ? '— projects unavailable' : '— choose a project'}
                onChange={(value) =>
                  setDraft((previous) => ({
                    ...previous,
                    projectId: value,
                    repositoryId: '',
                  }))
                }
              />
              <p className="mt-1 text-2xs text-text-muted leading-150">
                A global workflow names no project, so this run has to. Only one run per project can
                be running at a time — starting a second is refused with a conflict rather than
                letting two chains edit one working tree.
              </p>
            </Field>
          )}

          <Field label="Task" htmlFor="prerun-task" issue={issueFor('task')} required>
            <TextAreaControl
              id="prerun-task"
              rows={3}
              value={draft.task}
              disabled={start.isPending}
              placeholder="Add rate limiting to the hook-ingest route, with tests."
              onChange={(value) => setDraft((previous) => ({ ...previous, task: value }))}
            />
            <p className="mt-1 text-2xs text-text-muted leading-150">
              Sent verbatim to <strong>every</strong> step. The agents’ own instructions say who is
              working and each step’s instructions say what that position is for; this is what you
              actually want done.
            </p>
          </Field>

          <Field label="Repository" htmlFor="prerun-repository">
            <SelectControl
              id="prerun-repository"
              value={draft.repositoryId}
              disabled={draft.projectId.length === 0 || start.isPending}
              options={(repositories.data ?? []).map((item) => ({
                value: item.id,
                label: item.name,
              }))}
              unsetLabel="— none"
              onChange={(value) => setDraft((previous) => ({ ...previous, repositoryId: value }))}
            />
          </Field>

          <Field
            label="Working directory"
            htmlFor="prerun-working-directory"
            issue={issueFor('workingDirectory')}
            required
          >
            <TextControl
              id="prerun-working-directory"
              value={draft.workingDirectory}
              disabled={start.isPending}
              mono
              placeholder="D:\Repos\MCS"
              onChange={(value) =>
                setDraft((previous) => ({ ...previous, workingDirectory: value }))
              }
            />
            <p className="mt-1 text-2xs text-text-muted leading-150">
              The resolved absolute path every step’s session is given write access to — the same
              directory for the whole chain, which is how step 2 sees what step 1 wrote.
            </p>
          </Field>

          <div className="flex flex-wrap gap-3">
            <div className="min-w-0 flex-1">
              <Field label="Branch" htmlFor="prerun-branch">
                <TextControl
                  id="prerun-branch"
                  value={draft.branch}
                  disabled={start.isPending}
                  mono
                  placeholder={repository?.defaultBranch ?? 'leave empty for the current branch'}
                  onChange={(value) => setDraft((previous) => ({ ...previous, branch: value }))}
                />
              </Field>
            </div>
            <div className="min-w-0 flex-1">
              <Field label="Model" htmlFor="prerun-model">
                <TextControl
                  id="prerun-model"
                  value={draft.model}
                  disabled={start.isPending}
                  placeholder="default (from Settings)"
                  onChange={(value) => setDraft((previous) => ({ ...previous, model: value }))}
                />
              </Field>
            </div>
          </div>

          <Field
            label="Session budget"
            htmlFor="prerun-max-sessions"
            issue={issueFor('maxSessions')}
          >
            <input
              id="prerun-max-sessions"
              type="number"
              inputMode="numeric"
              min={Math.max(1, workflow.steps.length)}
              max={MAX_AGENT_WORKFLOW_RUN_SESSIONS}
              value={draft.maxSessions}
              disabled={start.isPending}
              aria-label="Session budget"
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  maxSessions: Number.parseInt(event.target.value, 10) || 0,
                }))
              }
              className="rounded-sm border bg-transparent px-2 text-sm text-text"
              style={{
                width: 96,
                height: 'var(--mc-control-md)',
                borderColor: 'var(--color-border-control)',
                backgroundColor: 'var(--color-surface-inset)',
              }}
            />
            <p className="mt-1 text-2xs text-text-muted leading-150">
              The hard ceiling on Sessions this run may ever launch — {workflow.steps.length} for
              the chain itself, and the rest is retry budget, because resuming a failed step starts
              a new session rather than reopening the old one. The run cannot exceed it: the
              database refuses the row. Maximum {MAX_AGENT_WORKFLOW_RUN_SESSIONS}.
            </p>
          </Field>
        </section>

        {consequences.requiresAcknowledgement ? (
          <div
            data-testid="prerun-acknowledgement"
            className="rounded-sm border p-3"
            style={{
              backgroundColor: 'var(--color-warning-subtle)',
              borderColor: 'var(--color-warning)',
            }}
          >
            <label className="flex items-start gap-2 text-sm text-text leading-150">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                style={{ width: 16, height: 16, minWidth: 16, marginTop: 3 }}
              />
              <span>{acknowledgementText(consequences, draft)}</span>
            </label>
          </div>
        ) : null}

        {canStart || start.isPending || blockers.length === 0 ? null : (
          <p
            data-testid="prerun-blockers"
            className="text-2xs text-text-muted leading-150"
            aria-live="polite"
          >
            <span aria-hidden="true">ⓘ</span> Before this run can start: {blockers.join(', ')}.
          </p>
        )}

        <p className="text-2xs text-text-muted leading-150">
          <span aria-hidden="true">ⓘ</span> A run starts because you pressed the button. Mission
          Control never starts one on a schedule or in response to an event — autonomous and
          scheduled runs are Phase 5 (PRD §15), and there is deliberately no control for them here.
        </p>

        {start.isError ? <ErrorPanel error={start.error} title="The run did not start" /> : null}
      </div>
    </Modal>
  );
}

/**
 * **What this run is likely to cost**, from the Backend's own cost-estimate read model.
 *
 * The endpoint is careful and this rendering keeps it that way: the figure is *history* — what each
 * step's agent has actually cost across its completed sessions — so with two of four steps never
 * having run, it is the cost of half a chain and says so in the same sentence. A single confident
 * dollar figure here would be the invention the endpoint exists to avoid.
 *
 * The daily budget sits beside it, because "$0.42" means nothing without "$6.58 left today".
 */
function CostSection({
  estimate,
  maxSessions,
}: {
  estimate: ReturnType<typeof useWorkflowCostEstimate>;
  maxSessions: number;
}) {
  if (estimate.isPending) {
    return (
      <p className="text-2xs text-text-muted leading-150" role="status">
        Reading what this chain has cost before…
      </p>
    );
  }

  if (estimate.estimate === null) {
    return (
      <p data-testid="prerun-cost-unavailable" className="text-2xs text-text-muted leading-150">
        <span aria-hidden="true">ⓘ</span> This Backend could not tell this screen what the chain has
        cost before, so no figure is shown. That is not the same as free: what is bounded here is
        the number of sessions ({maxSessions}), not the money.
      </p>
    );
  }

  const view = estimate.estimate;
  const coverage = estimateCoverage(view);
  const budget = view.budget;

  return (
    <div
      data-testid="prerun-cost"
      className="rounded-md border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <p className="text-sm text-text leading-150">
        {coverage.nothingMeasured ? (
          <>
            <strong>No cost history.</strong> None of these agents has completed a session that
            recorded a cost, so there is nothing to project from — this run’s price is genuinely
            unknown until it runs.
          </>
        ) : (
          <>
            Previous sessions by these agents averaged{' '}
            <strong>{formatCostUsd(view.projected?.meanUsd ?? null)}</strong> for the chain, and
            cost <strong>{formatCostUsd(view.projected?.maxUsd ?? null)}</strong> at their worst.
          </>
        )}
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        {coverage.partial ? (
          <>
            <span aria-hidden="true">▲</span> That covers {coverage.measured} of {coverage.total}{' '}
            steps — the other {coverage.total - coverage.measured} have never run, so the figure is
            a <strong>floor</strong>, not a total.{' '}
          </>
        ) : null}
        It is history rather than a forecast: nothing here can predict what a model will decide to
        do, and a retried step spends again.
        {budget.dailyUsd === null ? (
          ' No daily cost budget is configured, so nothing will stop this run on spend.'
        ) : (
          <>
            {' '}
            Today’s budget is {formatMoneyUsd(budget.dailyUsd)} with{' '}
            {formatMoneyUsd(budget.spentTodayUsd)} spent — {formatMoneyUsd(budget.remainingUsd)}{' '}
            left.
          </>
        )}
      </p>
    </div>
  );
}

function Headline({ workflow, draft }: { workflow: WorkflowView; draft: RunRequestDraft }) {
  const steps = workflow.steps.length;
  return (
    <div
      data-testid="prerun-headline"
      className="rounded-md border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface-inset)' }}
    >
      <p className="text-sm text-text leading-150">
        This creates <strong>{steps === 1 ? 'one session' : `${steps} sessions`}</strong>, one per
        step, and runs them one after another — up to <strong>{draft.maxSessions} in total</strong>{' '}
        if steps have to be retried. Each one is a Claude Code session that spends tokens on your
        account, and <strong>nothing between the steps asks you again</strong>.
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        Cost is not estimated here, because it depends on what each agent decides to do. What is
        bounded is the number of sessions, below. Each session’s own cost appears on it as it runs,
        and in the Dashboard’s spend total.
      </p>
    </div>
  );
}

/** One step of the chain, with everything the operator needs to judge it. */
function StepCard({ consequence }: { consequence: StepConsequence }) {
  const { agent, step } = consequence;
  const name = agent?.name ?? (step.agentName.length > 0 ? step.agentName : null);
  const scope = agent?.scope ?? step.agentScope;

  return (
    <div
      data-testid="prerun-step"
      className="flex flex-wrap items-start gap-2 rounded-sm border border-border p-3"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <span
        aria-hidden="true"
        className="flex items-center justify-center rounded-full font-medium text-2xs"
        style={{
          width: 24,
          height: 24,
          backgroundColor: 'var(--color-surface-raised)',
          color: 'var(--color-text-secondary)',
        }}
      >
        {consequence.position}
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm text-text">
          <span className="sr-only">Step {consequence.position}: </span>
          {name ?? (
            <span className="text-text-muted">
              agent {step.agentId.slice(-6)} — not readable on this instance
            </span>
          )}
          {scope.length === 0 ? null : (
            <span className="text-text-secondary text-xs"> · {agentScopeLabel(scope)}</span>
          )}
          {step.agentArchivedAt === null ? null : (
            <span className="ml-2 text-2xs" style={{ color: 'var(--color-warning)' }}>
              archived
            </span>
          )}
        </p>

        {step.instructions.trim().length === 0 ? null : (
          <p className="mt-1 text-2xs text-text-secondary leading-150">{step.instructions}</p>
        )}

        <p
          data-testid="prerun-step-capability"
          className="mt-1 text-2xs leading-150"
          style={{
            color: consequence.canShell ? 'var(--color-warning)' : 'var(--color-text-muted)',
          }}
        >
          <span aria-hidden="true">{consequence.canShell ? '▲' : 'ⓘ'}</span> {consequence.summary}
        </p>

        {consequence.removes === null || consequence.removes.length === 0 ? null : (
          <details className="mt-1 text-2xs text-text-muted">
            <summary className="cursor-pointer" style={{ minHeight: 24 }}>
              {consequence.removes.length} tools removed from this step’s runtime
            </summary>
            <p className="mt-1 flex flex-wrap gap-1">
              {consequence.removes.map((tool) => (
                <code
                  key={tool}
                  data-testid="prerun-removed-tool"
                  className="rounded-xs px-2 py-05 font-mono text-2xs text-text-secondary"
                  style={{ backgroundColor: 'var(--color-surface-inset)' }}
                >
                  {tool}
                </code>
              ))}
            </p>
            <p className="mt-1 leading-150">
              The list is the Backend’s, derived from the agent’s permissions by the same function
              the launch path calls — it is not recomputed here, so the two cannot disagree.
            </p>
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * The sentence this dialog exists for.
 *
 * `shell` is not "runs commands": it is commit, push and merge, because the runtime cannot separate
 * them — one Bash tool, and `sh -c 'git merge …'` defeats any attempt to decide by parsing command
 * strings. Saying "runs shell commands" and leaving the operator to work out the rest would be
 * technically true and practically useless.
 */
function ShellWarning({
  consequences,
  workingDirectory,
}: {
  consequences: ReturnType<typeof runConsequences>;
  workingDirectory: string;
}) {
  if (consequences.shellPositions.length === 0) {
    if (consequences.writePositions.length === 0) return null;
    return (
      <Caution testId="prerun-write-warning">
        {consequences.writePositions.length === 1 ? 'Step' : 'Steps'}{' '}
        {positionList(consequences.writePositions)} can <strong>write files</strong> in{' '}
        {workingDirectory.trim().length === 0 ? (
          'the working directory chosen below'
        ) : (
          <code className="font-mono">{workingDirectory}</code>
        )}
        . No step can run a shell command, so nothing in this chain can commit, push or merge.
      </Caution>
    );
  }

  return (
    <div
      role="note"
      data-testid="prerun-shell-warning"
      className="rounded-md border p-3"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
      }}
    >
      <p className="text-sm text-text leading-150">
        <span aria-hidden="true">▲</span>{' '}
        {consequences.shellPositions.length === 1 ? 'Step' : 'Steps'}{' '}
        {positionList(consequences.shellPositions)} can run <strong>any shell command</strong> in{' '}
        {workingDirectory.trim().length === 0 ? (
          'the working directory chosen below'
        ) : (
          <code className="font-mono">{workingDirectory}</code>
        )}
        .
      </p>
      <p className="mt-1 text-2xs text-text-muted leading-150">
        That is `git` and `gh`, so those steps can commit, push and merge — PRD §5.5 lists those as
        separate permissions and this product deliberately does not, because the runtime exposes
        them all through one Bash tool and splitting them into switches would be a safety claim it
        could not keep.
      </p>
    </div>
  );
}

function acknowledgementText(
  consequences: ReturnType<typeof runConsequences>,
  draft: RunRequestDraft,
): string {
  const where =
    draft.workingDirectory.trim().length === 0 ? 'the working directory' : draft.workingDirectory;

  if (consequences.shellPositions.length > 0) {
    return `I understand that ${consequences.shellPositions.length === 1 ? 'step' : 'steps'} ${positionList(consequences.shellPositions)} can run shell commands — including commit, push and merge — in ${where}, and that up to ${draft.maxSessions} sessions may run without asking me again.`;
  }
  if (consequences.writePositions.length > 0) {
    return `I understand that ${consequences.writePositions.length === 1 ? 'step' : 'steps'} ${positionList(consequences.writePositions)} can change files in ${where}, and that up to ${draft.maxSessions} sessions may run without asking me again.`;
  }
  return `I understand that this run’s permissions cannot be fully shown here, and that up to ${draft.maxSessions} sessions may run without asking me again.`;
}

function projectLabel(
  projects: readonly { readonly id: string; readonly name: string }[],
  projectId: string,
): string {
  const match = projects.find((project) => project.id === projectId);
  return match?.name ?? `project ${projectId.slice(-6)}`;
}

/**
 * A labelled field.
 *
 * `<label htmlFor>`, not a `<p>` above the control — which is what this was until the suite could
 * not find the Task field by its name. That failure was the accessibility defect showing itself:
 * a paragraph that looks like a label is not one, so the input had no accessible name at all and a
 * screen-reader user would have met four unlabelled boxes on the most consequential dialog in the
 * product. `htmlFor` is required for every field that has a control.
 */
function Field({
  label,
  htmlFor,
  children,
  issue = null,
  required = false,
}: {
  label: string;
  /** Omitted only for a field that states a fact instead of taking input. */
  htmlFor?: string;
  children: React.ReactNode;
  issue?: string | null;
  required?: boolean;
}) {
  return (
    <div>
      {htmlFor === undefined ? (
        <p className="mb-1 text-text-secondary text-xs">{label}</p>
      ) : (
        <label htmlFor={htmlFor} className="mb-1 block text-text-secondary text-xs">
          {label}
          {required ? (
            <span className="ml-1 text-text-muted" title="Required">
              *
            </span>
          ) : null}
        </label>
      )}
      {children}
      {issue === null ? null : (
        <p
          role="alert"
          className="mt-1 text-2xs leading-150"
          style={{ color: 'var(--color-danger)' }}
        >
          <span aria-hidden="true">✕</span> {issue}
        </p>
      )}
    </div>
  );
}

function Caution({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p
      role="note"
      data-testid={testId}
      className="rounded-sm border p-3 text-2xs leading-150"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        borderColor: 'var(--color-warning)',
        color: 'var(--color-text)',
      }}
    >
      <span aria-hidden="true">▲</span> {children}
    </p>
  );
}

function Blocker({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p
      role="alert"
      data-testid={testId}
      className="rounded-sm border p-3 text-sm leading-150"
      style={{
        backgroundColor: 'var(--color-danger-subtle)',
        borderColor: 'var(--color-danger)',
        color: 'var(--color-text)',
      }}
    >
      <span aria-hidden="true">✕</span> {children}
    </p>
  );
}
