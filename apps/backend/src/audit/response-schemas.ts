import {
  type Assert,
  type ExactShape,
  entityId,
  nullableEntityId,
  nullableOpenObject,
  nullableString,
  objectSchema,
  stringEnum,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { AuditLogEntryResource } from './query.js';

/**
 * The `AuditLogEntry` response shape (TDS 04 §12).
 *
 * `before`/`after` are open objects because they are stored already redacted — a secret write
 * records `{ set: true }` and never a value (TDS 03 §3.13). Closing the schema here would imply
 * the rows might contain something that still needs filtering.
 */
export const auditLogEntrySchema = objectSchema('AuditLogEntry', {
  id: entityId,
  /** `created_at` — the audit log has no separate occurrence clock. */
  occurredAt: timestampValue,
  actorType: stringEnum(['user', 'agent', 'system']),
  actorId: nullableEntityId,
  action: stringValue,
  entityType: nullableString,
  entityId: nullableEntityId,
  before: nullableOpenObject,
  after: nullableOpenObject,
  requestId: nullableString,
});
export type _AuditLogEntryShape = Assert<
  ExactShape<AuditLogEntryResource, typeof auditLogEntrySchema>
>;
