import { describe, expect, it } from 'vitest';
import { isRateLimited, normalizeSdkMessage } from './normalize.js';

/**
 * Normalizer edge cases that no realistic fixture contains — the corpus in
 * `normalize.contract.test.ts` covers the shapes the runtime actually emits, and these cover
 * the shapes a *broken* runtime, a truncated stream or a future version might.
 *
 * The bar throughout is the same: never throw, never invent, drop what cannot be acted on.
 */

describe('normalizeSdkMessage — defensive input', () => {
  it('drops anything that is not a message object', () => {
    for (const value of [null, undefined, 42, 'a string', [], { noType: true }]) {
      expect(normalizeSdkMessage(value)).toEqual([]);
    }
  });

  it('drops a system/init without a session id — there is no spawn to confirm', () => {
    expect(
      normalizeSdkMessage({ type: 'system', subtype: 'init', model: 'x', session_id: '' }),
    ).toEqual([]);
  });

  it('drops a stream_event whose event or delta is missing', () => {
    expect(normalizeSdkMessage({ type: 'stream_event' })).toEqual([]);
    expect(
      normalizeSdkMessage({ type: 'stream_event', event: { type: 'content_block_delta' } }),
    ).toEqual([]);
    expect(
      normalizeSdkMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta' } },
      }),
    ).toEqual([]);
  });

  it('defaults a delta with no index to block 0 rather than dropping the text', () => {
    expect(
      normalizeSdkMessage({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      }),
    ).toEqual([
      {
        type: 'stream_delta',
        blockIndex: 0,
        deltaType: 'text_delta',
        text: 'hi',
        partialJson: null,
      },
    ]);
  });

  it('accepts the string content form the API allows', () => {
    const [event] = normalizeSdkMessage({ type: 'assistant', message: { content: 'plain text' } });
    expect(event).toMatchObject({
      type: 'message_completed',
      role: 'assistant',
      text: 'plain text',
    });
  });

  it('emits an assistant message even when its content is unusable', () => {
    // The turn happened; recording it with empty content is honest, dropping it is not — the
    // `result` that follows would otherwise close a turn with no message anywhere.
    const [event] = normalizeSdkMessage({ type: 'assistant', message: { content: 12345 } });
    expect(event).toMatchObject({ type: 'message_completed', role: 'assistant', text: '' });
  });

  it('drops a user message with no recognizable blocks', () => {
    // The operator's own prompt is persisted by the prompt path; an empty echo adds nothing.
    expect(normalizeSdkMessage({ type: 'user', message: { content: [] } })).toEqual([]);
  });

  it('fills result defaults rather than propagating undefined into the cost columns', () => {
    const [event] = normalizeSdkMessage({ type: 'result' });
    expect(event).toEqual({
      type: 'result',
      subtype: 'unknown',
      isError: false,
      stopReason: null,
      totalCostUsd: 0,
      usage: {},
      modelUsage: {},
      numTurns: 0,
      durationMs: 0,
      durationApiMs: 0,
      rateLimited: false,
      errors: [],
    });
  });

  it('drops a rate_limit_event whose status is not one it can act on', () => {
    expect(
      normalizeSdkMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'unknown' } }),
    ).toEqual([]);
  });

  it('classifies a non-rate-limit assistant error as a crash', () => {
    const events = normalizeSdkMessage({
      type: 'assistant',
      message: { content: [] },
      error: 'server_error',
    });
    expect(events.at(-1)).toMatchObject({ type: 'runtime_error', reason: 'crashed' });
  });
});

describe('isRateLimited (WS1 §4.3 classification)', () => {
  it('recognizes the budget result subtype', () => {
    expect(isRateLimited('error_max_budget_usd', null, [])).toBe(true);
  });

  it('recognizes rate-limit stop reasons', () => {
    expect(isRateLimited('error_during_execution', 'rate_limit', [])).toBe(true);
    expect(isRateLimited('success', 'max_budget', [])).toBe(true);
  });

  it('recognizes a rate limit reported only in the error text', () => {
    expect(isRateLimited('error_during_execution', null, ['Claude usage limit reached'])).toBe(
      true,
    );
    expect(isRateLimited('error_during_execution', null, ['quota exhausted'])).toBe(true);
  });

  it('does not mistake an ordinary failure for a rate limit', () => {
    // Getting this wrong would leave a genuinely dead turn retrying forever instead of failing.
    expect(isRateLimited('error_during_execution', 'end_turn', ['ENOENT: no such file'])).toBe(
      false,
    );
    expect(isRateLimited('success', null, [])).toBe(false);
  });
});
