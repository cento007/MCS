/**
 * `SessionAgentPort` — the seam between the Session domain and the Agent domain (PRD §5.1's
 * `Runtime → Agent → Task`, read right to left).
 *
 * Declared here, in `sessions/`, and implemented in `agents/`, for the same reason
 * `SessionRuntimePort` is: this is what the Session domain *needs*, expressed without knowing how
 * an Agent is stored, scoped or archived. `sessions/` never imports the agents store, never sees
 * an `AgentPermissions` object, and cannot accidentally reimplement the permission mapping.
 *
 * What crosses the seam is deliberately runtime-shaped rather than domain-shaped. F1.5 names the
 * runtime's control surfaces — `--allowedTools`/`--disallowedTools` patterns, permission mode,
 * hooks — as *the* enforcement mechanism for PRD §5.5, so speaking that vocabulary here is
 * following the Foundation Contract rather than leaking an SDK detail. The alternative, passing
 * an `Agent` down to `ManagedRuntime`, would put the permission→tool mapping behind whichever
 * runtime adapter happened to run, which is exactly where it must not be.
 */

/**
 * Everything a launch needs to know about the Agent it is running as — and nothing else.
 *
 * Both fields answer a question the runtime asks: what goes on the system prompt, and which
 * tools are removed. There is no room here for a field nothing applies.
 */
export interface RuntimeAgentBinding {
  readonly agentId: string;
  /** For logs and for the launch's audit trail; never sent to the model on its own. */
  readonly agentName: string;
  /**
   * The Agent's `instructions`, appended to Claude Code's own system prompt (SDK
   * `systemPrompt: { type: 'preset', preset: 'claude_code', append }`).
   *
   * **Appended, not replaced.** A bare string `systemPrompt` discards the runtime's own prompt —
   * its tool conventions, its `CLAUDE.md` handling, its output discipline — and a persona is
   * meant to steer that behaviour, not delete it.
   */
  readonly systemPromptAppend: string | null;
  /** SDK `disallowedTools`. Empty for an agent that denies nothing. */
  readonly disallowedTools: readonly string[];
  /**
   * SDK `strictMcpConfig` — ignore on-disk MCP configuration entirely. Set for any agent that
   * denies a tool, because an MCP server named in the operator's settings could otherwise supply
   * a differently-named tool that does the denied thing (`agents/permissions.ts`).
   */
  readonly strictMcpConfig: boolean;
}

/** What binding an Agent to a Session settles at bind time, rather than at launch time. */
export interface SessionAgentBinding {
  readonly agentId: string;
  /** `agents.runtime`, copied onto `sessions.runtime` so the Session records what it ran on. */
  readonly runtime: string;
}

export interface ResolveSessionAgentInput {
  readonly agentId: string;
  /** The Project the Session belongs to — a project-scoped Agent must match it. */
  readonly projectId: string;
  /**
   * The Session being bound, when it already exists (`PATCH /sessions/{id}`). `null` at create
   * time, which is what makes a `session`-scoped Agent unbindable there: it names a Session that
   * does not exist yet.
   */
  readonly sessionId: string | null;
}

/**
 * The two refusals that are about the **Session**, not the Agent — the other half of "may this
 * binding change", and the half `agents/binding.ts` deliberately cannot answer.
 *
 * `agentBindingRefusal` decides whether an *Agent* fits a Project and a Session. These two decide
 * whether the Session will accept a change at all, and neither depends on which agent is named:
 *
 *  - **`observed`** — Mission Control did not launch the process, so it could never apply a persona
 *    to it (`OPERATION_NOT_SUPPORTED`);
 *  - **`already_launched`** — the Agent's instructions become the runtime's system prompt at spawn
 *    and the runtime offers no way to replace it mid-conversation, so a later binding would be a
 *    stored value that contradicts what is actually running (`CONFLICT`).
 *
 * They live here, beside the port they belong to, and are consumed twice: `SessionService.update`
 * raises them, and `serializeSession` publishes the answer as `Session.agentBindingRefusal`. That
 * second consumer is the point — the rule was previously reachable only by attempting the write, so
 * the Session header had to transcribe it to know whether to render a control or a fact.
 */
export const SESSION_AGENT_REFUSALS = ['observed', 'already_launched'] as const;

export type SessionAgentRefusalReason = (typeof SESSION_AGENT_REFUSALS)[number];

export interface SessionAgentRefusal {
  readonly reason: SessionAgentRefusalReason;
  /** The rule and why it exists, in one operator-facing sentence. */
  readonly explanation: string;
  readonly code: 'OPERATION_NOT_SUPPORTED' | 'CONFLICT';
  readonly details: Record<string, unknown>;
}

/**
 * Why this Session will not accept a change to `agentId`, or `null` when it will.
 *
 * Ordered: the session **type** is checked before the state, so an observed Session that is also
 * `running` reports the fact the operator can act on (there is nothing to steer) rather than a
 * state rule that is beside the point. Same ordering, for the same reason, as the state machine's
 * `assertApplicable`.
 */
export function sessionAgentRefusal(session: {
  readonly sessionType: string;
  readonly state: string;
}): SessionAgentRefusal | null {
  if (session.sessionType === 'observed') {
    return {
      reason: 'observed',
      explanation:
        'Mission Control does not launch an observed session, so an agent cannot steer one.',
      code: 'OPERATION_NOT_SUPPORTED',
      details: { sessionType: session.sessionType, field: 'agentId' },
    };
  }

  if (session.state !== 'created') {
    return {
      reason: 'already_launched',
      explanation:
        `An agent is bound before launch: this session is '${session.state}', so its system ` +
        'prompt is already fixed.',
      code: 'CONFLICT',
      details: { state: session.state, field: 'agentId' },
    };
  }

  return null;
}

export interface SessionAgentPort {
  /**
   * Check that this Agent may be bound to this Session, and return what the binding settles.
   *
   * @throws {ApiError} `VALIDATION_FAILED` for an unknown Agent or a scope mismatch,
   *   `CONFLICT` for an archived one.
   */
  resolveForSession(input: ResolveSessionAgentInput): Promise<SessionAgentBinding>;
  /**
   * The runtime binding for an already-bound Agent.
   *
   * `null` only when the Agent row has vanished, which `sessions.agent_id`'s `ON DELETE RESTRICT`
   * makes impossible — callers still handle it, because a launch that silently ran *without* the
   * agent's restrictions would be the worst possible interpretation of a missing row.
   */
  bindingFor(agentId: string): Promise<RuntimeAgentBinding | null>;
}
