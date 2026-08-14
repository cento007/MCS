import type { AgentView } from './shape.js';
import { agentScopeLabel } from './vocabulary.js';

/**
 * Which agents a Session may actually be bound to — and, for every one that is excluded, why.
 *
 * ## Why this is a pure module rather than a filter inside the picker
 *
 * The Backend refuses four different things with three different error codes
 * (`apps/backend/src/agents/binding.ts` + `apps/backend/src/sessions/service.ts`), and a picker
 * that offers an option the API will reject is a picker that turns a design rule into a `400` the
 * operator has to reverse-engineer. The rules are transcribed here, once, with the refusal text
 * attached to each — so the screen can be *silent about nothing*: an agent that is missing from
 * the dropdown is an agent the screen can name and explain.
 *
 * ## The rules, verbatim from the Backend
 *
 * `SessionAgentPort.resolveForSession({ agentId, projectId, sessionId })` refuses:
 *
 *  1. an unknown agent — `VALIDATION_FAILED`;
 *  2. an **archived** agent — `CONFLICT` (*"This agent is archived and cannot be bound to a
 *     session"*). A conflict rather than a validation failure, because the id is perfectly good and
 *     the operator can un-retire it;
 *  3. a **`project`-scoped** agent whose `projectId` differs from the Session's;
 *  4. a **`session`-scoped** agent whose `sessionId` differs from the Session's — which at create
 *     time is *every* session-scoped agent, because the Session does not exist yet.
 *
 * And `SessionService.#resolveAgentChange` refuses two more, about the Session rather than the
 * agent: an **observed** Session (Mission Control does not own its process) and a Session that has
 * left **`created`** (the system prompt is fixed at spawn, so a later binding would be a stored
 * value that contradicts what is running).
 *
 * A scope this build does not recognise is deliberately **offered**: the Backend checks only
 * `project` and `session`, so it would accept the binding, and hiding an option the API accepts is
 * the same category of lie as offering one it refuses. It carries a caveat instead.
 */

export type AgentBindingRefusal =
  | 'archived'
  | 'other_project'
  | 'project_unstated'
  | 'project_unknown'
  | 'session_not_yet'
  | 'session_elsewhere';

export interface AgentBindingExclusion {
  readonly agent: AgentView;
  readonly reason: AgentBindingRefusal;
  /** The rule, and the way out of it. Rendered next to the agent's name, never swallowed. */
  readonly explanation: string;
}

export interface AgentBindingOption {
  readonly agent: AgentView;
  /** Something true and unusual about this option, or `null` when there is nothing to add. */
  readonly caveat: string | null;
}

export interface AgentBindingChoices {
  readonly offerable: readonly AgentBindingOption[];
  readonly excluded: readonly AgentBindingExclusion[];
}

export interface AgentBindingContext {
  /**
   * The Project the Session belongs to. `null` when the operator has not chosen one yet, which
   * makes every project-scoped agent *unevaluable* rather than ineligible — a distinction the
   * exclusion list states, because "pick a project first" and "wrong project" are different
   * instructions.
   */
  readonly projectId: string | null;
  /**
   * The Session being bound, or `null` at create time. `null` is what makes every session-scoped
   * agent unbindable here: such an agent names a Session that does not exist yet.
   */
  readonly sessionId: string | null;
}

/**
 * Why this one agent cannot be bound, or `null` if it can.
 *
 * Exported on its own because the picker re-checks its *selected* value after the Project field
 * changes — an agent chosen for project A is not merely un-offered under project B, it is a stored
 * choice that has silently become invalid, and the operator has to be told rather than have the
 * `[Create]` button fail.
 */
export function agentBindingRefusal(
  agent: AgentView,
  context: AgentBindingContext,
): AgentBindingExclusion | null {
  const refuse = (reason: AgentBindingRefusal, explanation: string): AgentBindingExclusion => ({
    agent,
    reason,
    explanation,
  });

  if (agent.archivedAt !== null) {
    return refuse(
      'archived',
      'Archived. An archived agent cannot be bound to a session — the API answers CONFLICT. Un-archive it on the Agents screen if it should still be used.',
    );
  }

  if (agent.scope === 'project') {
    if (agent.projectId === null) {
      return refuse(
        'project_unstated',
        'Scoped to a project but naming none, which the database does not admit (ck_agents_scope_target). It cannot be matched to this session’s project, so it is not offered.',
      );
    }
    if (context.projectId === null) {
      return refuse(
        'project_unknown',
        'Scoped to one project. Choose the session’s project first — until then there is nothing to match it against.',
      );
    }
    if (agent.projectId !== context.projectId) {
      return refuse(
        'other_project',
        'Scoped to a different project. A project agent is offered to its own project and nowhere else; scope cannot be changed after an agent is created.',
      );
    }
    return null;
  }

  if (agent.scope === 'session') {
    if (context.sessionId === null) {
      return refuse(
        'session_not_yet',
        'Scoped to one session, and this session does not exist yet. Create it first, then bind this agent from the session itself — while it is still in `created`.',
      );
    }
    if (agent.sessionId !== context.sessionId) {
      return refuse(
        'session_elsewhere',
        'Scoped to a different session. A session agent belongs to exactly one conversation (PRD §5.2).',
      );
    }
    return null;
  }

  return null;
}

