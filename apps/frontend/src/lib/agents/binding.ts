import type { AgentView } from './shape.js';
import { agentScopeLabel } from './vocabulary.js';

/**
 * What binding an Agent *does* to a Session, and whether the Session still admits one.
 *
 * ## What used to be here, and why it is gone
 *
 * This file was a transcription of the Backend's agent-binding refusals: `agentBindingRefusal`
 * and `partitionAgentsForBinding` re-derived, in the browser, which agents a Session could be
 * bound to — five client functions holding themselves to four server refusals with nothing
 * keeping them in step. Add a fifth refusal server-side and the picker silently offers an agent
 * `POST /sessions` then rejects.
 *
 * Bindability is now **asked, never derived**: `GET /projects/{id}/available-agents` answers it
 * from the same `agentBindingRefusal` the write path enforces, and
 * `lib/agents/availability.ts` reads that answer. The refusal sentences the picker renders are
 * the server's own — the same text the `400`/`409` carries — so the explanation and the error it
 * prevents cannot drift apart.
 *
 * ## What stayed, and why none of it is a duplicated rule
 *
 *  - `bindingConsequence` renders the Backend's own `disallowedTools`, served on the Agent
 *    resource and **never recomputed here**. It is a projection, not a decision.
 *  - `agentOptionLabel` is a label.
 *  - `sessionBindability` answers a different question — whether the **Session** still accepts a
 *    change to `agentId` — from two fields the Backend serves on the Session (`sessionType`,
 *    `state`). It remains the one client-side transcription in this domain, because no field on
 *    the Session resource states it; see its own header.
 */

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
 *
 * **This is a transcription, and it is the last one in this domain.** `SessionService`
 * `#resolveAgentChange` holds the rule; no field on the `Session` resource reports it, so there is
 * nothing to read. It is narrower and far more stable than the agent rules that were deleted from
 * this file — two branches over two fields the Backend does serve, both of which are the Session's
 * own identity rather than a relationship between two entities — but it is the same category of
 * risk, and closing it needs a Backend change (a stated `agentBindable`, or a refusal list on the
 * Session) rather than another guess here.
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
