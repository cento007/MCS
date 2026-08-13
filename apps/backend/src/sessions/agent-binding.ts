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
