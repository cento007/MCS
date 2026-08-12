import { createEvent, type EventPayload, type EventType } from '@mc/shared';
import { describe, expect, it } from 'vitest';
import {
  channelsForEvent,
  parseChannel,
  SESSION_DELTA_EVENT_TYPE,
  sessionChannel,
} from './channels.js';

/**
 * The channel registry and routing table (TDS 04 §14.3, §15.2).
 *
 * These assertions are the machine-readable form of §15.2's "WS channels" column. When that
 * column changes, this file is what fails.
 */

const SESSION_ID = '018f6b2e-1111-7abc-8def-0123456789ab';
const OTHER_SESSION_ID = '018f6b2e-2222-7abc-8def-0123456789ab';

function event(type: EventType, payload: EventPayload = {}) {
  return createEvent(type, 'backend', payload);
}

describe('parseChannel', () => {
  it.each(['sessions', 'repositories', 'settings', 'audit', 'notifications', 'sync', 'adrs'])(
    'accepts the static channel %s',
    (name) => {
      expect(parseChannel(name)).toMatchObject({ kind: 'static', name });
    },
  );

  it('accepts the Phase 3/4 reserved channels so a later client is not blocked', () => {
    expect(parseChannel('memory')).toMatchObject({ kind: 'static', phase: 3 });
    expect(parseChannel('agents')).toMatchObject({ kind: 'static', phase: 4 });
  });

  it('accepts a session channel and normalises the id to lower case', () => {
    expect(parseChannel(`session:${SESSION_ID.toUpperCase()}`)).toEqual({
      kind: 'session',
      name: `session:${SESSION_ID}`,
      sessionId: SESSION_ID,
    });
  });

  it.each([
    ['an unknown name', 'everything'],
    ['a prefix-only session channel', 'session:'],
    ['a non-uuid session id', 'session:../../etc/passwd'],
    ['a session id with a wildcard', 'session:*'],
    ['a near-miss on a real channel', 'sessions:'],
    ['an empty name', ''],
  ])('rejects %s', (_label, name) => {
    expect(parseChannel(name)).toBeNull();
  });
});

describe('channelsForEvent', () => {
  it('routes session.created to the list channel only — nothing can be on session:{id} yet', () => {
    expect(channelsForEvent(event('session.created', { sessionId: SESSION_ID }))).toEqual([
      'sessions',
    ]);
  });

  it.each([
    'session.state_changed',
    'session.started',
    'session.paused',
    'session.resumed',
    'session.completed',
    'session.failed',
    'session.archived',
    'session.observation_degraded',
  ] as const)('routes %s to both the list channel and the session channel', (type) => {
    expect(channelsForEvent(event(type, { sessionId: SESSION_ID }))).toEqual([
      'sessions',
      sessionChannel(SESSION_ID),
    ]);
  });

  it('routes session.message.appended to the session channel only (§6.11.6)', () => {
    expect(channelsForEvent(event('session.message.appended', { sessionId: SESSION_ID }))).toEqual([
      sessionChannel(SESSION_ID),
    ]);
  });

  it('routes the ephemeral delta event to the session channel only', () => {
    expect(channelsForEvent(event(SESSION_DELTA_EVENT_TYPE, { sessionId: SESSION_ID }))).toEqual([
      sessionChannel(SESSION_ID),
    ]);
  });

  it('routes commit.recorded to repositories, plus the session channel when linked', () => {
    expect(channelsForEvent(event('commit.recorded', { commitId: SESSION_ID }))).toEqual([
      'repositories',
    ]);
    expect(
      channelsForEvent(
        event('commit.recorded', { commitId: SESSION_ID, sessionId: OTHER_SESSION_ID }),
      ),
    ).toEqual(['repositories', sessionChannel(OTHER_SESSION_ID)]);
  });

  it.each([
    ['repository.discovered', 'repositories'],
    ['repository.synced', 'repositories'],
    ['repository.sync_failed', 'repositories'],
    ['pull_request.opened', 'repositories'],
    ['pull_request.reviewed', 'repositories'],
    ['pull_request.merged', 'repositories'],
    ['pull_request.closed', 'repositories'],
    ['setting.updated', 'settings'],
    ['audit.entry_recorded', 'audit'],
    ['sync.started', 'sync'],
    ['sync.completed', 'sync'],
    ['sync.failed', 'sync'],
    ['sync.conflict_detected', 'sync'],
    ['adr.created', 'adrs'],
    ['adr.updated', 'adrs'],
    ['notification.created', 'notifications'],
    ['notification.sent', 'notifications'],
    ['notification.failed', 'notifications'],
  ] as const)('routes %s to %s', (type, channel) => {
    expect(channelsForEvent(event(type))).toEqual([channel]);
  });

  it('routes a session-scoped event nowhere when its payload names no session', () => {
    // Defensive, not theoretical: a producer that forgets `sessionId` must not broadcast a
    // Session event to every subscriber of every Session channel.
    expect(channelsForEvent(event('session.message.appended', {}))).toEqual([]);
  });

  it('ignores a sessionId that is not an id', () => {
    expect(channelsForEvent(event('session.message.appended', { sessionId: 'all' }))).toEqual([]);
  });

  it('routes nothing to the reserved Phase 3/4 channels', () => {
    const routed = new Set(
      (
        [
          'session.created',
          'session.completed',
          'repository.synced',
          'setting.updated',
          'audit.entry_recorded',
          'notification.sent',
          'adr.created',
          'sync.completed',
        ] as const
      ).flatMap((type) => channelsForEvent(event(type, { sessionId: SESSION_ID }))),
    );

    expect(routed.has('memory')).toBe(false);
    expect(routed.has('agents')).toBe(false);
  });
});
