import type { ProjectRow } from './repository.js';

/**
 * DB row -> API resource, TDS 04 §4 field for field.
 *
 * `projects.status` is deliberately **not** serialized: the contract's Project has no `status`,
 * and `archivedAt` already carries the same fact (see the `repository.ts` header). Exposing
 * both would invite a client to trust the one the server does not filter on.
 */

export const WORKFLOW_MODES = ['manual', 'assisted'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

export interface ProjectResource {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly description: string | null;
  /**
   * `null` = **inherit** `integrations.github.workflowMode` (TDS 04 §4, arbitration A10 /
   * finding B11a). Three-valued by design: a two-valued column could not express "follow the
   * global default", so changing the global would silently not apply to existing Projects.
   * The effective mode is `project.workflowMode ?? integrations.github.workflowMode`, resolved
   * by the consumer — Phase 1 stores the override and nothing acts on it (§5.3, deviation D8).
   */
  readonly workflowMode: WorkflowMode | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export function serializeProject(row: ProjectRow): ProjectResource {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    description: row.description,
    workflowMode: asWorkflowMode(row.workflowMode),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

/**
 * Narrow the `text` column to the contract's union. A CHECK constraint already guarantees the
 * stored value, so this is a total function over a domain that cannot occur — it exists so the
 * serializer has no cast in it.
 */
export function asWorkflowMode(value: string | null): WorkflowMode | null {
  return value !== null && (WORKFLOW_MODES as readonly string[]).includes(value)
    ? (value as WorkflowMode)
    : null;
}
