import { describe, expect, it } from 'vitest';
import type { NotificationRow } from './repository.js';
import { serializeNotification } from './serialize.js';

/**
 * TDS 04 §8 shape. Two things this test pins, both of them WS7 findings:
 *
 *  - `type` is the **notification-type enum**, not an F6 event name (A8). The originating
 *    event, where one exists, rides in `payload.eventType`.
 *  - Telegram delivery is the flat `telegram: { status, sentAt, error }` object mirroring the
 *    three columns one-to-one (N5) — not a `deliveries[]` array modelling a fan-out V1 does
 *    not have.
 */

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: '0198f6b2-1111-7abc-8def-0123456789ab',
    userId: '0198f6b2-2222-7abc-8def-0123456789ab',
    type: 'session_failed',
    severity: 'error',
    title: 'Session failed',
    body: 'Fix nginx TLS renewal exited with a process crash.',
    payload: { eventType: 'session.failed', sessionId: '0198f6b2-3333-7abc-8def-0123456789ab' },
    correlationId: '0198f6b2-4444-7abc-8def-0123456789ab',
    readAt: null,
    telegramStatus: 'sent',
    telegramSentAt: new Date('2026-08-12T14:03:24.000Z'),
    telegramError: null,
    createdAt: new Date('2026-08-12T14:03:22.000Z'),
    updatedAt: new Date('2026-08-12T14:03:24.000Z'),
    ...overrides,
  } as NotificationRow;
}

describe('serializeNotification (§8)', () => {
  it('renders the contract shape with ISO 8601 UTC timestamps', () => {
    const resource = serializeNotification(row());

    expect(Object.keys(resource).sort()).toEqual([
      'body',
      'correlationId',
      'createdAt',
      'id',
      'payload',
      'readAt',
      'severity',
      'telegram',
      'title',
      'type',
    ]);
    expect(resource.createdAt).toBe('2026-08-12T14:03:22.000Z');
    expect(resource.readAt).toBeNull();
  });

  it('carries the originating F6 event in payload.eventType, never in `type` (A8)', () => {
    const resource = serializeNotification(row());

    expect(resource.type).toBe('session_failed');
    expect(resource.payload?.['eventType']).toBe('session.failed');
  });

  it('flattens Telegram delivery to the three columns (N5)', () => {
    const resource = serializeNotification(row());

    expect(resource.telegram).toEqual({
      status: 'sent',
      sentAt: '2026-08-12T14:03:24.000Z',
      error: null,
    });
  });

  it('reports a skipped delivery as skipped, with no timestamp invented', () => {
    const resource = serializeNotification(
      row({ telegramStatus: 'skipped', telegramSentAt: null, telegramError: null }),
    );

    expect(resource.telegram).toEqual({ status: 'skipped', sentAt: null, error: null });
  });

  it('carries a delivery failure reason verbatim', () => {
    const resource = serializeNotification(
      row({ telegramStatus: 'failed', telegramSentAt: null, telegramError: 'chat not found' }),
    );

    expect(resource.telegram.status).toBe('failed');
    expect(resource.telegram.error).toBe('chat not found');
  });

  it('serialises readAt once the operator has seen it', () => {
    const resource = serializeNotification(row({ readAt: new Date('2026-08-12T15:00:00.000Z') }));

    expect(resource.readAt).toBe('2026-08-12T15:00:00.000Z');
  });

  it('keeps a null payload null rather than inventing an object', () => {
    expect(serializeNotification(row({ payload: null })).payload).toBeNull();
  });
});
