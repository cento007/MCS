import { type AgentScope, type Db, normalizeAgentPermissions } from '@mc/shared';
import { ApiError } from '../http/errors.js';
import type {
  ResolveSessionAgentInput,
  RuntimeAgentBinding,
  SessionAgentBinding,
  SessionAgentPort,
} from '../sessions/agent-binding.js';
import { disallowedToolsFor, restrictsAnything } from './permissions.js';
import { findAgentById } from './store.js';

/**
 * `SessionAgentPort` implemented over the `agents` table — the adapter half of the seam declared
 * in `sessions/agent-binding.ts`.
 *
 * It answers two questions and holds no state:
 *
 *   **May this Agent be bound here?** — scope compatibility and archive status. Both are refusals
 *   the database cannot make on its own: `sessions.agent_id` is a plain FK, so nothing at the
 *   storage layer knows that a project-scoped Architect has no business steering a Session in
 *   another project.
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
      throw new ApiError('VALIDATION_FAILED', 'agentId does not reference a known Agent', {
        field: 'agentId',
      });
    }

    if (agent.archivedAt !== null) {
      // A `CONFLICT`, not a validation failure: the id is perfectly good and the agent plainly
      // exists — it has been retired, which is a state, and the operator can un-retire it.
      throw new ApiError('CONFLICT', 'This agent is archived and cannot be bound to a session', {
        field: 'agentId',
        agentId: agent.id,
      });
    }

    const scope = agent.scope as AgentScope;

    if (scope === 'project' && agent.projectId !== input.projectId) {
      throw new ApiError(
        'VALIDATION_FAILED',
        'This agent is scoped to a different project than the session',
        { field: 'agentId', scope, agentProjectId: agent.projectId },
      );
    }

    if (scope === 'session' && agent.sessionId !== input.sessionId) {
      // Includes the create-time case, where `sessionId` is null because the Session does not
      // exist yet: a session-scoped agent is bound by `PATCH /sessions/{id}` after both exist.
      throw new ApiError(
        'VALIDATION_FAILED',
        input.sessionId === null
          ? 'A session-scoped agent names the session it belongs to, which does not exist yet; ' +
              'create the session first and bind the agent with PATCH /sessions/{id}'
          : 'This agent is scoped to a different session',
        { field: 'agentId', scope, agentSessionId: agent.sessionId },
      );
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
