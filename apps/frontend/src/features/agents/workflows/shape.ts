import {
  AGENT_WORKFLOW_SCOPES,
  type AgentWorkflowScope,
  defaultAgentWorkflowRunSessions,
  isAgentWorkflowScope,
  MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH,
  MAX_AGENT_WORKFLOW_NAME_LENGTH,
  MAX_AGENT_WORKFLOW_RUN_SESSIONS,
  MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH,
  MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
  MAX_AGENT_WORKFLOW_STEPS,
} from '@mc/shared/types';
import type { AgentView } from '../../../lib/agents/index.js';

/**
 * The AgentWorkflow and AgentWorkflowRun resources, projected and drafted (PRD §5.6).
 *
 * ## The contract this was rebuilt against
 *
 * This slice was briefed with a sketch — `Workflow { steps: [{ agentId, … }] }`,
 * `WorkflowRun { state, steps: [{ agentId, sessionId, state }] }` — and, as in both previous
 * slices, the Backend landed something sharper. Six differences, every one of them the Backend
 * being *more* decided:
 *
 *  - **A step is a Session.** `agent_workflow_run_steps.session_id` is `NOT NULL`: there is no
 *    second runtime, no second state machine, no second cost column. So a step's transcript,
 *    cost and concurrency slot are the Session's, and this screen is an index over them.
 *  - **A run step row is an *attempt*, and steps that have not been reached have no row at all.**
 *    There is no `pending` state, deliberately: "a step that has not been reached has no row rather
 *    than a row that claims a future". The chain on screen is therefore reconstructed from the
 *    run's snapshotted `stepCount` plus the attempts that exist — see `run-state.ts`.
 *  - **A retry is a new row** (`attempt` 0,1,2…), because F7 states never move backward, so
 *    re-running a failed step means a new Session.
 *  - **`halted` is not terminal.** A failed step halts the chain and the run is *resumable*. A
 *    screen that drew it as a crash would be wrong about what the operator can still do.
 *  - **The step's field is `instructions`, not a name or a title.** PRD §5.6's role names are the
 *    agents' own names (the same argument that kept `role` off team membership), so there is no
 *    step label to edit and this build draws no field for one.
 *  - **A run carries a `task`, a `workingDir` and a `maxSessions` budget**, and the workflow
 *    carries none of them: the same chain runs against two checkouts, so a definition that pinned
 *    a path could only ever run in one place.
 *
 * The defensive projection is kept anyway — `unrecognised` still collects everything this build
 * does not read, and every state is a `string` classified rather than a union coerced — because the
 * two apps ship separately and this client will meet a Backend older than itself.
 */

export {
  AGENT_WORKFLOW_SCOPES,
  type AgentWorkflowScope,
  defaultAgentWorkflowRunSessions,
  MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH,
  MAX_AGENT_WORKFLOW_NAME_LENGTH,
  MAX_AGENT_WORKFLOW_RUN_SESSIONS,
  MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH,
  MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
  MAX_AGENT_WORKFLOW_STEPS,
};

const SCOPE_LABELS: Readonly<Record<AgentWorkflowScope, string>> = {
  global: 'Global',
  project: 'Project',
};

export function workflowScopeLabel(scope: string): string {
  return isAgentWorkflowScope(scope) ? SCOPE_LABELS[scope] : scope;
}

export function workflowScopeDescription(scope: string): string {
  switch (scope) {
    case 'global':
      return 'Usable in any project, and therefore limited to global agents: a chain that can run anywhere must not name a persona that only means something inside one project.';
    case 'project':
      return 'Belongs to one project. Its steps may use global agents and that project’s own agents, and its runs work in that project.';
    default:
      return 'This Backend uses a workflow scope this build does not recognise. It is shown exactly as served and never rewritten.';
  }
}

