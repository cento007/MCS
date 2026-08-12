import type { EventEnvelope } from '@mc/shared/types';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createEventDispatcher, createReconnectHandler } from './dispatch.js';

/**
 * The dispatcher: one relayed envelope → client effects (TDS 05 §5.3).
 */

const SESSION_ID = '018f6b2e-1111-7abc-8def-0123456789ab';

function event(type: string, payload: Record<string, unknown> = {}): EventEnvelope {
  return {
    id: `evt-${type}`,
    type,
    schemaVersion: 1,
    occurredAt: '2026-08-11T14:03:22.000Z',
    source: 'backend',
    correlationId: null,
    payload,
  } as unknown as EventEnvelope;
}

function fakeLive() {
  return {
    applyDelta: vi.fn(),
    commitTurn: vi.fn(),
    terminateTurn: vi.fn(),
    noteActivity: vi.fn(),
  };
}

describe('createEventDispatcher', () => {
  it('routes a delta to the live buffer and NEVER to the query cache', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const live = fakeLive();
    const dispatch = createEventDispatcher({
      queryClient,
      live,
      focusedSessionId: () => SESSION_ID,
    });

    dispatch(
      `session:${SESSION_ID}`,
      event('session.message.delta_appended', {
        sessionId: SESSION_ID,
        text: 'Refactoring the',
        streamEventType: 'content_block_delta',
      }),
    );

    expect(live.applyDelta).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('commits the live buffer and invalidates messages on `session.message.appended`', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const live = fakeLive();
    const dispatch = createEventDispatcher({
      queryClient,
      live,
      focusedSessionId: () => SESSION_ID,
    });

    dispatch(
      `session:${SESSION_ID}`,
      event('session.message.appended', {
        sessionId: SESSION_ID,
        messageId: 'msg-1',
      }),
    );

    expect(live.commitTurn).toHaveBeenCalledWith(SESSION_ID, 'msg-1');
    expect(invalidate).toHaveBeenCalled();
  });

  it('counts activity only for a Session that is NOT focused', () => {
    const queryClient = new QueryClient();
    const live = fakeLive();
    const focused = createEventDispatcher({
      queryClient,
      live,
      focusedSessionId: () => SESSION_ID,
    });
    focused(`session:${SESSION_ID}`, event('session.message.appended', { sessionId: SESSION_ID }));
    expect(live.noteActivity).not.toHaveBeenCalled();

    const background = createEventDispatcher({
      queryClient,
      live,
      focusedSessionId: () => 'other',
    });
    background(
      `session:${SESSION_ID}`,
      event('session.message.appended', { sessionId: SESSION_ID }),
    );
    expect(live.noteActivity).toHaveBeenCalledWith(SESSION_ID);
  });

  it('retains and marks the partial turn on `session.failed` rather than blanking it', () => {
    const queryClient = new QueryClient();
    const live = fakeLive();
    const dispatch = createEventDispatcher({
      queryClient,
      live,
      focusedSessionId: () => SESSION_ID,
    });

    dispatch(
      `session:${SESSION_ID}`,
      event('session.failed', {
        sessionId: SESSION_ID,
        reason: 'RUNTIME_UNAVAILABLE',
      }),
    );

    // §6.2: the partial output is the most diagnostic artifact a failed session leaves.
    expect(live.terminateTurn).toHaveBeenCalledTimes(1);
    expect(live.commitTurn).not.toHaveBeenCalled();
    expect(live.terminateTurn.mock.calls[0]?.[1]).toMatchObject({
      reason: 'failed',
      errorCode: 'RUNTIME_UNAVAILABLE',
    });
  });
});

describe('createReconnectHandler', () => {
  it('invalidates every channel group plus the always-on baseline, de-duplicated', () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    const handler = createReconnectHandler(queryClient);

    handler(['sessions', `session:${SESSION_ID}`, 'sessions']);

    const invalidated = invalidate.mock.calls.map((call) =>
      JSON.stringify((call[0] as { queryKey: readonly unknown[] }).queryKey),
    );
    expect(invalidated).toContain('["sessions"]');
    expect(invalidated).toContain('["spend"]');
    expect(invalidated).toContain(`["sessions","${SESSION_ID}","messages"]`);
    expect(invalidated).toContain('["notifications"]');
    expect(invalidated).toContain('["services","health"]');
    // Duplicate channel names must not produce duplicate refetches.
    expect(invalidated.filter((key) => key === '["sessions"]')).toHaveLength(1);
  });
});
