import { describe, expect, it } from 'vitest';
import { createEvent, type EventEnvelope } from '../events/index.js';
import {
  decodeRelayEvent,
  EVENT_RELAY_CHANNEL,
  encodeRelayEvent,
  NOTIFY_MAX_PAYLOAD_BYTES,
} from './codec.js';

/**
 * The `NOTIFY` wire codec (TDS 04 §15.1).
 *
 * Two properties carry the whole relay and both are checked as **byte equality**, not
 * deep-equality: the envelope that comes out is the envelope that went in, field for field and
 * in F6.2 order, and its `id` is untouched because every de-duplication in the system keys on it
 * (F6.3). A relay that quietly re-issued ids would look perfectly healthy right up until a
 * duplicate delivery produced a second Notification.
 */

const ID = '018f6b30-4c2a-7d31-9e44-2f1a09b7c001';
const CORRELATION_ID = '018f6b2e-1111-7abc-8def-0123456789ab';

function syncCompleted(payload: Record<string, unknown> = {}): EventEnvelope {
  return createEvent(
    'sync.completed',
    'sync-worker',
    { syncRunId: CORRELATION_ID, notesExported: 3, notesImported: 1, conflicts: 0, ...payload },
    { id: ID, correlationId: CORRELATION_ID, occurredAt: new Date('2026-08-13T10:00:00.000Z') },
  );
}

describe('the channel constant', () => {
  it('is a bare lowercase identifier, so `LISTEN` never needs quoting or interpolation', () => {
    expect(EVENT_RELAY_CHANNEL).toMatch(/^[a-z_][a-z0-9_]*$/);
  });
});

describe('round trip', () => {
  it('returns a byte-identical envelope', () => {
    const original = syncCompleted();
    const encoded = encodeRelayEvent(original);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const decoded = decodeRelayEvent(encoded.payload);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    // Byte equality, not `toEqual`: field order is part of "the envelope arrives intact".
    expect(JSON.stringify(decoded.event)).toBe(JSON.stringify(original));
  });

  it('preserves the envelope id, on which every consumer dedupes (F6.3)', () => {
    const encoded = encodeRelayEvent(syncCompleted());
    if (!encoded.ok) throw new Error('expected an encodable envelope');
    const decoded = decodeRelayEvent(encoded.payload);
    if (!decoded.ok) throw new Error('expected a decodable payload');

    expect(decoded.event.id).toBe(ID);
    expect(decoded.event.correlationId).toBe(CORRELATION_ID);
  });

  it('canonicalises field order even when the producer built the envelope by hand', () => {
    const scrambled = {
      payload: { syncRunId: CORRELATION_ID },
      correlationId: null,
      source: 'sync-worker',
      occurredAt: '2026-08-13T10:00:00.000Z',
      schemaVersion: 1,
      type: 'sync.started',
      id: ID,
    } as unknown as EventEnvelope;

    const encoded = encodeRelayEvent(scrambled);
    if (!encoded.ok) throw new Error('expected an encodable envelope');

    expect(Object.keys(JSON.parse(encoded.payload) as object)).toEqual([
      'id',
      'type',
      'schemaVersion',
      'occurredAt',
      'source',
      'correlationId',
      'payload',
    ]);
  });
});

describe("PostgreSQL's 8000-byte NOTIFY limit", () => {
  it('refuses an oversized envelope instead of letting the server raise 22023', () => {
    const encoded = encodeRelayEvent(syncCompleted({ path: 'x'.repeat(NOTIFY_MAX_PAYLOAD_BYTES) }));

    expect(encoded).toEqual({
      ok: false,
      reason: 'oversized',
      bytes: expect.any(Number) as unknown as number,
    });
    expect(encoded.bytes).toBeGreaterThanOrEqual(NOTIFY_MAX_PAYLOAD_BYTES);
  });

  it('measures bytes, not characters — a multi-byte path must not slip past the check', () => {
    // 3 bytes per character in UTF-8, so ~2800 characters is well under any `.length` limit
    // and comfortably over the byte one. This is the exact case a naive check would pass and
    // PostgreSQL would then reject *inside the caller's transaction*.
    const encoded = encodeRelayEvent(syncCompleted({ path: '経'.repeat(2800) }));

    expect(encoded.ok).toBe(false);
    expect(encoded.bytes).toBeGreaterThan(8000);
  });

  it('accepts a realistic F6 payload with room to spare (ids and scalars only, F6.1)', () => {
    const encoded = encodeRelayEvent(syncCompleted());
    if (!encoded.ok) throw new Error('expected an encodable envelope');
    expect(encoded.bytes).toBeLessThan(500);
  });
});

describe('decoding untrusted input', () => {
  it('rejects payloads that are not JSON', () => {
    expect(decodeRelayEvent('not json')).toEqual({ ok: false, reason: 'unparsable' });
  });

  it('rejects JSON that is not an object', () => {
    expect(decodeRelayEvent('[]')).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeRelayEvent('null')).toEqual({ ok: false, reason: 'malformed' });
    expect(decodeRelayEvent('42')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an event type outside the F6 registry', () => {
    const encoded = JSON.stringify({ ...syncCompleted(), type: 'sync.exploded' });
    expect(decodeRelayEvent(encoded)).toEqual({ ok: false, reason: 'unknown_type' });
  });

  it('refuses the ephemeral delta type outright (§14.5, §15.2 row 10)', () => {
    // Hand-built, because `notifyEvent` would have thrown before this ever hit the wire. This
    // is the defence against a `pg_notify` from anywhere else with database access.
    const delta = JSON.stringify({
      id: ID,
      type: 'session.message.delta_appended',
      schemaVersion: 1,
      occurredAt: '2026-08-13T10:00:00.000Z',
      source: 'backend',
      correlationId: null,
      payload: { sessionId: CORRELATION_ID, text: 'hello' },
    });

    expect(decodeRelayEvent(delta)).toEqual({ ok: false, reason: 'ephemeral' });
  });

  it.each([
    ['a non-UUID id', { id: 'nope' }],
    ['a bumped schemaVersion', { schemaVersion: 2 }],
    ['a missing schemaVersion', { schemaVersion: undefined }],
    ['an unparsable occurredAt', { occurredAt: 'yesterday' }],
    ['a non-string occurredAt', { occurredAt: 1_760_000_000 }],
    ['a source outside EVENT_SOURCES', { source: 'frontend' }],
    ['a non-UUID correlationId', { correlationId: 'chain' }],
    ['an array payload', { payload: [] }],
    ['a null payload', { payload: null }],
  ])('rejects %s', (_label, override) => {
    const encoded = JSON.stringify({ ...syncCompleted(), ...override });
    expect(decodeRelayEvent(encoded)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts a null correlationId — chain roots are legitimate (F6.2)', () => {
    const rootEvent = createEvent(
      'notification.sent',
      'telegram-worker',
      { notificationId: CORRELATION_ID, channel: 'telegram' },
      { id: ID },
    );
    const encoded = encodeRelayEvent(rootEvent);
    if (!encoded.ok) throw new Error('expected an encodable envelope');

    const decoded = decodeRelayEvent(encoded.payload);
    if (!decoded.ok) throw new Error('expected a decodable payload');
    expect(decoded.event.correlationId).toBeNull();
  });
});
