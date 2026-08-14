import { type Db, normalizeAgentPermissions } from '@mc/shared';
import { ApiError, type ErrorCode } from '../http/errors.js';
import type {
  ResolveSessionAgentInput,
  RuntimeAgentBinding,
  SessionAgentBinding,
  SessionAgentPort,
} from '../sessions/agent-binding.js';
import { disallowedToolsFor, restrictsAnything } from './permissions.js';
import { findAgentById } from './store.js';

/**
 * **Whether an Agent may be bound to a Session here, and why not — as one function.**
 *
 * `agentBindingRefusal` is to bindability what `disallowedToolsFor` is to permissions: the single
 * place the rule exists, called by the path that *enforces* it (`resolveForSession`, below, which
 * serves `POST /sessions` and `PATCH /sessions/{id}`) and by the path that *reports* it
 * (`GET /projects/{id}/available-agents`, via `teams/availability.ts`). Two implementations that
 * agree today are two implementations, and this one was already three: the SQL in
 * `listAgentsAvailableToProject` stated the positive form, the throws below stated the negative
 * form, and `apps/frontend/src/lib/agents/binding.ts` transcribed the negative form again so the
 * launch picker could explain itself. A fifth refusal added to any one of them would have left the
 * other two offering an agent the API then rejects.
 *
 * ## The refusal is text, not just a code
 *
 * Each refusal carries the sentence an operator reads. It is the *same* sentence in both
 * directions — the `400`/`409` message when a write is refused, and the explanation the picker
 * renders next to an agent it cannot offer — because those are the same fact told at two moments,
 * and a picker whose wording drifts from the error it is preventing teaches the operator to
 * distrust one of them.
 *
 * ## What is not here
 *
 * **"No such agent"** is not a refusal about an agent; it is a failed lookup, and it stays in
 * `resolveForSession` where the lookup happens. A read that lists refusals has nothing to list it
 * against.
 *
 * **The two refusals about the *Session*** — an `observed` Session cannot be steered by a persona
 * at all, and a Session past `created` has its system prompt fixed — belong to
 * `SessionService.#resolveAgentChange`. They are properties of the Session, not of the Agent, and
 * this function is never given one: it answers "may this agent be bound in this project", which is
 * exactly the question the create-time picker asks before a Session exists.
 */

/**
 * Every reason an Agent may not be bound, in the order the checks run.
 *
 * Exported as an array as well as a union so the response schema's `enum` and the type cannot
 * drift (`Covers<>` asserts it).
 */
export const AGENT_BINDING_REFUSALS = [
  'archived',
  'project_unstated',
  'other_project',
  'session_not_yet',
  'session_elsewhere',
] as const;

export type AgentBindingRefusalReason = (typeof AGENT_BINDING_REFUSALS)[number];

/**
 * The half of an `agents` row that decides bindability. Structurally satisfied by `AgentRow`, so
 * neither caller converts anything — and nothing else about an agent can influence the answer.
 */
export interface AgentBindingSubject {
  readonly id: string;
  readonly scope: string;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly archivedAt: Date | null;
}

export interface AgentBindingContext {
  /** The Project the Session belongs to. Always known: a Session cannot exist without one. */
  readonly projectId: string;
  /**
   * The Session being bound, or `null` at create time — which is what makes every session-scoped
   * agent unbindable *now* and bindable later, and why that distinction has its own reason code
   * rather than collapsing into "unavailable".
   */
  readonly sessionId: string | null;
}

export interface AgentBindingRefusal {
  readonly reason: AgentBindingRefusalReason;
  /** The rule and the way out of it, in one operator-facing sentence. */
  readonly explanation: string;
  /**
   * The F5.4 code the write path answers with. `CONFLICT` for **archived** alone: the id is
   * perfectly good and the agent plainly exists, it has been retired — which is a *state* the
   * operator can undo. Every other refusal is permanent for this pairing (scope is immutable), so
   * it is a `VALIDATION_FAILED` about the request.
   */
  readonly code: Extract<ErrorCode, 'CONFLICT' | 'VALIDATION_FAILED'>;
  /** `details` for the error envelope — the same facts, in the write path's vocabulary. */
  readonly details: Record<string, unknown>;
}

/**
 * Why this Agent cannot be bound to a Session in this Project, or `null` when it can.
 *
 * A `scope` this build does not recognise is deliberately **not** refused. The rule below checks
 * `project` and `session`; anything else — a value written by a newer build, or by hand — falls
 * through to "bindable", which is what `resolveForSession` has always done and therefore what the
 * API accepts. Refusing it here would make the picker hide an option the API takes, which is the
 * same lie as offering one it rejects, told from the other end.
 */
