import { v7 as uuidv7 } from 'uuid';
import type { EntityId, IsoTimestamp } from '../entities/index.js';
import type { EventSource, EventType } from './types.js';

/**
 * F6.2 — the event envelope. Identical on the wire (WebSocket, TDS 04 §14.5) and in the
 * queue (pg-boss job payload, F6.3). Do not add fields without amending F6.
 *
 * Payloads carry entity IDs and small scalar discriminators only — NEVER full entities
 * (F6.1 / TDS 04 §15.1). Consumers read current state through the API or the data layer.
 */
export interface EventEnvelope<TPayload extends EventPayload = EventPayload> {
  /** UUIDv7. Also the consumer de-duplication key — delivery is at-least-once (F6.3). */
  readonly id: EntityId;
  readonly type: EventType;
  /** Bumped only when an envelope field changes, never for payload additions. */
  readonly schemaVersion: 1;
  readonly occurredAt: IsoTimestamp;
  readonly source: EventSource;
  /** Links an event chain (e.g. session -> notification). Null for chain roots. */
  readonly correlationId: EntityId | null;
  readonly payload: TPayload;
}

/** Payload shapes per event type are owned by WS2 (TDS 04 §15.2). */
export type EventPayload = Record<string, unknown>;

export const EVENT_SCHEMA_VERSION = 1 as const;

export interface CreateEventOptions {
  readonly correlationId?: EntityId | null;
  /** Override for deterministic tests; defaults to now. */
  readonly occurredAt?: Date;
  /** Override for deterministic tests; defaults to a fresh UUIDv7. */
  readonly id?: EntityId;
}

/**
 * Build an F6.2 envelope. The only supported way to construct one — hand-rolled object
 * literals drift.
 */
export function createEvent<TPayload extends EventPayload>(
  type: EventType,
  source: EventSource,
  payload: TPayload,
  options: CreateEventOptions = {},
): EventEnvelope<TPayload> {
  return Object.freeze({
    id: options.id ?? uuidv7(),
    type,
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: (options.occurredAt ?? new Date()).toISOString(),
    source,
    correlationId: options.correlationId ?? null,
    payload,
  });
}

/** Fresh UUIDv7 — the project-wide ID generator (F4.2). */
export function newId(): EntityId {
  return uuidv7();
}
