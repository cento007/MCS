import type { AgentScope } from '../../lib/agents/index.js';

/**
 * What the **Agents feature** adds to the shared agent vocabulary.
 *
 * The vocabulary itself — scopes, runtimes, their labels and descriptions, and the `Agent`
 * resource shape — moved to `lib/agents/vocabulary.ts` when `features/sessions/` needed to name an
 * agent too (TDS 05 §2.1: a feature slice may not import another feature slice). It is re-exported
 * below so every existing import in this slice, and every test, keeps working.
 *
 * What stays here is the one thing that is genuinely a *Builder* decision rather than a fact about
 * the domain: which scopes this screen offers.
 */

export {
  AGENT_RUNTIMES,
  AGENT_SCOPES,
  type Agent,
  type AgentRuntime,
  type AgentScope,
  agentRuntimeLabel,
  agentScopeDescription,
  agentScopeLabel,
  isAgentRuntime,
  isAgentScope,
} from '../../lib/agents/index.js';

/**
 * The scopes the **Builder offers**, in order.
 *
 * `session` is absent, and the reason is a constraint rather than a preference: the Backend
 * requires a `sessionId` for a session-scoped agent (`assertScopeTarget` in
 * `apps/backend/src/agents/validation.ts`, and `ck_agents_scope_target` behind it), and this
 * screen has no Session picker — PRD §5.2 makes session agents temporary, created for one
 * conversation. Offering the scope here would produce a form whose only outcome is a `400`.
 *
 * An agent that *arrives* with `scope: 'session'` is still listed and still editable; scope is
 * immutable after create, so the Builder shows it as a fact and never as an editable select.
 */
export const OFFERED_AGENT_SCOPES: readonly AgentScope[] = ['global', 'project'];
