import type { EventEnvelope } from '@mc/shared/types';
import { describe, expect, it } from 'vitest';
import {
  dedupeQueryKeys,
  queryKeysForChannel,
  queryKeysForEvent,
  reconnectBaselineKeys,
} from './invalidation.js';

/**
 * The §5.3 event table and the §14.7 reconnect refetch, asserted directly.
 *
 * These two maps are the entire reason the SPA can trust a WebSocket that offers no replay:
 * an event names what went stale, a channel names what an unknown gap might have staled.
 * Getting either wrong produces a screen that is silently out of date, which is the one
 * failure mode an operator console must not have.
 */

const SESSION_ID = '018f6b2e-1111-7abc-8def-0123456789ab';

function event(type: string, payload: Record<string, unknown> = {}): EventEnvelope {
  return {
    id: '018f6b30-4c2a-7d31-9e44-2f1a09b7c001',
    type,
    schemaVersion: 1,
    occurredAt: '2026-08-11T14:03:22.000Z',
    source: 'backend',
    correlationId: null,
    payload,
  } as unknown as EventEnvelope;
}

function keyStrings(keys: readonly (readonly unknown[])[]): string[] {
  return keys.map((key) => JSON.stringify(key));
}

describe('queryKeysForEvent', () => {
  it('invalidates the sessions list and spend for `session.created`', () => {
    expect(
      keyStrings(queryKeysForEvent(event('session.created', { sessionId: SESSION_ID }))),
    ).toEqual(['["sessions"]', '["spend"]']);
  });

  it('invalidates the specific Session AND the list for a state change', () => {
    const keys = keyStrings(
      queryKeysForEvent(event('session.state_changed', { sessionId: SESSION_ID })),
    );
    expect(keys).toContain(`["sessions","${SESSION_ID}"]`);
    expect(keys).toContain('["sessions"]');
  });

  it('adds the timeline for terminal transitions — the entry a failure diagnosis needs first', () => {
    const keys = keyStrings(queryKeysForEvent(event('session.failed', { sessionId: SESSION_ID })));
    expect(keys).toContain(`["sessions","${SESSION_ID}","timeline"]`);
  });

  it('invalidates messages for `session.message.appended`', () => {
    const keys = keyStrings(
      queryKeysForEvent(
        event('session.message.appended', { sessionId: SESSION_ID, messageId: 'm' }),
      ),
    );
    expect(keys).toContain(`["sessions","${SESSION_ID}","messages"]`);
  });

  it('invalidates NOTHING for a streaming delta', () => {
    // One REST refetch per token is the failure this rule exists to prevent (§6.2).
    expect(
      queryKeysForEvent(
        event('session.message.delta_appended', { sessionId: SESSION_ID, text: 'Refactoring the' }),
      ),
    ).toEqual([]);
  });

  it('scopes `setting.updated` to the changed category', () => {
    const keys = keyStrings(
      queryKeysForEvent(event('setting.updated', { category: 'integrations' })),
    );
    expect(keys).toContain('["settings","integrations"]');
    expect(keys).toContain('["services","health"]');
  });

  it('reaches the Session panels when a commit names a Session', () => {
    const keys = keyStrings(
      queryKeysForEvent(event('commit.recorded', { commitId: 'c', sessionId: SESSION_ID })),
    );
    expect(keys).toContain(`["sessions","${SESSION_ID}","commits"]`);
    expect(keys).toContain(`["sessions","${SESSION_ID}","files"]`);
  });

  it('ignores Phase 4 reserved events rather than guessing at their effect', () => {
    expect(queryKeysForEvent(event('agent.execution_started', {}))).toEqual([]);
  });

  it('refetches the memory INDEX STATE on a memory event, and never a cached search', () => {
    // Phase 3 graduated `memory.*` from reserved to produced. The narrow target is deliberate:
    // a search is a POST costing an embedding call plus a vector query, and `memory.item_stored`
    // fires once per indexed source — so invalidating `["memory-items"]` root would re-run the
    // operator's query a few hundred times during a backfill, while they read the first answer.
    for (const type of ['memory.item_stored', 'memory.item_deleted', 'memory.reindexed']) {
      expect(keyStrings(queryKeysForEvent(event(type, {})))).toEqual([
        '["memory-items","backfill"]',
      ]);
    }
  });

  it('degrades gracefully when a payload lacks the id it should carry', () => {
    expect(queryKeysForEvent(event('session.message.appended', {}))).toEqual([]);
    expect(keyStrings(queryKeysForEvent(event('session.state_changed', {})))).toEqual([
      '["sessions"]',
      '["spend"]',
    ]);
  });
});

describe('queryKeysForChannel (reconnect gap healing)', () => {
  it('re-reads the whole Session group for a `session:{id}` channel', () => {
    const keys = keyStrings(queryKeysForChannel(`session:${SESSION_ID}`));
    expect(keys).toEqual([
      `["sessions","${SESSION_ID}"]`,
      `["sessions","${SESSION_ID}","messages"]`,
      `["sessions","${SESSION_ID}","timeline"]`,
      `["sessions","${SESSION_ID}","commits"]`,
      `["sessions","${SESSION_ID}","files"]`,
    ]);
  });

  it('is wider than the per-event map, because the gap contents are unknown', () => {
    const perEvent = queryKeysForEvent(event('session.state_changed', { sessionId: SESSION_ID }));
    const perChannel = queryKeysForChannel(`session:${SESSION_ID}`);
    expect(perChannel.length).toBeGreaterThan(perEvent.length);
  });

  it('heals the memory gap at the index state, and leaves Phase 4 silent', () => {
    // Same narrowness as the per-event map, for the same reason: the reconnect is healing an
    // unknown gap in what is *indexed*, not re-asking a question the operator asked once.
    expect(keyStrings(queryKeysForChannel('memory'))).toEqual(['["memory-items","backfill"]']);
    expect(queryKeysForChannel('agents')).toEqual([]);
  });

  it('always refetches notifications and service health on reconnect', () => {
    expect(keyStrings(reconnectBaselineKeys())).toEqual([
      '["notifications"]',
      '["services","health"]',
    ]);
  });
});

describe('dedupeQueryKeys', () => {
  it('collapses identical keys so one reconnect issues one refetch each', () => {
    const keys = dedupeQueryKeys([
      ['sessions'],
      ['sessions'],
      ['sessions', SESSION_ID],
      ['notifications'],
    ]);
    expect(keyStrings(keys)).toEqual([
      '["sessions"]',
      `["sessions","${SESSION_ID}"]`,
      '["notifications"]',
    ]);
  });
});
