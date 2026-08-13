import { Buffer } from 'node:buffer';
import {
  EVENT_SCHEMA_VERSION,
  EVENT_SOURCES,
  type EventEnvelope,
  type EventPayload,
  type EventSource,
  type EventType,
  isEphemeralEventType,
  isEventType,
} from '../events/index.js';

/**
 * The wire format of the worker -> Backend event relay (TDS 04 §15.1's `LISTEN/NOTIFY`
 * arm, TDS 02 §7.2).
 *
 * One F6.2 envelope, serialised to JSON, carried as a PostgreSQL `NOTIFY` payload. This file
 * owns both halves of that codec so the producer and the consumer cannot drift: a worker
 * encodes with `encodeRelayEvent`, the Backend decodes with `decodeRelayEvent`, and the round
 * trip is **byte-identical** by construction (see `canonical` below).
 *
 * ## Why this is a broadcast and not a queue
 *
 * `pgboss.job` rows are claimed with `FOR UPDATE SKIP LOCKED`: the first fetcher to lock a row
 * owns it and every other consumer sees nothing. That is the right shape for *work* and exactly
 * the wrong shape for *fan-out* — TDS 04 §15.2 lists both workers as consumers of the shared
 * `events` queue, which cannot work, and is recorded as a contract problem in
 * `apps/backend/src/notifications/produce.ts` and both workers' `worker.ts`.
 *
 * `NOTIFY` has no row and nothing to claim. PostgreSQL copies the payload into the pending
 * notification list of **every** session that has issued `LISTEN` on the channel, and delivers
 * it to all of them. There is no lock to contend for, so there is nothing to race: two Backend
 * processes both receive every envelope, and neither can steal the other's. The cost of that
 * property is the one written into the contract already — delivery is best-effort with no
 * replay (F6.3), which is exactly what the WebSocket hub promises its clients anyway.
 *
 * ## The two limits, handled here rather than discovered later
 *
 *  1. **8000 bytes.** `NOTIFY` rejects a longer payload with SQLSTATE 22023, and because the
 *     notify runs on the caller's transaction that error would roll back the *domain write*.
 *     A best-effort relay must never be able to fail a domain operation, so the size is checked
 *     client-side and an oversized envelope is refused before any SQL is issued
 *     (`notify.ts` turns that into a counted, logged no-op).
 *  2. **Not durable.** A `NOTIFY` sent while nobody is listening is discarded by the server.
 *     Nothing here can fix that; the Backend's listener handles it (see `events/relay.ts`'s
 *     gap policy) and the durable copy of the same event is already on the `events` queue.
 *
 * ## Trust
 *
 * A `NOTIFY` payload is arbitrary text from anything that can reach the database, and what it
 * becomes is a frame in an operator's browser. `decodeRelayEvent` therefore validates the whole
 * envelope — every field, the id shape, the event-type registry — and refuses ephemeral types
 * outright, rather than trusting that only our own workers ever call `pg_notify`.
 */

/**
 * The channel both sides agree on. A bare lowercase identifier so `LISTEN mc_events` needs no
 * quoting and no interpolation of anything caller-supplied.
 */
export const EVENT_RELAY_CHANNEL = 'mc_events';

/**
 * PostgreSQL's hard ceiling: "the payload string ... must be shorter than 8000 bytes". Checked
 * as a strict `<`, in **bytes** rather than characters — a vault path full of non-ASCII is
 * exactly the payload that would otherwise pass a `.length` check and fail in the server.
 */
export const NOTIFY_MAX_PAYLOAD_BYTES = 8000;

/** Any UUID shape (see the same note in `ws/channels.ts`: version is F4.2's business). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SOURCES: ReadonlySet<string> = new Set(EVENT_SOURCES);

export type RelayEncodeResult =
  | { readonly ok: true; readonly payload: string; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'oversized'; readonly bytes: number };

/** Why a received payload was refused. Each one is a counter on the relay's status. */
export type RelayRejectReason = 'unparsable' | 'malformed' | 'unknown_type' | 'ephemeral';