// ------------------------------------------------------------------------------- projections

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringAt(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function textAt(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === 'string' ? value : '';
}

function numberAt(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One step of a **definition**: which agent runs where, and what that position is for.
 *
 * The Backend inlines an **agent summary** (name, scope, project, archived) rather than making
 * every screen resolve the id, and says why: a chain rendering three of four steps because one
 * agent could not be looked up is a chain nobody can debug. The full Agent — and with it
 * `disallowedTools`, which is what the pre-run disclosure needs — is still read separately, because
 * inlining a 20 000-character persona per step would put four of them on a list page.
 */
export interface WorkflowStepView {
  readonly agentId: string;
  /** 0-based, as stored. Screens render `ordinal + 1`, because operators count from one. */
  readonly ordinal: number;
  /** From the summary the Backend inlines. `''` if it served none — never invented. */
  readonly agentName: string;
  readonly agentScope: string;
  readonly agentProjectId: string | null;
  /** Non-null means this step names a retired agent, and a run refuses to start. */
  readonly agentArchivedAt: string | null;
  /**
   * The *step's* standing task — not the agent's persona (`agents.instructions`) and not the run's
   * task. `''` when the Backend serves none, which the schema documents as "the persona and the
   * run's task are the brief".
   */
  readonly instructions: string;
  readonly unrecognised: readonly string[];
  readonly raw: unknown;
}

const KNOWN_STEP_FIELDS = new Set([
  'id',
  'ordinal',
  'agentId',
  'agentName',
  'agentScope',
  'agentProjectId',
  'agentArchivedAt',
  'instructions',
]);

/** `null` when the element names no agent — a step with no agent cannot run or be rendered. */
export function readWorkflowStep(raw: unknown, index: number): WorkflowStepView | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const agentId = stringAt(record, 'agentId');
  if (agentId === null) return null;

  return {
    agentId,
    ordinal: numberAt(record, 'ordinal') ?? index,
    agentName: textAt(record, 'agentName'),
    agentScope: textAt(record, 'agentScope'),
    agentProjectId: stringAt(record, 'agentProjectId'),
    agentArchivedAt: stringAt(record, 'agentArchivedAt'),
    instructions: textAt(record, 'instructions'),
    unrecognised: Object.keys(record).filter((key) => !KNOWN_STEP_FIELDS.has(key)),
    raw,
  };
}

export interface WorkflowView {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** `string`, not `AgentWorkflowScope`: an unrecognised scope renders verbatim, never as blank. */
  readonly scope: string;
  readonly projectId: string | null;
  /** The chain, sorted by `ordinal`. Order is the whole point, so it is not left to chance. */
  readonly steps: readonly WorkflowStepView[];
  /** The document carried a `steps` key at all. Absent is not the same as an empty chain. */
  readonly stepsServed: boolean;
  /**
   * The Backend's own count. Read rather than derived, so a document that serves `stepCount: 4`
   * and three readable steps can be *shown* as inconsistent instead of quietly rendering three.
   */
  readonly stepCount: number | null;
  /** Steps served that named no agent. Counted, never silently dropped. */
  readonly unreadableSteps: number;
  /** Retirement is archival — `agent_workflow_runs.workflow_id` is history, so there is no delete. */
  readonly archivedAt: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly unrecognised: readonly string[];
  readonly raw: unknown;
}

const KNOWN_WORKFLOW_FIELDS = new Set([
  'id',
  'name',
  'description',
  'scope',
  'projectId',
  'steps',
  'stepCount',
  'archivedAt',
  'createdAt',
  'updatedAt',
]);

export function readWorkflow(raw: unknown): WorkflowView | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const id = stringAt(record, 'id');
  const name = typeof record['name'] === 'string' ? record['name'] : null;
  if (id === null || name === null) return null;

  const rawSteps = record['steps'];
  const steps: WorkflowStepView[] = [];
  let unreadableSteps = 0;
  if (Array.isArray(rawSteps)) {
    rawSteps.forEach((entry, index) => {
      const step = readWorkflowStep(entry, index);
      if (step === null) unreadableSteps += 1;
      else steps.push(step);
    });
    // Sorted rather than trusted. The Backend orders by `ordinal`, but a chain rendered in the
    // wrong order is the one defect on this screen that looks exactly like correct output.
    steps.sort((a, b) => a.ordinal - b.ordinal);
  }

  return {
    id,
    name,
    description: textAt(record, 'description'),
    // Never defaulted to `global`: a silent default would widen where a chain may be run.
    scope: stringAt(record, 'scope') ?? '',
    projectId: stringAt(record, 'projectId'),
    steps,
    stepsServed: Array.isArray(rawSteps),
    stepCount: numberAt(record, 'stepCount'),
    unreadableSteps,
    archivedAt: stringAt(record, 'archivedAt'),
    createdAt: stringAt(record, 'createdAt'),
    updatedAt: stringAt(record, 'updatedAt'),
    unrecognised: Object.keys(record).filter((key) => !KNOWN_WORKFLOW_FIELDS.has(key)),
    raw,
  };
}

