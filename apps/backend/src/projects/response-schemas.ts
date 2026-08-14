import {
  type Assert,
  describe,
  type ExactShape,
  entityId,
  enumSchema,
  nullable,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { ProjectResource } from './serialize.js';
import { WORKFLOW_MODES } from './serialize.js';

/** The `Project` response shape (TDS 04 §4). */
export const projectSchema = objectSchema('Project', {
  id: entityId,
  workspaceId: entityId,
  name: stringValue,
  description: nullableString,
  /**
   * `null` = **inherit** `integrations.github.workflowMode` (arbitration A10). Three-valued by
   * design: a two-valued field could not express "follow the global default".
   */
  workflowMode: describe(
    nullable(enumSchema('WorkflowMode', WORKFLOW_MODES)),
    'null means INHERIT integrations.github.workflowMode (arbitration A10), not "no mode". Three-valued by design: a two-valued field could not express "follow the global default".',
  ),
  createdAt: timestampValue,
  updatedAt: timestampValue,
  archivedAt: nullableTimestamp,
});
export type _ProjectShape = Assert<ExactShape<ProjectResource, typeof projectSchema>>;