export type RelayDecodeResult =
  | { readonly ok: true; readonly event: EventEnvelope }
  | { readonly ok: false; readonly reason: RelayRejectReason };

/**
 * The F6.2 field order, applied on both sides.
 *
 * This is what makes "the envelope arrives intact" checkable as byte equality rather than as a
 * deep-equal that would happily accept a re-ordered or quietly-widened object. `createEvent`
 * emits these seven keys in this order; so does everything that crosses this relay.
 */
function canonical(event: {
  id: string;
  type: EventType;
  schemaVersion: 1;
  occurredAt: string;
  source: EventSource;
  correlationId: string | null;
  payload: EventPayload;
}): EventEnvelope {
  return Object.freeze({
    id: event.id,
    type: event.type,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    source: event.source,
    correlationId: event.correlationId,
    payload: event.payload,
  });
}

/**
 * Serialise one envelope for `pg_notify`.
 *
 * Returns a refusal rather than throwing when the result would exceed the server's limit: the
 * caller is inside a transaction that must still commit, and there is nothing the domain can do
 * about a payload the transport cannot carry.
 */
export function encodeRelayEvent(event: EventEnvelope): RelayEncodeResult {
  const payload = JSON.stringify(canonical(event));
  const bytes = Buffer.byteLength(payload, 'utf8');

  if (bytes >= NOTIFY_MAX_PAYLOAD_BYTES) return { ok: false, reason: 'oversized', bytes };
  return { ok: true, payload, bytes };
}

/**
 * Parse and fully validate one `NOTIFY` payload. Never throws.
 *
 * The `id` survives verbatim, and that is load-bearing: delivery is at-least-once and every
 * consumer — the relay's own de-duplication, the browser's — keys on `event.id` (F6.3). An
 * envelope that arrived with a fresh id would defeat all of them at once.
 */
export function decodeRelayEvent(payload: string): RelayDecodeResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return { ok: false, reason: 'malformed' };
  }

  const source = decoded as Record<string, unknown>;

  const type = source['type'];
  if (!isEventType(type)) return { ok: false, reason: 'unknown_type' };
  if (isEphemeralEventType(type)) {
    // TDS 04 §14.5 / §15.2 row 10. `session.message.delta_appended` is WebSocket-only and is
    // constructed by `WebSocketHub#publishSessionDelta` and nowhere else; a delta that arrived
    // over a durable, cross-process path would mean something had started persisting the
    // streaming channel. Refused here as well as at the producer so the rule holds even when
    // the `pg_notify` came from a psql prompt.
    return { ok: false, reason: 'ephemeral' };
  }

  const id = source['id'];
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return { ok: false, reason: 'malformed' };

  if (source['schemaVersion'] !== EVENT_SCHEMA_VERSION) return { ok: false, reason: 'malformed' };

  const occurredAt = source['occurredAt'];
  if (typeof occurredAt !== 'string' || Number.isNaN(Date.parse(occurredAt))) {
    return { ok: false, reason: 'malformed' };
  }

  const eventSource = source['source'];
  if (typeof eventSource !== 'string' || !SOURCES.has(eventSource)) {
    return { ok: false, reason: 'malformed' };
  }

  const correlationId = source['correlationId'];
  if (
    correlationId !== null &&
    (typeof correlationId !== 'string' || !UUID_PATTERN.test(correlationId))
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const eventPayload = source['payload'];
  if (typeof eventPayload !== 'object' || eventPayload === null || Array.isArray(eventPayload)) {
    return { ok: false, reason: 'malformed' };
  }

  return {
    ok: true,
    event: canonical({
      id,
      type,
      schemaVersion: EVENT_SCHEMA_VERSION,
      occurredAt,
      source: eventSource as EventSource,
      correlationId,
      payload: eventPayload as EventPayload,
    }),
  };
}
