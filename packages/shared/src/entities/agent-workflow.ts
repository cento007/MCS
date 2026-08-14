/**
 * F4.1 — AgentWorkflow vocabulary (PRD §5.6, storage `db/schema/agent-workflows.ts`).
 *
 * Declared here rather than inline in the schema for the reason `agent.ts` and `agent-team.ts`
 * give: the CHECK constraints, the route schemas, the runner and the serializers must all be
 * driven from one list, because a value the database admits and the API cannot express is a row
 * an operator can create and never use (F9.5 vocabulary discipline).
 *
 * ## What a workflow is
 *
 * PRD §5.6 is one line: `Developer → QA → Security → Architect`. A workflow is therefore an
 * **ordered chain of Agents**, and a *run* is what happens when an operator points that chain at
 * a Project with a task. Two entities, and the split matters: the chain is a definition an
 * operator edits, the run is history that must never change afterwards.
 *
 * ## A step is a Session, and there is no second runtime
 *
 * Every step of a run **is** a managed Session bound to that step's Agent
 * (`sessions.agent_id`, Phase 4 slice 1). Nothing here spawns a process, holds a transcript, or
 * accounts for cost — the Session domain already does all three, and a parallel path would mean a
 * second F7 state machine, a second transcript story and a second cost story, permanently drifting
 * from the first. The consequences are exact:
 *
 *   - a step's cost is its Session's `total_cost_usd`, so `GET /spend` counts a workflow without
 *     knowing workflows exist;
 *   - a step's transcript is its Session's transcript, so Export, the Context Package and the
 *     memory indexer all work on it unchanged;
 *   - a step's concurrency slot is its Session's slot, so `maxConcurrentSessions` bounds a
 *     workflow for free.
 *
 * ## The run states, and why there is no `queued`
 *
 * A run has one job — hold the place in the chain — so its vocabulary is the smallest set that
 * distinguishes the operator's four situations:
 *
 *   `running`    a step is in flight (or its launch is waiting for a concurrency slot)
 *   `completed`  the last step finished
 *   `halted`     a step failed. **Not terminal**: the operator fixes what broke and resumes
 *   `stopped`    the operator stopped it. Terminal, and the in-flight Session was ended
 *
 * `queued` is absent because a run never waits as a *run*: the first step's Session is created
 * immediately and the queueing, when it happens, is the Session's (`meta.launch: 'queued'`,
 * TDS 04 §6.2.1). A run state that duplicated it would be a second answer to a question the
 * Session already answers.
 */

/**
 * PRD §5.6 workflows are scoped exactly as §5.7 teams are — see `agent-team.ts` for the full
 * argument. `session` is missing for the same reason: a session agent names the one conversation
 * it belongs to, so it can never be a standing member of anything.
 */
export const AGENT_WORKFLOW_SCOPES = ['global', 'project'] as const;
export type AgentWorkflowScope = (typeof AGENT_WORKFLOW_SCOPES)[number];

export function isAgentWorkflowScope(value: unknown): value is AgentWorkflowScope {
  return typeof value === 'string' && (AGENT_WORKFLOW_SCOPES as readonly string[]).includes(value);
}

/** See the module header for what each one means and why `queued` is not among them. */
export const AGENT_WORKFLOW_RUN_STATES = ['running', 'completed', 'halted', 'stopped'] as const;
export type AgentWorkflowRunState = (typeof AGENT_WORKFLOW_RUN_STATES)[number];

export function isAgentWorkflowRunState(value: unknown): value is AgentWorkflowRunState {
  return (
    typeof value === 'string' && (AGENT_WORKFLOW_RUN_STATES as readonly string[]).includes(value)
  );
}

/** A run is over when nothing more will launch without the operator asking again. */
export const TERMINAL_AGENT_WORKFLOW_RUN_STATES: readonly AgentWorkflowRunState[] = Object.freeze([
  'completed',
  'stopped',
]);

/**
 * One attempt at one step.
 *
 * There is no `pending`: an attempt row is written at the moment its Session is created, so a
 * step that has not been reached has no row rather than a row that claims a future. `stopped` is
 * what an in-flight attempt becomes when the operator stops the run — distinct from `failed`,
 * because nothing went wrong.
 */
export const AGENT_WORKFLOW_RUN_STEP_STATES = [
  'running',
  'completed',
  'failed',
  'stopped',
] as const;
export type AgentWorkflowRunStepState = (typeof AGENT_WORKFLOW_RUN_STEP_STATES)[number];