export interface WorkflowListRead {
  readonly workflows: readonly WorkflowView[];
  readonly unreadable: number;
}

export function readWorkflowList(rows: readonly unknown[]): WorkflowListRead {
  const workflows: WorkflowView[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const workflow = readWorkflow(row);
    if (workflow === null) unreadable += 1;
    else workflows.push(workflow);
  }
  return { workflows, unreadable };
}

// -------------------------------------------------------------------------------------- runs

/**
 * One **attempt** at one step, and the Session it is.
 *
 * `sessionId` is `NOT NULL` in the database — the attempt row and the Session are written in one
 * transaction — but it is still read as nullable here, because this client's job is to render what
 * arrives rather than to assume the contract it was told about.
 */
export interface RunStepView {
  readonly ordinal: number;
  /** 0 for the first try at this position; incremented by each resume. */
  readonly attempt: number;
  readonly agentId: string | null;
  /** The Session this step **is**. The link to the transcript, which is the truth. */
  readonly sessionId: string | null;
  /** Verbatim. Classified by `run-state.ts`, never rewritten here. */
  readonly state: string;
  /** `none` · `full` · `degraded` — how complete the hand-off into this step was. */
  readonly handoffState: string;
  /** Why it was degraded, in the words the prompt itself also carries. */
  readonly handoffReason: string | null;
  /** Size of the prompt this step was sent. The text itself lives in the Session's transcript. */
  readonly handoffPromptBytes: number | null;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** When the prompt reached the runtime — `null` while the launch waits for a concurrency slot. */
  readonly promptSentAt: string | null;
  readonly unrecognised: readonly string[];
  readonly raw: unknown;
}

const KNOWN_RUN_STEP_FIELDS = new Set([
  'id',
  'runId',
  'ordinal',
  'attempt',
  'agentId',
  'sessionId',
  'state',
  'handoff',
  'error',
  'startedAt',
  'completedAt',
  'promptSentAt',
  'createdAt',
  'updatedAt',
]);

export function readRunStep(raw: unknown, index: number): RunStepView | null {
  const record = asRecord(raw);
  if (record === null) return null;

  // `handoff` is a nested object on the resource — `{ state, reason, promptBytes }` — and it is
  // read as one because a partial hand-off is exactly the thing this feature must not render as a
  // complete one.
  const handoff = asRecord(record['handoff']);

  return {
    ordinal: numberAt(record, 'ordinal') ?? index,
    attempt: numberAt(record, 'attempt') ?? 0,
    agentId: stringAt(record, 'agentId'),
    sessionId: stringAt(record, 'sessionId'),
    state: stringAt(record, 'state') ?? '',
    handoffState: handoff === null ? '' : (stringAt(handoff, 'state') ?? ''),
    handoffReason: handoff === null ? null : stringAt(handoff, 'reason'),
    handoffPromptBytes: handoff === null ? null : numberAt(handoff, 'promptBytes'),
    error: stringAt(record, 'error'),
    startedAt: stringAt(record, 'startedAt'),
    completedAt: stringAt(record, 'completedAt'),
    promptSentAt: stringAt(record, 'promptSentAt'),
    unrecognised: Object.keys(record).filter((key) => !KNOWN_RUN_STEP_FIELDS.has(key)),
    raw,
  };
}

export interface WorkflowRunView {
  readonly id: string;
  readonly workflowId: string | null;
  readonly projectId: string | null;
  readonly repositoryId: string | null;
  /** The operator's goal for this run, verbatim — it reached every step exactly as typed. */
  readonly task: string;
  /** The absolute path every step's Session was given. */
  readonly workingDirectory: string;
  readonly branch: string | null;
  readonly model: string | null;
  /** `running` · `completed` · `halted` · `stopped`, verbatim. */
  readonly state: string;
  /** The definition's step count **when this run started** — not today's. */
  readonly stepCount: number | null;
  /** The furthest position reached, 0-based; `null` before the first attempt exists. */
  readonly currentStepOrdinal: number | null;
  readonly maxSessions: number | null;
  readonly sessionsLaunched: number | null;
  /** Why the run halted, in the runner's own words. Present exactly when `state = 'halted'`. */
  readonly haltReason: string | null;
  readonly steps: readonly RunStepView[];
  readonly stepsServed: boolean;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly unrecognised: readonly string[];
  readonly raw: unknown;
}

