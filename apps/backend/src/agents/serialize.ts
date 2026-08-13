import {
  type AgentPermissions,
  type AgentRuntime,
  type AgentScope,
  normalizeAgentPermissions,
} from '@mc/shared';
import { disallowedToolsFor } from './permissions.js';
import type { AgentRow } from './store.js';

/**
 * `agents` row -> the `Agent` API resource (TDS 04 §13.2, structure per PRD §5.3).
 *
 * ## `disallowedTools` is derived and read-only, and that is the point
 *
 * The resource carries the exact tool list the permission document produces. It is not stored and
 * cannot be set — it is `disallowedToolsFor(permissions)`, the same call the launch path makes.
 *
 * It is here because a permission model the operator has to take on trust is a permission model
 * nobody can audit. "read: true, write: false" says what was *asked for*; `disallowedTools` says
 * what will actually happen to the runtime, in the runtime's own vocabulary, and the two cannot
 * drift because there is one function.
 */
export interface AgentResource {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly scope: AgentScope;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly runtime: AgentRuntime;
  readonly permissions: AgentPermissions;
  /** Derived from `permissions`; never accepted on a write. See the header. */
  readonly disallowedTools: readonly string[];
  readonly instructions: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeAgent(row: AgentRow): AgentResource {
  // Repaired on read rather than trusted: `permissions` is JSONB, and a row written by a future
  // (or a hand-edited) shape must degrade to a *narrower* agent, not to a crash in the mapper.
  const permissions = normalizeAgentPermissions(row.permissions);

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope as AgentScope,
    projectId: row.projectId,
    sessionId: row.sessionId,
    runtime: row.runtime as AgentRuntime,
    permissions,
    disallowedTools: disallowedToolsFor(permissions),
    instructions: row.instructions,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