/**
 * Split a list of agents into what may be offered and what may not, preserving the server's order.
 *
 * The excluded half is not an error path — on a healthy instance it is the normal state, because
 * most agents belong to some other project. It exists so the picker can account for the difference
 * between "this instance has four agents" and "this dropdown has one".
 */
export function partitionAgentsForBinding(
  agents: readonly AgentView[],
  context: AgentBindingContext,
): AgentBindingChoices {
  const offerable: AgentBindingOption[] = [];
  const excluded: AgentBindingExclusion[] = [];

  for (const agent of agents) {
    const refusal = agentBindingRefusal(agent, context);
    if (refusal !== null) {
      excluded.push(refusal);
      continue;
    }
    offerable.push({ agent, caveat: caveatFor(agent) });
  }

  return { offerable, excluded };
}

/**
 * A true, unusual thing about an offerable agent.
 *
 * Only one case exists today, and it is worth stating: an agent whose `scope` this build does not
 * recognise. The Backend checks only `project` and `session`, so it *will* accept the binding —
 * but this client cannot say where such an agent is meant to be offered, and a silent option is
 * how a screen ends up implying knowledge it does not have.
 */
function caveatFor(agent: AgentView): string | null {
  if (agent.scope === 'global') return null;
  if (agent.scope === 'project' || agent.scope === 'session') return null;
  if (agent.scope.length === 0) {
    return 'This Backend served no scope for this agent. It is offered because the API accepts it; this build cannot say where it is meant to apply.';
  }
  return `Scope “${agent.scope}” is not one this build recognises. It is offered because the API accepts it, and shown exactly as served.`;
}

// ------------------------------------------------------------------- the consequence of binding

export type BindingConsequenceKind = 'removes' | 'removes_nothing' | 'not_stated';

export interface BindingConsequence {
  readonly kind: BindingConsequenceKind;
  /** The Backend's own `disallowedTools`, verbatim. Empty for `removes_nothing`/`not_stated`. */
  readonly tools: readonly string[];
  /** True when the agent carries instructions that become the runtime's system prompt. */
  readonly hasPrompt: boolean;
}

/**
 * What binding this agent does to the session — stated before the operator presses `[Create]`.
 *
 * This is the half of the choice that is easy to omit and expensive to discover: an agent's
 * `instructions` become the Claude Agent SDK's appended system prompt, and its permissions become
 * `disallowedTools`, so **binding an agent removes tools from that session**. An operator who
 * learns that from the transcript — a `Bash` call that never happens, an edit the model declines —
 * has been told by the wrong teacher.
 *
 * The tool list is the Backend's, served on the Agent resource and rendered verbatim; it is never
 * re-derived here, so this screen and the launch path cannot disagree about what a denial removes.
 */
export function bindingConsequence(agent: AgentView): BindingConsequence {
  const tools = agent.permissions.disallowedTools;
  const hasPrompt = agent.instructions.trim().length > 0;
  if (tools === null) return { kind: 'not_stated', tools: [], hasPrompt };
  if (tools.length === 0) return { kind: 'removes_nothing', tools: [], hasPrompt };
  return { kind: 'removes', tools, hasPrompt };
}

/** `Architect · Global` — the option label, with the scope it is offered under. */
export function agentOptionLabel(agent: AgentView): string {
  if (agent.scope.length === 0) return agent.name;
  return `${agent.name} · ${agentScopeLabel(agent.scope)}`;
}

// -------------------------------------------------------------- whether the Session admits one

export interface SessionBindability {
  readonly bindable: boolean;
  /** Why not, in one sentence. `null` when it is bindable. */
  readonly reason: string | null;
}

/**
 * Whether an **existing** Session will accept a change to `agentId` (`PATCH /sessions/{id}`).
 *
 * Two refusals, and neither is about the agent:
 *
 *  - an **observed** Session — Mission Control did not launch the process, so it could not apply a
 *    persona to it at all (`OPERATION_NOT_SUPPORTED`);
 *  - a Session past **`created`** — the agent's instructions become the system prompt at spawn and
 *    the runtime offers no way to replace it mid-conversation, so a later binding would be a
 *    stored value that contradicts what is actually running (`CONFLICT`).
 *
 * The second is why the Session header shows the agent as a *fact* rather than a control once a
 * Session is running: a disabled select invites the operator to look for the thing that would
 * re-enable it, and there is nothing.
 */
export function sessionBindability(session: {
  readonly sessionType: string;
  readonly state: string;
}): SessionBindability {
  if (session.sessionType === 'observed') {
    return {
      bindable: false,
      reason:
        'This session is observed — Mission Control did not launch it, so it cannot apply a persona to it.',
    };
  }
  if (session.state !== 'created') {
    return {
      bindable: false,
      reason: `An agent is bound before launch. This session is ‹${session.state}›, so its system prompt is already fixed.`,
    };
  }
  return { bindable: true, reason: null };
}
