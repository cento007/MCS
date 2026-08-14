import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Modal } from '../../components/Modal.js';
import { Skeleton } from '../../components/Skeleton.js';
import { type AgentBindingExclusion, agentBindingRefusal } from '../../lib/agents/index.js';
import { useUiStore } from '../../stores/ui-store.js';
import { AgentField } from './AgentField.js';
import { useBindableAgents, useProjectTeam } from './agents.js';
import { useCreateSession } from './mutations.js';
import { useProjects, useRepositories } from './queries.js';

/**
 * The Launch Session modal (TDS 06 §5.4.1).
 *
 * **One action, `[Create]`.** It creates the Session in `created` and opens it; the operator
 * starts it by typing the first prompt into the (enabled) composer or with `[Start]`. There is
 * no initial-prompt field here on purpose — two prompt-entry surfaces for the same first
 * prompt is a duplicated concept with two different failure modes.
 *
 * **The working-tree disclosure (WC11) is the substance of this dialog.** The operator is
 * about to give an agentic runtime write access to a directory, so the resolved absolute
 * native path is shown verbatim — "MCS" is not a directory — and a branch change is stated in
 * plain language with an explicit acknowledgement before `[Create]` unblocks. This disclosure
 * is precisely why §9.2 omits a mobile launch entry point: it cannot be honestly reviewed on a
 * phone.
 */

export interface WorkingTreeStatus {
  /** The branch the repository is **currently** on — not its default branch. */
  readonly currentBranch: string;
  readonly uncommittedFiles: number;
}

export type DisclosureKind = 'none' | 'change' | 'unknown';

export interface BranchDisclosure {
  readonly kind: DisclosureKind;
  readonly requiresAcknowledgement: boolean;
  readonly message: string | null;
}

/**
 * The disclosure decision, as a pure function so the "when is the checkbox mandatory" rule is
 * testable without a DOM.
 *
 * The `unknown` case is not a placeholder. Mission Control has no endpoint that reports a
 * repository's current branch or dirty-file count (WS2 exposes `defaultBranch` only, §5.1),
 * and a dialog that quietly omits the warning because it *cannot check* would be asserting
 * safety it has not verified. Unknown therefore behaves like a branch change: state the risk,
 * require the acknowledgement.
 */
export function branchDisclosure(input: {
  readonly repositoryName: string | null;
  readonly workingDirectory: string;
  readonly branch: string;
  readonly status: WorkingTreeStatus | null;
}): BranchDisclosure {
  const branch = input.branch.trim();
  if (branch.length === 0) return { kind: 'none', requiresAcknowledgement: false, message: null };

  const name = input.repositoryName ?? 'This repository';

  if (input.status === null) {
    return {
      kind: 'unknown',
      requiresAcknowledgement: true,
      message: `Mission Control cannot read this repository's working tree, so it cannot tell you what is uncommitted. Starting this session may check ${name} out to ‹${branch}› in ‹${input.workingDirectory}›.`,
    };
  }

  if (input.status.currentBranch === branch) {
    // No ceremony for the safe path (§5.4.1) — the dirty count is still shown as context.
    return { kind: 'none', requiresAcknowledgement: false, message: null };
  }

  return {
    kind: 'change',
    requiresAcknowledgement: true,
    message: `${name} will be checked out to ‹${branch}› — ${input.status.uncommittedFiles} uncommitted file${
      input.status.uncommittedFiles === 1 ? '' : 's'
    } in ‹${input.workingDirectory}›.`,
  };
}

export interface LaunchSessionModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /**
   * Working-tree facts, when a source for them exists. Injected rather than fetched here so
   * the disclosure has one shape whether it comes from an endpoint or from nothing at all.
   */
  readonly workingTree?: WorkingTreeStatus | null;
  /**
   * Pre-selects the Project, for a launch composed from somewhere that already knows which one
   * — the Project detail's `+ New Session` (TDS 06 §5.3.2: "pre-scoped to this Project"). It
   * seeds the field; it does not lock it, because the operator may well have opened the dialog
   * from the wrong page.
   */
  readonly initialProjectId?: string | null;
}