const KNOWN_RUN_FIELDS = new Set([
  'id',
  'workflowId',
  'projectId',
  'repositoryId',
  'task',
  'workingDirectory',
  'branch',
  'model',
  'state',
  'stepCount',
  'currentStepOrdinal',
  'maxSessions',
  'sessionsLaunched',
  'haltReason',
  'steps',
  'startedAt',
  'completedAt',
  'createdAt',
  'updatedAt',
]);

export function readWorkflowRun(raw: unknown): WorkflowRunView | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const id = stringAt(record, 'id');
  if (id === null) return null;

  const rawSteps = record['steps'];
  const steps: RunStepView[] = [];
  if (Array.isArray(rawSteps)) {
    rawSteps.forEach((entry, index) => {
      const step = readRunStep(entry, index);
      if (step !== null) steps.push(step);
    });
    // By position, then by attempt: the order the chain ran in, and within a position the order
    // the retries happened in.
    steps.sort((a, b) => a.ordinal - b.ordinal || a.attempt - b.attempt);
  }

  return {
    id,
    workflowId: stringAt(record, 'workflowId'),
    projectId: stringAt(record, 'projectId'),
    repositoryId: stringAt(record, 'repositoryId'),
    task: textAt(record, 'task'),
    workingDirectory: textAt(record, 'workingDirectory'),
    branch: stringAt(record, 'branch'),
    model: stringAt(record, 'model'),
    state: stringAt(record, 'state') ?? '',
    stepCount: numberAt(record, 'stepCount'),
    currentStepOrdinal: numberAt(record, 'currentStepOrdinal'),
    maxSessions: numberAt(record, 'maxSessions'),
    sessionsLaunched: numberAt(record, 'sessionsLaunched'),
    haltReason: stringAt(record, 'haltReason'),
    steps,
    stepsServed: Array.isArray(rawSteps),
    startedAt: stringAt(record, 'startedAt'),
    completedAt: stringAt(record, 'completedAt'),
    unrecognised: Object.keys(record).filter((key) => !KNOWN_RUN_FIELDS.has(key)),
    raw,
  };
}

export interface WorkflowRunListRead {
  readonly runs: readonly WorkflowRunView[];
  readonly unreadable: number;
}

export function readWorkflowRunList(rows: readonly unknown[]): WorkflowRunListRead {
  const runs: WorkflowRunView[] = [];
  let unreadable = 0;
  for (const row of rows) {
    const run = readWorkflowRun(row);
    if (run === null) unreadable += 1;
    else runs.push(run);
  }
  return { runs, unreadable };
}

// ------------------------------------------------------------------------------- eligibility

export type StepAgentRefusal = 'session_scoped' | 'other_project' | 'archived';

export interface StepAgentExclusion {
  readonly agent: AgentView;
  readonly reason: StepAgentRefusal;
  readonly explanation: string;
}

export interface WorkflowScopeTarget {
  readonly scope: string;
  readonly projectId: string | null;
}

/**
 * Why this agent may not be a step of this workflow, or `null` if it may.
 *
 * Transcribed from `ck_agent_workflow_steps_agent_scope` and the composite FKs behind it — a
 * global chain holds only global agents, a project chain holds global agents and its own project's,
 * and a session agent fits nothing. It is the same invariant `agent_team_members` keeps, and it is
 * written out again here rather than shared with `teams/shape.ts#memberRefusal` because the
 * sentences differ in what they tell the operator to do: a step is not a roster seat, and a
 * workflow cannot "keep" an archived agent the way a team keeps a member. If a third consumer of
 * this rule appears, it belongs in `lib/agents/`.
 */
