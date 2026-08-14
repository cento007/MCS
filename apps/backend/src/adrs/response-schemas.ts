import { ADR_STATUSES } from '@mc/shared';
import {
  type Assert,
  type ExactShape,
  entityId,
  enumSchema,
  integerValue,
  nullableEntityId,
  nullableString,
  nullableTimestamp,
  objectSchema,
  stringValue,
  timestampValue,
} from '../http/response-schema.js';
import type { AdrResource } from './serialize.js';

/** The `Adr` response shape (TDS 04 §9). */
export const adrSchema = objectSchema('Adr', {
  id: entityId,
  projectId: entityId,
  /** Per-project and user-visible ("ADR-0007") — without it a client must parse `obsidianPath`. */
  adrNumber: integerValue,
  title: stringValue,
  status: enumSchema('AdrStatus', ADR_STATUSES),
  context: stringValue,
  decision: stringValue,
  alternatives: stringValue,
  consequences: stringValue,
  sourceSessionId: nullableEntityId,
  supersededByAdrId: nullableEntityId,
  /** Vault-relative path, maintained by the Sync Worker. `null` until the note is written. */
  obsidianPath: nullableString,
  syncedAt: nullableTimestamp,
  createdAt: timestampValue,
  updatedAt: timestampValue,
});
export type _AdrShape = Assert<ExactShape<AdrResource, typeof adrSchema>>;

/**
 * `202 { data: { jobId } }` — the accepted-work shape.
 *
 * Shared by `POST /sessions/{id}/generate-adr` and `POST /repositories/{id}/sync`: both hand the
 * caller a durable job whose outcome is observable on the resource it will change.
 */
export const jobAcceptedSchema = objectSchema('JobAccepted', { jobId: stringValue });