export function LaunchSessionModal({
  open,
  onClose,
  workingTree = null,
  initialProjectId = null,
}: LaunchSessionModalProps) {
  const navigate = useNavigate();
  const openSession = useUiStore((state) => state.openSession);

  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [repositoryId, setRepositoryId] = useState('');
  const [branch, setBranch] = useState('');
  const [model, setModel] = useState('');
  const [agentId, setAgentId] = useState('');
  const [withdrawnAgent, setWithdrawnAgent] = useState<AgentBindingExclusion | null>(null);
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);

  const projects = useProjects(open);
  const repositories = useRepositories(projectId === '' ? null : projectId, open);
  /**
   * `sessionId: null` is what makes every **session-scoped** agent unofferable here, and it is a
   * fact rather than a placeholder: such an agent names the Session it belongs to, and this Session
   * does not exist yet. The exclusion list says so, and points at the surface that can bind one.
   */
  const agents = useBindableAgents(
    { projectId: projectId === '' ? null : projectId, sessionId: null },
    open,
  );
  /** PRD §5.7 emphasis only — the Project's team leads the picker. Fails soft in every direction. */
  const team = useProjectTeam(projectId === '' ? null : projectId, open);
  const create = useCreateSession();

  const repository =
    (repositories.data ?? []).find((candidate) => candidate.id === repositoryId) ?? null;

  // Selecting a repository fills the path from server truth; the operator can still override
  // it, because a Session may legitimately run somewhere other than a repository root.
  useEffect(() => {
    if (repository === null) return;
    setWorkingDirectory(repository.localPath);
    setBranch((current) => (current === '' ? repository.defaultBranch : current));
  }, [repository]);

  useEffect(() => {
    if (open) return;
    setAcknowledged(false);
  }, [open]);

  /**
   * A chosen agent that the *new* Project would not accept is withdrawn, and named.
   *
   * This is the one way this dialog can hold a value the API will reject: an operator picks the
   * ERP Architect, then realises they meant a different project. Leaving the selection in place
   * would turn `[Create]` into a `400 VALIDATION_FAILED` about a field three rows up; clearing it
   * silently would drop a deliberate choice with no event. So it is cleared *and* stated, with the
   * same sentence the exclusion list uses.
   */
  useEffect(() => {
    if (agentId === '') return;
    const agent = agents.all.find((candidate) => candidate.id === agentId);
    if (agent === undefined) return;
    const refusal = agentBindingRefusal(agent, {
      projectId: projectId === '' ? null : projectId,
      sessionId: null,
    });
    if (refusal === null) return;
    setAgentId('');
    setWithdrawnAgent(refusal);
  }, [agentId, agents.all, projectId]);

  // Opening the dialog adopts the caller's Project. Applied on open rather than only at mount
  // because this component stays mounted between openings on the Sessions list.
  useEffect(() => {
    if (!open || initialProjectId === null) return;
    setProjectId(initialProjectId);
  }, [open, initialProjectId]);

  const disclosure = branchDisclosure({
    repositoryName: repository?.name ?? null,
    workingDirectory,
    branch,
    status: workingTree,
  });

  const blockedByDisclosure = disclosure.requiresAcknowledgement && !acknowledged;
  const canCreate =
    projectId !== '' &&
    workingDirectory.trim().length > 0 &&
    !blockedByDisclosure &&
    !create.isPending;

  const submit = (): void => {
    if (!canCreate) return;
    create.mutate(
      {
        projectId,
        workingDirectory: workingDirectory.trim(),
        ...(repositoryId === '' ? {} : { repositoryId }),
        ...(branch.trim() === '' ? {} : { branch: branch.trim() }),
        ...(model.trim() === '' ? {} : { model: model.trim() }),
        // Omitted entirely when no agent is chosen. `POST /sessions` is `additionalProperties:
        // false` with a UUID pattern on `agentId`, so sending `''` would be a `400` for the most
        // common case in the product.
        ...(agentId === '' ? {} : { agentId }),
      },
      {
        onSuccess: (session) => {
          openSession(session.id);
          onClose();
          void navigate(`/sessions/${session.id}`);
        },
      },
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New Session"
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
            disabled={!canCreate}
            className="rounded-sm px-3 font-medium text-sm disabled:opacity-50"
            style={{
              height: 'var(--mc-control-md)',
              backgroundColor: 'var(--color-accent)',
              color: 'var(--color-on-accent)',
            }}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </button>
        </>
      }
    >
      {projects.isPending ? (
        <div className="space-y-2">
          <Skeleton height={32} />
          <Skeleton height={32} />
        </div>
      ) : projects.isError ? (
        // A picker rendered empty because its endpoint 404s reads as "no projects exist",
        // which is a different and much worse statement than "this API is not available".
        <ErrorPanel
          error={projects.error}
          title="Projects are unavailable, so a session cannot be composed"
          onRetry={() => void projects.refetch()}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <Field label="Project">
            <select
              value={projectId}
              aria-label="Project"
              onChange={(event) => {
                setProjectId(event.target.value);
                setRepositoryId('');
              }}
              className="w-full rounded-sm border bg-transparent px-2 text-sm text-text"
              style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
            >
              <option value="">Select a project…</option>
              {(projects.data ?? []).map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Repository">
            <select
              value={repositoryId}
              aria-label="Repository"
              disabled={projectId === ''}
              onChange={(event) => setRepositoryId(event.target.value)}
              className="w-full rounded-sm border bg-transparent px-2 text-sm text-text"
              style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
            >
              <option value="">None</option>
              {(repositories.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Branch">
            <input
              value={branch}
              aria-label="Branch"
              onChange={(event) => {
                setBranch(event.target.value);
                setAcknowledged(false);
              }}
              placeholder={repository?.defaultBranch ?? 'leave empty to use the current branch'}
              className="w-full rounded-sm border bg-transparent px-2 font-mono text-sm text-text"
              style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
            />
          </Field>

          <Field label="Model">
            <input
              value={model}
              aria-label="Model"
              onChange={(event) => setModel(event.target.value)}
              placeholder="default (from Settings)"
              className="w-full rounded-sm border bg-transparent px-2 text-sm text-text"
              style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
            />
          </Field>

          {/*
           * PRD §5.1's `Runtime → Agent → Task`. Placed after Model because it is the layer above
           * it — the persona that runs on the runtime — and before the working directory because
           * the disclosure below is the dialog's conclusion and nothing should come after it.
           */}
          <AgentField
            read={agents}
            team={team}
            value={agentId}
            onChange={(next) => {
              setAgentId(next);
              setWithdrawnAgent(null);
            }}
            withdrawn={withdrawnAgent}
            disabledReason={
              projectId === ''
                ? 'Choose a project first. A project-scoped agent is only offered to its own project, so there is nothing to match against until then.'
                : null
            }
          />

          <Field label="Working directory">
            <input
              value={workingDirectory}
              aria-label="Working directory"
              onChange={(event) => setWorkingDirectory(event.target.value)}
              placeholder="D:\Repos\MCS"
              className="w-full rounded-sm border bg-transparent px-2 font-mono text-sm text-text"
              style={{ height: 'var(--mc-control-md)', borderColor: 'var(--color-border-control)' }}
            />
            <p className="mt-1 text-2xs text-text-muted">
              The resolved absolute path the runtime is given write access to.
            </p>
          </Field>

          {workingTree === null ? (
            <p className="text-2xs text-text-muted">
              Working-tree status unavailable — Mission Control cannot yet read this
              repository&apos;s current branch or uncommitted files.
            </p>
          ) : (
            <p className="text-2xs text-text-muted">
              Repository is on <span className="font-mono">{workingTree.currentBranch}</span> ·{' '}
              {workingTree.uncommittedFiles} uncommitted file
              {workingTree.uncommittedFiles === 1 ? '' : 's'}
            </p>
          )}

          {disclosure.message === null ? null : (
            <div
              data-testid="branch-disclosure"
              className="rounded-sm border p-3"
              style={{
                backgroundColor: 'var(--color-warning-subtle)',
                borderColor: 'var(--color-warning)',
              }}
            >
              <p className="text-sm text-text leading-150">
                <span aria-hidden="true">⚠</span> {disclosure.message}
              </p>
              <label className="mt-2 flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                I understand
              </label>
            </div>
          )}

          {create.isError ? <ErrorPanel error={create.error} /> : null}
        </div>
      )}
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-text-secondary text-xs">{label}</p>
      {children}
    </div>
  );
}
