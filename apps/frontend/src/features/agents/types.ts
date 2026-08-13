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
 * The Agent resource, as this client reads it (PRD §5.3, TDS 04 §13.2; the Backend's own
 * serializer is `apps/backend/src/agents/serialize.ts`).
 *
 * **The vocabulary is not re-declared here.** `AGENT_SCOPES`, `AGENT_RUNTIMES` and the permission
 * document all come from `@mc/shared/types`, which is the same module the Backend's route
 * schemas, CHECK constraints and runtime binding are built from (F4.1/F4.2). That is what makes
 * this screen structurally unable to offer a scope the database refuses or a runtime that cannot
 * be launched — the failure mode a hand-written copy of the enum would reintroduce the first time
 * either list changed.
 *
 * ## Two places where the Backend is narrower than PRD §5
 *
 * Both are deliberate on its side and are stated on screen rather than papered over:
 *
 *  - **One runtime.** PRD §5.4 lists Claude Code (primary) and Ollama (optional); `AGENT_RUNTIMES`
 *    has exactly one member, because `ManagedRuntime` drives the Claude Agent SDK for every
 *    managed Session (F1.5) and an agent recorded as `ollama` would silently run on Claude Code.
 *    So the Builder shows the runtime as a stated fact rather than as a choice between one thing.
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
   * permission switches are enforced, in the runtime's own vocabulary, and it is why this screen
   * can say "enforced" about anything at all.
   */
  readonly disallowedTools: readonly string[];
  readonly instructions: string | null;
  /** Retirement is archival; there is no `DELETE /agents/{id}` and nothing here offers one. */
  readonly archivedAt: IsoTimestamp | null;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
