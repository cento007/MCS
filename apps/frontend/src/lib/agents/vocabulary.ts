import type { EntityId, IsoTimestamp } from '@mc/shared/types';
import {
  AGENT_RUNTIMES,
  AGENT_SCOPES,
  type AgentRuntime,
  type AgentScope,
  isAgentRuntime,
  isAgentScope,
} from '@mc/shared/types';

/**
 * The Agent vocabulary, as the SPA speaks it (PRD §5.2–§5.4, TDS 04 §13.2).
 *
 * ## Why this is in `lib/` rather than in `features/agents/`
 *
 * It started inside the Agents slice, and moved here unchanged the moment a **second** feature
 * needed to name an agent: `features/sessions/` has to offer one at launch and has to say which
 * one a Session ran as. TDS 05 §2.1 forbids cross-feature imports — a slice may only reach
 * `components/`, `lib/` and `stores/` — so the alternatives were a second copy of "what does
 * `project` scope mean" or this move. The dirty-form kit was promoted for exactly this reason
 * (`lib/forms/dirty.ts`), and two spellings of a scope label is the same failure one domain over.
 *
 * **The enums are not re-declared here.** `AGENT_SCOPES` and `AGENT_RUNTIMES` come from
 * `@mc/shared/types`, which is the module the Backend's route schemas and CHECK constraints are
 * built from (F4.1/F4.2). That is what makes every screen structurally unable to offer a scope the
 * database refuses.
 *
 * ## Two places where the Backend is narrower than PRD §5
 *
 *  - **One runtime.** PRD §5.4 lists Claude Code (primary) and Ollama (optional); `AGENT_RUNTIMES`
 *    has exactly one member, because `ManagedRuntime` drives the Claude Agent SDK for every
 *    managed Session (F1.5) and an agent recorded as `ollama` would silently run on Claude Code.
 *  - **Three permissions, not twelve.** See `permissions.ts`.
 */

export {
  AGENT_RUNTIMES,
  AGENT_SCOPES,
  type AgentRuntime,
  type AgentScope,
  isAgentRuntime,
  isAgentScope,
};

/** Scope labels, from the PRD §5.2 vocabulary. Never invent a third spelling. */
const SCOPE_LABELS: Readonly<Record<AgentScope, string>> = {
  global: 'Global',
  project: 'Project',
  session: 'Session',
};

/**
 * A scope's display label. Takes `string`, not `AgentScope`: a Backend that widens the CHECK
 * before this build ships must render its own verbatim name, not a blank cell or a wrong one.
 */
export function agentScopeLabel(scope: string): string {
  return isAgentScope(scope) ? SCOPE_LABELS[scope] : scope;
}

export function agentScopeDescription(scope: string): string {
  switch (scope) {
    case 'global':
      return 'Available to every project (PRD §5.2). The PRD’s own examples are role names: Architect, Security, QA, Documentation.';
    case 'project':
      return 'Belongs to one project and is offered nowhere else.';
    case 'session':
      return 'Temporary — PRD §5.2 scopes these to a single conversation. This screen does not create them.';
    default:
      return 'This Backend uses a scope this build does not recognise. It is shown exactly as served and never rewritten.';
  }
}

const RUNTIME_LABELS: Readonly<Record<AgentRuntime, string>> = {
  claude_code: 'Claude Code',
};

export function agentRuntimeLabel(runtime: string): string {
  return isAgentRuntime(runtime) ? RUNTIME_LABELS[runtime] : runtime;
}

/** The `Agent` resource, mirroring `AgentResource` in the Backend's serializer. */
export interface Agent {
  readonly id: EntityId;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentScope;
  /** Non-null iff `scope === 'project'` — `ck_agents_scope_target` makes anything else unstorable. */
  readonly projectId: EntityId | null;
  /** Non-null iff `scope === 'session'`. */
  readonly sessionId: EntityId | null;
  readonly runtime: AgentRuntime;
  readonly permissions: unknown;
  /**
   * Derived from `permissions` by the Backend and **never accepted on a write** — the exact
   * `--disallowedTools` list a Session running as this agent gets. It is the evidence that the
   * permission switches are enforced, in the runtime's own vocabulary, and it is why the Agents
   * screen can say "enforced" about anything at all.
   */
  readonly disallowedTools: readonly string[];
  readonly instructions: string | null;
  /** Retirement is archival; there is no `DELETE /agents/{id}` and nothing here offers one. */
  readonly archivedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
