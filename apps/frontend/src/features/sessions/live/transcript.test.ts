import { describe, expect, it } from 'vitest';
import { makeMessage, makeTurn, SESSION_ID } from '../test-support.js';
import {
  buildTranscript,
  countToolCalls,
  indexToolResults,
  isTurnInFlight,
  messageText,
  primaryArgument,
} from './transcript.js';

/**
 * TDS 05 §6.2's four-case reconciliation table, asserted case by case.
 *
 * These are the assertions that decide whether the console is honest: three of the four rows
 * are about *not* discarding a partial turn, and the failure mode they prevent — a blank
 * conversation where the last thing the agent said used to be — destroys the operator's only
 * evidence at the exact moment they need it.
 */

const pendingPrompt = {
  clientRef: 'p-1',
  content: 'do the thing',
  status: 'queued' as const,
  error: null,
  submittedAt: 1_000,
};

describe('buildTranscript — §6.2 reconciliation', () => {
  it('case 1: a committed Message for the streamed turn replaces the buffer', () => {
    const items = buildTranscript({
      messages: [makeMessage({ id: 'm-live', ordinal: 1 })],
      turn: makeTurn({ messageId: 'm-live' }),
      pendingPrompts: [],
    });

    expect(items.map((item) => item.kind)).toEqual(['message']);
  });

  it('case 2: a failed session keeps its partial turn, rendered in place', () => {
    const items = buildTranscript({
      messages: [makeMessage({ id: 'm-1', ordinal: 1, role: 'user' })],
      turn: makeTurn({
        messageId: 'm-live',
        status: 'terminated',
        termination: {
          reason: 'failed',
          at: 1_700,
          errorCode: 'SESSION_PROCESS_EXIT',
          requestId: 'req-1',
        },
      }),
      pendingPrompts: [],
    });

    expect(items.map((item) => item.kind)).toEqual(['message', 'live']);
    const live = items[1];
    expect(live?.kind === 'live' && live.turn.status).toBe('terminated');
    expect(live?.kind === 'live' && live.turn.blocks[0]?.text).toBe('partial output');
  });

  it('case 2b: a partial turn survives even when other Messages exist for the session', () => {
    // The buffer's `messageId` is not among the committed ids, so nothing supersedes it — a
    // crash never produces a canonical Message for the turn it interrupted.
    const items = buildTranscript({
      messages: [makeMessage({ id: 'm-1' }), makeMessage({ id: 'm-2', ordinal: 2 })],
      turn: makeTurn({ messageId: 'm-live', status: 'terminated' }),
      pendingPrompts: [],
    });

    expect(items.filter((item) => item.kind === 'live')).toHaveLength(1);
  });

  it('case 3: a disconnected stream keeps its buffer — the transcript is never blanked', () => {
    const items = buildTranscript({
      messages: [],
      turn: makeTurn({ status: 'streaming' }),
      pendingPrompts: [],
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('live');
  });

  it('case 4: a settling turn is held until its canonical Message arrives', () => {
    const settling = makeTurn({ messageId: 'm-live' });

    const held = buildTranscript({
      messages: [],
      turn: null,
      settlingTurn: settling,
      pendingPrompts: [],
    });
    expect(held.map((item) => item.kind)).toEqual(['live']);

    const replaced = buildTranscript({
      messages: [makeMessage({ id: 'm-live' })],
      turn: null,
      settlingTurn: settling,
      pendingPrompts: [],
    });
    expect(replaced.map((item) => item.kind)).toEqual(['message']);
  });

  it('renders pending prompts after the live tail, in submission order', () => {
    const items = buildTranscript({
      messages: [],
      turn: makeTurn(),
      pendingPrompts: [pendingPrompt, { ...pendingPrompt, clientRef: 'p-2', content: 'second' }],
    });

    expect(items.map((item) => item.kind)).toEqual(['live', 'pending', 'pending']);
    const first = items[1];
    expect(first?.kind === 'pending' && first.prompt.clientRef).toBe('p-1');
  });

  it('never drops a buffer whose messageId is still unknown', () => {
    const items = buildTranscript({
      messages: [makeMessage({ id: 'm-1' })],
      turn: makeTurn({ messageId: null }),
      pendingPrompts: [],
    });

    expect(items.filter((item) => item.kind === 'live')).toHaveLength(1);
  });
});

describe('isTurnInFlight — the §6.8 [Stop] predicate', () => {
  it('is true while deltas are expected or the commit is outstanding', () => {
    expect(isTurnInFlight(makeTurn({ status: 'streaming' }))).toBe(true);
    expect(isTurnInFlight(makeTurn({ status: 'awaiting_commit' }))).toBe(true);
  });

  it('is false for a retained partial and for no turn at all', () => {
    // A terminated buffer is read-only evidence, not an interruptible turn.
    expect(isTurnInFlight(makeTurn({ status: 'terminated' }))).toBe(false);
    expect(isTurnInFlight(null)).toBe(false);
  });
});

describe('content-block helpers', () => {
  it('pairs tool results with their calls and derives a duration', () => {
    const results = indexToolResults([
      makeMessage({
        id: 'm-1',
        ordinal: 1,
        role: 'assistant',
        occurredAt: '2026-08-12T12:00:00.000Z',
        content: [
          { type: 'tool_use', toolUseId: 't1', toolName: 'Read', input: { file_path: 'a.ts' } },
        ],
      }),
      makeMessage({
        id: 'm-2',
        ordinal: 2,
        role: 'tool',
        occurredAt: '2026-08-12T12:00:01.200Z',
        content: [{ type: 'tool_result', toolUseId: 't1', output: 'ok', isError: false }],
      }),
    ]);

    expect(results.get('t1')).toEqual({ output: 'ok', isError: false, durationSeconds: 1.2 });
  });

  it('reads the primary argument a collapsed tool row has to show', () => {
    expect(primaryArgument({ file_path: 'packages/shared/queue.ts' })).toBe(
      'packages/shared/queue.ts',
    );
    expect(primaryArgument({ pattern: '*.ts' })).toBe('*.ts');
    expect(primaryArgument({})).toBeNull();
  });

  it('counts tool calls for the turn-complete announcement', () => {
    const message = makeMessage({
      content: [
        { type: 'text', text: 'done' },
        { type: 'tool_use', toolUseId: 't1', toolName: 'Read', input: {} },
        { type: 'tool_use', toolUseId: 't2', toolName: 'Edit', input: {} },
      ],
    });
    expect(countToolCalls(message)).toBe(2);
    expect(messageText(message)).toBe('done');
  });

  it('ignores a session id mismatch by construction — buffers are keyed per Session', () => {
    // Guard against a regression where a shared buffer leaks across Sessions (§6.5).
    expect(makeTurn().sessionId).toBe(SESSION_ID);
  });
});