export function agentBindingRefusal(
  agent: AgentBindingSubject,
  context: AgentBindingContext,
): AgentBindingRefusal | null {
  if (agent.archivedAt !== null) {
    return {
      reason: 'archived',
      explanation:
        'This agent is archived and cannot be bound to a session. Un-archive it on the Agents ' +
        'screen if it should still be used.',
      code: 'CONFLICT',
      details: { field: 'agentId', agentId: agent.id },
    };
  }

  if (agent.scope === 'project') {
    // `ck_agents_scope_target` makes this unrepresentable, so it is here for the row that
    // predates the constraint or was hand-edited around it — and it gets its own sentence,
    // because "scoped to a different project" would name a project the row does not have.
    if (agent.projectId === null) {
      return {
        reason: 'project_unstated',
        explanation:
          'This agent is scoped to a project but names none, which the database does not admit ' +
          '(ck_agents_scope_target). There is nothing to match against this session’s project.',
        code: 'VALIDATION_FAILED',
        details: { field: 'agentId', scope: agent.scope, agentProjectId: null },
      };
    }

    if (agent.projectId !== context.projectId) {
      return {
        reason: 'other_project',
        explanation:
          'This agent is scoped to a different project than the session. A project agent is ' +
          'offered to its own project and nowhere else, and scope cannot be changed after an ' +
          'agent is created.',
        code: 'VALIDATION_FAILED',
        details: { field: 'agentId', scope: agent.scope, agentProjectId: agent.projectId },
      };
    }

    return null;
  }

  if (agent.scope === 'session') {
    if (context.sessionId === null) {
      return {
        reason: 'session_not_yet',
        explanation:
          'A session-scoped agent names the session it belongs to, and that session does not ' +
          'exist yet. Create the session first, then bind this agent with PATCH /sessions/{id} ' +
          'while it is still in ‹created›.',
        code: 'VALIDATION_FAILED',
        details: { field: 'agentId', scope: agent.scope, agentSessionId: agent.sessionId },
      };
    }

    if (agent.sessionId !== context.sessionId) {
      return {
        reason: 'session_elsewhere',
        explanation:
          'This agent is scoped to a different session. A session agent belongs to exactly one ' +
          'conversation (PRD §5.2).',
        code: 'VALIDATION_FAILED',
        details: { field: 'agentId', scope: agent.scope, agentSessionId: agent.sessionId },
      };
    }

    return null;
  }

  return null;
}

/**
 * `SessionAgentPort` implemented over the `agents` table — the adapter half of the seam declared
 * in `sessions/agent-binding.ts`.
 *
 * It answers two questions and holds no state:
 *
 *   **May this Agent be bound here?** — `agentBindingRefusal`, above, turned into an `ApiError`.
 *   Both halves of that rule are refusals the database cannot make on its own: `sessions.agent_id`
 *   is a plain FK, so nothing at the storage layer knows that a project-scoped Architect has no
 *   business steering a Session in another project.
 *
 *   **What does the runtime have to do about it?** — `disallowedToolsFor`, once, here. The launch
 *   path never sees an `AgentPermissions` object, so there is exactly one place where PRD §5.5
 *   becomes tool names.
 */
export class AgentBindingResolver implements SessionAgentPort {
  readonly #db: Db;

  constructor(options: { readonly db: Db }) {
    this.#db = options.db;
  }

  async resolveForSession(input: ResolveSessionAgentInput): Promise<SessionAgentBinding> {
    const agent = await findAgentById(this.#db, input.agentId);
    if (agent === null) {
      // Not a refusal about an agent — a failed lookup. See the module header.
      throw new ApiError('VALIDATION_FAILED', 'agentId does not reference a known Agent', {
        field: 'agentId',
      });
    }

    const refusal = agentBindingRefusal(agent, {
      projectId: input.projectId,
      sessionId: input.sessionId,
    });
    if (refusal !== null) {
      throw new ApiError(refusal.code, refusal.explanation, refusal.details);
    }

    return { agentId: agent.id, runtime: agent.runtime };
  }

  async bindingFor(agentId: string): Promise<RuntimeAgentBinding | null> {
    const agent = await findAgentById(this.#db, agentId);
    if (agent === null) return null;

    // Repaired, not trusted — same reasoning as the serializer: a JSONB row this build cannot
    // read must produce a *narrower* agent, and `normalizeAgentPermissions` denies everything it
    // cannot confirm.
    const permissions = normalizeAgentPermissions(agent.permissions);

    return {
      agentId: agent.id,
      agentName: agent.name,
      systemPromptAppend: agent.instructions,
      disallowedTools: disallowedToolsFor(permissions),
      strictMcpConfig: restrictsAnything(permissions),
    };
  }
}