/**
 * How complete the hand-off into this step was — the honesty flag on the crux of the feature.
 *
 * QA cannot review what it cannot see, so what step N+1 receives from step N is the whole point
 * of a chain. It receives a **context package** (`POST /sessions/{id}/context-package`,
 * TDS 04 §6.7), which was built for "someone resuming abandoned work" and already carries the
 * working tree as of now, the files touched, the commits, the ADRs and related semantic memory —
 * with every gap named in place rather than silently omitted.
 *
 *   `none`      this is the first step; there was no previous Session. Not a degradation
 *   `full`      the package was generated and reached the step whole
 *   `degraded`  it did not. The reason is recorded **and written into the prompt itself**, so
 *               the agent is told rather than handed a plausible-looking gap
 *
 * A fourth value ("we sent nothing and said nothing") is deliberately unrepresentable.
 */
export const AGENT_WORKFLOW_HANDOFF_STATES = ['none', 'full', 'degraded'] as const;
export type AgentWorkflowHandoffState = (typeof AGENT_WORKFLOW_HANDOFF_STATES)[number];

/** Bounds shared by the CHECK constraints and the route schemas — one declaration. */
export const MAX_AGENT_WORKFLOW_NAME_LENGTH = 100;
export const MAX_AGENT_WORKFLOW_DESCRIPTION_LENGTH = 2_000;

/**
 * **The maximum step count, and the first of this slice's three spend bounds.**
 *
 * A chain that spawns Sessions writes code and spends money with no human in the loop between
 * steps, so the number of Sessions one operator action can launch has to be finite *in the
 * database*, not merely in a loop that could be wrong. This is enforced as
 * `ck_agent_workflow_steps_ordinal` (`ordinal BETWEEN 0 AND 9`), which makes an eleventh step
 * unrepresentable rather than merely unwritten.
 *
 * Ten is "obviously more than PRD §5.6's four-agent example needs" rather than a product limit.
 */
export const MAX_AGENT_WORKFLOW_STEPS = 10;

/** A step's standing task ("review the previous step's diff for missing tests"). */
export const MAX_AGENT_WORKFLOW_STEP_INSTRUCTIONS_LENGTH = 4_000;

/** The operator's goal for one run, sent verbatim to every step. */
export const MAX_AGENT_WORKFLOW_RUN_TASK_LENGTH = 20_000;

/**
 * **The absolute ceiling on Sessions one run may ever launch — the second spend bound.**
 *
 * `max_sessions` is per run and chosen by the operator, but it cannot exceed this. It is a
 * separate number from `MAX_AGENT_WORKFLOW_STEPS` because a resumed run re-runs a failed step in
 * a *new* Session (F7 states never move backward), so retries consume budget that step count
 * alone does not describe.
 */
export const MAX_AGENT_WORKFLOW_RUN_SESSIONS = 20;

/**
 * How many retries a run is given beyond one Session per step, unless the operator says
 * otherwise. Three: enough that a transient spawn failure at step 2 does not strand a four-step
 * chain, small enough that a run cannot quietly double its cost.
 */
export const DEFAULT_AGENT_WORKFLOW_RUN_RETRY_BUDGET = 3;

/**
 * The byte ceiling on a step's prompt.
 *
 * It mirrors TDS 04 §6.4's 256 KiB prompt limit, which is enforced by `MAX_PROMPT_BYTES` in
 * `apps/backend/src/sessions/managed/prompts.ts`. Two declarations of one number is exactly the
 * drift this codebase keeps getting bitten by, so the two are pinned together by a unit test
 * (`agents/workflows/handoff.test.ts`) rather than by hope: the constant has to live in
 * `@mc/shared` because a CHECK constraint needs it, and it has to stay equal to the limit the
 * prompt route actually applies because a stored prompt this side accepts and that side rejects
 * would strand a run at the moment it tried to speak.
 */
export const MAX_AGENT_WORKFLOW_PROMPT_BYTES = 256 * 1024;

/**
 * The default Session budget for a run of `stepCount` steps.
 *
 * Clamped to the absolute ceiling, so a ten-step workflow does not silently get a budget of 13
 * when the run table admits at most 20 — it gets 13, and an operator who asks for more than 20
 * is refused at the boundary with the number named.
 */
export function defaultAgentWorkflowRunSessions(stepCount: number): number {
  return Math.min(
    stepCount + DEFAULT_AGENT_WORKFLOW_RUN_RETRY_BUDGET,
    MAX_AGENT_WORKFLOW_RUN_SESSIONS,
  );
}