export function stepAgentRefusal(
  agent: AgentView,
  workflow: WorkflowScopeTarget,
): StepAgentExclusion | null {
  const refuse = (reason: StepAgentRefusal, explanation: string): StepAgentExclusion => ({
    agent,
    reason,
    explanation,
  });

  if (agent.scope === 'session') {
    return refuse(
      'session_scoped',
      'Session-scoped. It belongs to one conversation and dies with it, so it can never be a standing step of a chain — the database refuses the row (ck_agent_workflow_steps_agent_scope).',
    );
  }
  if (agent.scope === 'project' && agent.projectId !== workflow.projectId) {
    return refuse(
      'other_project',
      workflow.scope === 'global'
        ? 'Scoped to a project. A global workflow may only use global agents — it has to be runnable anywhere, and this agent means something only inside its own project.'
        : 'Scoped to a different project than this workflow.',
    );
  }
  if (agent.archivedAt !== null) {
    return refuse(
      'archived',
      'Archived. An archived agent cannot be bound to a new session, so the run would fail the moment it reached this step. Un-archive it on the Agents screen first.',
    );
  }
  return null;
}

export interface StepAgentChoices {
  readonly eligible: readonly AgentView[];
  readonly excluded: readonly StepAgentExclusion[];
}

export function partitionAgentsForWorkflow(
  agents: readonly AgentView[],
  workflow: WorkflowScopeTarget,
): StepAgentChoices {
  const eligible: AgentView[] = [];
  const excluded: StepAgentExclusion[] = [];
  for (const agent of agents) {
    const refusal = stepAgentRefusal(agent, workflow);
    if (refusal === null) eligible.push(agent);
    else excluded.push(refusal);
  }
  return { eligible, excluded };
}

// ---------------------------------------------------------------------------------- drafting

export interface StepDraft {
  /** A stable list key for React and for reordering — never sent. */
  readonly key: string;
  readonly agentId: string;
  readonly instructions: string;
}

export interface WorkflowDraft {
  readonly name: string;
  readonly description: string;
  /** Create only — scope decides which agents the steps may name, so it is fixed after create. */
  readonly scope: string;
  readonly projectId: string;
  readonly steps: readonly StepDraft[];
}

let stepKeySeed = 0;

/** Not a UUID and never sent: a list key, minted per draft row. */
export function newStepKey(): string {
  stepKeySeed += 1;
  return `step-${stepKeySeed}`;
}

export function newStepDraft(agentId = ''): StepDraft {
  return { key: newStepKey(), agentId, instructions: '' };
}

export function newWorkflowDraft(initialProjectId: string | null = null): WorkflowDraft {
  return {
    name: '',
    description: '',
    scope: initialProjectId === null ? 'global' : 'project',
    projectId: initialProjectId ?? '',
    // One empty step, because a chain with no steps is not a chain and an operator should not have
    // to discover `+ Add step` to begin.
    steps: [newStepDraft()],
  };
}

export function workflowDraftOf(workflow: WorkflowView | null): WorkflowDraft {
  if (workflow === null) return newWorkflowDraft();
  return {
    name: workflow.name,
    description: workflow.description,
    scope: workflow.scope,
    projectId: workflow.projectId ?? '',
    steps: workflow.steps.map((step) => ({
      key: newStepKey(),
      agentId: step.agentId,
      instructions: step.instructions,
    })),
  };
}

/** Switching to `global` clears the project rather than leaving it to fail validation. */
export function applyWorkflowScopeChange(draft: WorkflowDraft, scope: string): WorkflowDraft {
  if (scope === 'project') return { ...draft, scope };
  return { ...draft, scope, projectId: '' };
}

