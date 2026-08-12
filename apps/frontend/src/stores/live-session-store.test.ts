import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatActivityCount,
  selectLiveSession,
  setLiveFlushScheduler,
  useLiveSessionStore,
} from './live-session-store.js';

/**
 * The streaming buffer registry (TDS 05 §6.1–§6.5).
 *
 * The rule under test that is easiest to get wrong — and most expensive when it is — is the
 * §6.2 retention rule: **a partial buffer is never discarded merely because the stream
 * stopped.** The partial output is the most diagnostic artifact a failed session leaves
 * behind.
 */

const SESSION = '018f6b2e-1111-7abc-8def-0123456789ab';

beforeEach(() => {
  // Flush synchronously: the production scheduler batches to an animation frame, which is
  // right for 60 renders/s and useless for asserting on the next line.
  setLiveFlushScheduler((flush) => flush());
});

afterEach(() => {
  setLiveFlushScheduler(null);
});

function turn() {
  return selectLiveSession(useLiveSessionStore.getState(), SESSION).turn;
}

function delta(payload: Record<string, unknown>): void {
  useLiveSessionStore.getState().applyDelta({ sessionId: SESSION, ...payload });
}

describe('append and patch', () => {
  it('concatenates text deltas into one block', () => {
    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'Refactoring ' });
    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'the queue' });

    expect(turn()?.blocks).toHaveLength(1);
    expect(turn()?.blocks[0]?.text).toBe('Refactoring the queue');
    expect(turn()?.blocks[0]?.kind).toBe('text');
  });

  it('accumulates input_json_delta fragments without parsing them', () => {
    delta({ blockIndex: 1, deltaType: 'input_json_delta', partialJson: '{"pa' });
    delta({ blockIndex: 1, deltaType: 'input_json_delta', partialJson: 'th":"a"}' });

    const block = turn()?.blocks.find((candidate) => candidate.index === 1);
    expect(block?.partialJson).toBe('{"path":"a"}');
    expect(block?.kind).toBe('tool_use');
  });

  it('treats an unrecognised delta type as opaque rather than throwing', () => {
    // Forward-compatible with runtime drift, per §6.2 and F1.5's version tolerance.
    delta({ blockIndex: 0, deltaType: 'some_future_delta', text: 'x' });
    expect(turn()?.blocks[0]?.kind).toBe('unknown');
  });

  it('keeps blocks ordered by index even when they arrive out of order', () => {
    delta({ blockIndex: 2, deltaType: 'text_delta', text: 'c' });
    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'a' });
    expect(turn()?.blocks.map((block) => block.index)).toEqual([0, 2]);
  });

  it('marks a block complete on content_block_stop', () => {
    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'a' });
    delta({ blockIndex: 0, streamEventType: 'content_block_stop' });
    expect(turn()?.blocks[0]?.complete).toBe(true);
    expect(turn()?.blocks[0]?.text).toBe('a');
  });

  it('moves to awaiting_commit on message_stop', () => {
    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'a' });
    delta({ streamEventType: 'message_stop' });
    expect(turn()?.status).toBe('awaiting_commit');
  });
});

describe('commit and retention (§6.2)', () => {
  it('clears the buffer when the canonical Message for that turn arrives', () => {
    delta({ messageId: 'msg-1', blockIndex: 0, deltaType: 'text_delta', text: 'a' });
    useLiveSessionStore.getState().commitTurn(SESSION, 'msg-1');
    expect(turn()).toBeNull();
  });

  it('does NOT blank an in-flight buffer for some other Message', () => {
    delta({ messageId: 'msg-1', blockIndex: 0, deltaType: 'text_delta', text: 'a' });
    useLiveSessionStore.getState().commitTurn(SESSION, 'msg-99');
    // The store's own draft survives; a later commit for msg-1 clears it.
    delta({ messageId: 'msg-1', blockIndex: 0, deltaType: 'text_delta', text: 'b' });
    expect(turn()?.blocks[0]?.text).toBe('ab');
  });

  it('RETAINS and marks a partial turn when the session fails', () => {
    delta({ messageId: 'msg-1', blockIndex: 0, deltaType: 'text_delta', text: 'half an answer' });
    useLiveSessionStore.getState().terminateTurn(SESSION, {
      reason: 'failed',
      at: 1_700_000_000_000,
      errorCode: 'RUNTIME_UNAVAILABLE',
      requestId: '018f-req',
    });

    const retained = turn();
    expect(retained?.status).toBe('terminated');
    expect(retained?.blocks[0]?.text).toBe('half an answer');
    expect(retained?.termination).toMatchObject({
      reason: 'failed',
      errorCode: 'RUNTIME_UNAVAILABLE',
    });
  });

  it('starts a new buffer rather than resurrecting a terminated one', () => {
    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'old' });
    useLiveSessionStore
      .getState()
      .terminateTurn(SESSION, { reason: 'failed', at: 1, errorCode: null, requestId: null });

    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'new' });
    expect(turn()?.status).toBe('streaming');
    expect(turn()?.blocks[0]?.text).toBe('new');
  });
});