export function moveStep(
  steps: readonly StepDraft[],
  index: number,
  direction: -1 | 1,
): readonly StepDraft[] {
  const target = index + direction;
  if (index < 0 || index >= steps.length || target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  const moved = next[index] as StepDraft;
  next[index] = next[target] as StepDraft;
  next[target] = moved;
  return next;
}

function sameSteps(a: readonly StepDraft[], b: readonly StepDraft[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((step, index) => {
    const other = b[index] as StepDraft;
    return step.agentId === other.agentId && step.instructions === other.instructions;
  });
}

export interface WorkflowDirty {
  readonly changedFields: readonly string[];
  readonly count: number;
  readonly isDirty: boolean;
}

export function workflowDirty(baseline: WorkflowDraft, draft: WorkflowDraft): WorkflowDirty {
  const changedFields = [
    draft.name !== baseline.name ? 'name' : null,
    draft.description !== baseline.description ? 'description' : null,
    sameSteps(draft.steps, baseline.steps) ? null : 'steps',
  ].filter((entry): entry is string => entry !== null);

  return { changedFields, count: changedFields.length, isDirty: changedFields.length > 0 };
}

// -------------------------------------------------------------------------------- validating

export type WorkflowIssueSeverity = 'blocking' | 'advisory';
export type WorkflowIssueField = 'name' | 'description' | 'scope' | 'projectId' | 'steps';

export interface WorkflowFormIssue {
  readonly field: WorkflowIssueField;
  readonly severity: WorkflowIssueSeverity;
  readonly message: string;
  readonly why: string;
}

export interface WorkflowValidationContext {
  readonly mode: 'create' | 'edit';
  /** False when `GET /projects` failed — a project cannot be chosen from a list that is not there. */
  readonly projectsAvailable: boolean;
  /** Steps whose agent this client knows the database would refuse. */
  readonly ineligibleSteps: readonly StepAgentExclusion[];
}

export function workflowIssues(
  draft: WorkflowDraft,
  context: WorkflowValidationContext,
): readonly WorkflowFormIssue[] {
  const issues: WorkflowFormIssue[] = [];
  const name = draft.name.trim();

  if (name.length === 0) {
    issues.push({
      field: 'name',
      severity: 'blocking',
      message: 'A workflow needs a name.',
      why: 'It is what an operator reads before starting a chain that spends money, and the Backend enforces uniqueness on it within a scope.',
    });
  } else if (name.length > MAX_AGENT_WORKFLOW_NAME_LENGTH) {
    issues.push({
      field: 'name',
      severity: 'blocking',
      message: `The name is ${name.length} characters; the limit is ${MAX_AGENT_WORKFLOW_NAME_LENGTH}.`,
      why: 'ck_agent_workflows_name_length rejects a longer one, so saving would fail rather than truncate.',
    });
  }

  if (draft.description.trim().length > MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH) {
    issues.push({
      field: 'description',
      severity: 'blocking',
      message: `The description is ${draft.description.trim().length} characters; the limit is ${MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH}.`,
      why: 'The route schema and ck_agent_workflows_description_length both reject a longer one.',
    });
  }

  if (context.mode === 'create') {
    if (draft.scope.length === 0) {
      issues.push({
        field: 'scope',
        severity: 'blocking',
        message: 'Choose a scope.',
        why: 'Scope decides which agents the steps may name, and it cannot be changed afterwards.',
      });
    }
    if (draft.scope === 'project' && draft.projectId.length === 0) {
      issues.push({
        field: 'projectId',
        severity: 'blocking',
        message: 'A project workflow needs a project.',
        why: context.projectsAvailable
          ? 'A project-scoped workflow may use that project’s own agents and runs there; ck_agent_workflows_scope_target makes the combination unstorable. If this chain should be usable everywhere, its scope is Global — which restricts it to global agents.'
          : 'The projects list could not be read, so there is nothing to choose from. Retry it before saving — or scope this workflow Global, which needs no project at all.',
      });
    }
  }

  const namedSteps = draft.steps.filter((step) => step.agentId.length > 0);
  if (namedSteps.length === 0) {
    issues.push({
      field: 'steps',
      severity: 'blocking',
      message: 'A workflow needs at least one step.',
      why: 'A step is an agent and, optionally, what that position in the chain is for. An empty chain has nothing to run — and a run’s step count must be at least 1.',
    });
  }

  const emptyRows = draft.steps.length - namedSteps.length;
  if (emptyRows > 0 && namedSteps.length > 0) {
    issues.push({
      field: 'steps',
      severity: 'blocking',
      message: `${emptyRows} step ${emptyRows === 1 ? 'row names' : 'rows name'} no agent.`,
      why: 'Every step runs as exactly one agent — that is what makes it a Session. Choose one, or remove the row.',
    });
  }

  if (draft.steps.length > MAX_AGENT_WORKFLOW_STEPS) {
    issues.push({
      field: 'steps',
      severity: 'blocking',
      message: `${draft.steps.length} steps; the limit is ${MAX_AGENT_WORKFLOW_STEPS}.`,
      why: 'ck_agent_workflow_steps_ordinal makes an eleventh step unrepresentable. It is a spend bound: every step is a Session that spends money with no human between it and the last one.',
    });
  }

  const tooLong = draft.steps.filter(
    (step) => step.instructions.trim().length > MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH,
  ).length;
  if (tooLong > 0) {
    issues.push({
      field: 'steps',
      severity: 'blocking',
      message: `${tooLong} step ${tooLong === 1 ? 'has' : 'have'} instructions longer than ${MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH} characters.`,
      why: 'The step instruction is a standing brief for one position in the chain, not a persona — the persona is the agent’s own instructions, and it has its own much larger budget.',
    });
  }

  if (context.ineligibleSteps.length > 0) {
    const names = context.ineligibleSteps.map((exclusion) => exclusion.agent.name).join(', ');
    issues.push({
      field: 'steps',
      severity: 'blocking',
      message: `${names} cannot be a step of this workflow.`,
      why: 'The database refuses the row for the reason listed under the picker, so the save fails rather than the run. Replace the step, or fix the agent.',
    });
  }

  return issues;
}

export function blockingWorkflowIssues(
  issues: readonly WorkflowFormIssue[],
): readonly WorkflowFormIssue[] {
  return issues.filter((issue) => issue.severity === 'blocking');
}

export function workflowIssuesFor(
  issues: readonly WorkflowFormIssue[],
  field: WorkflowIssueField,
): readonly WorkflowFormIssue[] {
  return issues.filter((issue) => issue.field === field);
}

// ----------------------------------------------------------------------------------- writing

/**
 * One step on the wire: `{ agentId, instructions }` and **nothing else**.
 *
 * No `ordinal`. The route's step schema is `additionalProperties: false` with exactly two
 * properties, so sending a position would be a `400` naming the field — and it would be redundant
 * anyway: the array's order *is* the chain, and the Backend assigns the ordinals from it.
 */
function stepBody(step: StepDraft): Record<string, unknown> {
  const instructions = step.instructions.trim();
  return {
    agentId: step.agentId,
    instructions: instructions.length === 0 ? null : instructions,
  };
}

/** `POST /agent-workflows` — the whole document; there is nothing on the server to merge with. */
export function toCreateWorkflowBody(draft: WorkflowDraft): Record<string, unknown> {
  const description = draft.description.trim();
  return {
    name: draft.name.trim(),
    description: description.length === 0 ? null : description,
    scope: draft.scope,
    projectId: draft.scope === 'project' && draft.projectId.length > 0 ? draft.projectId : null,
    steps: draft.steps.filter((step) => step.agentId.length > 0).map(stepBody),
  };
}

/**
 * `PATCH /agent-workflows/{id}` — **only what changed**.
 *
 * `scope` and `projectId` are never sent, for the same reason the team PATCH omits them: scope
 * decides which agents the steps may name, so moving it could strand steps the workflow is no
 * longer allowed to hold.
 *
 * `steps` goes **whole** when any of it moved, and the ordinals are recomputed from the array
 * position. There is no partial form: inserting a step at position 2 changes what positions 3 and 4
 * mean.
 */
export function toPatchWorkflowBody(
  baseline: WorkflowDraft,
  draft: WorkflowDraft,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (draft.name !== baseline.name) body['name'] = draft.name.trim();
  if (draft.description !== baseline.description) {
    const description = draft.description.trim();
    body['description'] = description.length === 0 ? null : description;
  }
  if (!sameSteps(draft.steps, baseline.steps)) {
    body['steps'] = draft.steps.filter((step) => step.agentId.length > 0).map(stepBody);
  }

  return body;
}

// ------------------------------------------------------------------------------ starting a run

export interface RunRequestDraft {
  /**
   * The Project this run works in. `agent_workflow_runs.project_id` is `NOT NULL`, and a **global**
   * workflow does not name one — so for those the operator chooses it here. For a project-scoped
   * workflow it is the workflow's own project and the field is a stated fact rather than a control.
   */
  readonly projectId: string;
  /** The operator's goal, verbatim to every step. Required — a run with no task has no brief. */
  readonly task: string;
  /** The absolute path every step's Session is given. The most consequential field here. */
  readonly workingDirectory: string;
  readonly repositoryId: string;
  readonly branch: string;
  readonly model: string;
  /** The hard ceiling on Sessions this run may launch. The operator's spend bound. */
  readonly maxSessions: number;
}

export function newRunRequestDraft(stepCount: number, projectId: string | null): RunRequestDraft {
  return {
    projectId: projectId ?? '',
    task: '',
    workingDirectory: '',
    repositoryId: '',
    branch: '',
    model: '',
    // The Backend's own default — steps plus a retry budget of three, clamped to the ceiling —
    // imported rather than restated, so the number the dialog shows is the number the API would
    // have chosen if the field were omitted.
    maxSessions: defaultAgentWorkflowRunSessions(Math.max(1, stepCount)),
  };
}

export type RunRequestIssueField = 'projectId' | 'task' | 'workingDirectory' | 'maxSessions';

export interface RunRequestIssue {
  readonly field: RunRequestIssueField;
  readonly message: string;
  readonly why: string;
}

export function runRequestIssues(
  draft: RunRequestDraft,
  stepCount: number,
): readonly RunRequestIssue[] {
  const issues: RunRequestIssue[] = [];
  const task = draft.task.trim();

  if (draft.projectId.length === 0) {
    issues.push({
      field: 'projectId',
      message: 'A run needs a project.',
      why: 'Every step is a Session, and a Session belongs to a project. A global workflow does not name one, so this run has to.',
    });
  }

  if (task.length === 0) {
    issues.push({
      field: 'task',
      message: 'A run needs a task.',
      why: 'It is the operator’s goal and it reaches every step verbatim — the agents’ personas say who is working, the step instructions say what each position is for, and this says what you actually want done.',
    });
  } else if (task.length > MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH) {
    issues.push({
      field: 'task',
      message: `The task is ${task.length} characters; the limit is ${MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH}.`,
      why: 'ck_agent_workflow_runs_task_length rejects a longer one.',
    });
  }

  if (draft.workingDirectory.trim().length === 0) {
    issues.push({
      field: 'workingDirectory',
      message: 'A run needs a working directory.',
      why: 'Every step is a Session, and a Session is given a directory to work in. This is the path the runtime gets write access to.',
    });
  }

  if (
    !Number.isInteger(draft.maxSessions) ||
    draft.maxSessions < Math.max(1, stepCount) ||
    draft.maxSessions > MAX_AGENT_WORKFLOW_RUN_SESSIONS
  ) {
    issues.push({
      field: 'maxSessions',
      message: `The session budget must be between ${Math.max(1, stepCount)} and ${MAX_AGENT_WORKFLOW_RUN_SESSIONS}.`,
      why: `A chain of ${stepCount} steps needs at least ${stepCount} sessions to finish, and ck_agent_workflow_runs_max_sessions caps any run at ${MAX_AGENT_WORKFLOW_RUN_SESSIONS}. Anything above the step count is retry budget.`,
    });
  }

  return issues;
}

/**
 * `POST /agent-workflow-runs` — a run is a top-level resource that names its workflow, not a
 * sub-resource of one.
 *
 * `workflowId`, `projectId`, `task` and `workingDirectory` are the four required fields. Empty
 * optional fields are **omitted** rather than sent as `''`, because the body schema is
 * `additionalProperties: false` with `minLength: 1` on `branch`/`model` and a UUID pattern on
 * `repositoryId` — an empty string there is a `400` for the most common case in the product.
 *
 * `maxSessions` is always sent even though it is optional: the dialog showed the operator a number,
 * and omitting it would let the server choose a different one silently.
 */
export function toStartRunBody(
  workflowId: string,
  draft: RunRequestDraft,
): Record<string, unknown> {
  const branch = draft.branch.trim();
  const model = draft.model.trim();
  return {
    workflowId,
    projectId: draft.projectId,
    task: draft.task.trim(),
    workingDirectory: draft.workingDirectory.trim(),
    maxSessions: draft.maxSessions,
    ...(draft.repositoryId.length === 0 ? {} : { repositoryId: draft.repositoryId }),
    ...(branch.length === 0 ? {} : { branch }),
    ...(model.length === 0 ? {} : { model }),
  };
}