describe('pending prompts', () => {
  it('queues, updates and removes by clientRef, preserving submission order', () => {
    const store = useLiveSessionStore.getState();
    store.queuePrompt(SESSION, {
      clientRef: 'p1',
      content: 'first',
      status: 'queued',
      error: null,
      submittedAt: 1,
    });
    store.queuePrompt(SESSION, {
      clientRef: 'p2',
      content: 'second',
      status: 'queued',
      error: null,
      submittedAt: 2,
    });

    store.updatePrompt(SESSION, 'p1', { status: 'sending' });
    const entry = selectLiveSession(useLiveSessionStore.getState(), SESSION);
    expect(entry.pendingPrompts.map((prompt) => prompt.clientRef)).toEqual(['p1', 'p2']);
    expect(entry.pendingPrompts[0]?.status).toBe('sending');

    store.removePrompt(SESSION, 'p1');
    expect(
      selectLiveSession(useLiveSessionStore.getState(), SESSION).pendingPrompts.map(
        (p) => p.clientRef,
      ),
    ).toEqual(['p2']);
  });
});

describe('activity counters (§6.5)', () => {
  it('accrues while unfocused and clears on focus', () => {
    const store = useLiveSessionStore.getState();
    store.noteActivity(SESSION);
    store.noteActivity(SESSION);
    expect(selectLiveSession(useLiveSessionStore.getState(), SESSION).activityCount).toBe(2);
    expect(selectLiveSession(useLiveSessionStore.getState(), SESSION).unread).toBe(true);

    store.clearActivity(SESSION);
    expect(selectLiveSession(useLiveSessionStore.getState(), SESSION).activityCount).toBe(0);
    expect(selectLiveSession(useLiveSessionStore.getState(), SESSION).unread).toBe(false);
  });

  it('caps the display at 9+', () => {
    expect(formatActivityCount(0)).toBe('');
    expect(formatActivityCount(3)).toBe('3');
    expect(formatActivityCount(9)).toBe('9');
    expect(formatActivityCount(42)).toBe('9+');
  });
});

describe('bounds and teardown', () => {
  it('drops everything for a Session that is closed', () => {
    delta({ blockIndex: 0, deltaType: 'text_delta', text: 'a' });
    useLiveSessionStore.getState().noteActivity(SESSION);
    useLiveSessionStore.getState().dropSession(SESSION);

    const entry = selectLiveSession(useLiveSessionStore.getState(), SESSION);
    expect(entry.turn).toBeNull();
    expect(entry.activityCount).toBe(0);
  });

  it('returns an empty entry for an unknown Session instead of undefined', () => {
    expect(selectLiveSession(useLiveSessionStore.getState(), 'nope').turn).toBeNull();
    expect(selectLiveSession(useLiveSessionStore.getState(), null).activityCount).toBe(0);
  });
});

describe('frame batching', () => {
  it('coalesces many deltas into one store write per frame', () => {
    let scheduled = 0;
    const pending: Array<() => void> = [];
    setLiveFlushScheduler((flush) => {
      scheduled += 1;
      pending.push(flush);
    });

    for (let index = 0; index < 50; index += 1) {
      delta({ blockIndex: 0, deltaType: 'text_delta', text: 'x' });
    }
    // 50 tokens, one scheduled flush: the property that keeps a fast stream at ~60
    // renders/s instead of one render per character.
    expect(scheduled).toBe(1);
    expect(turn()).toBeNull();

    for (const flush of pending) flush();
    expect(turn()?.blocks[0]?.text).toHaveLength(50);
  });
});
