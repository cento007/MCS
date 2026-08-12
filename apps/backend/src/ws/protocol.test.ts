import { describe, expect, it } from 'vitest';
import {
  MAX_CHANNELS_PER_FRAME,
  MAX_FRAME_ID_LENGTH,
  PROTOCOL_VERSION,
  parseClientFrame,
  WS_CLOSE,
} from './protocol.js';

/**
 * Frame parsing (TDS 04 §14.4). Every case here is a thing a client can actually put on the
 * wire, including the hostile ones: the parser is the only barrier between arbitrary bytes
 * and the relay, so "never throws" is a property, not an implementation detail.
 */

describe('parseClientFrame', () => {
  it('accepts a subscribe frame', () => {
    const parsed = parseClientFrame(
      JSON.stringify({ type: 'subscribe', id: 'c1', channels: ['sessions', 'notifications'] }),
    );

    expect(parsed).toEqual({
      ok: true,
      frame: { type: 'subscribe', id: 'c1', channels: ['sessions', 'notifications'] },
    });
  });

  it('accepts an unsubscribe frame', () => {
    const parsed = parseClientFrame(
      JSON.stringify({ type: 'unsubscribe', id: 'c2', channels: ['sessions'] }),
    );

    expect(parsed.ok).toBe(true);
  });

  it('accepts a prompt frame', () => {
    const parsed = parseClientFrame(
      JSON.stringify({ type: 'prompt', id: 'c3', sessionId: 'abc', content: 'hello' }),
    );

    expect(parsed).toEqual({
      ok: true,
      frame: { type: 'prompt', id: 'c3', sessionId: 'abc', content: 'hello' },
    });
  });

  it('accepts a ping frame with and without an id', () => {
    expect(parseClientFrame(JSON.stringify({ type: 'ping' }))).toEqual({
      ok: true,
      frame: { type: 'ping' },
    });
    expect(parseClientFrame(JSON.stringify({ type: 'ping', id: 'p1' }))).toEqual({
      ok: true,
      frame: { type: 'ping', id: 'p1' },
    });
  });

  it.each([
    ['not JSON at all', 'definitely not json'],
    ['a JSON array', '[1,2,3]'],
    ['a JSON scalar', '"subscribe"'],
    ['null', 'null'],
    ['an object with no type', '{"id":"c1"}'],
    ['a non-string type', '{"type":42}'],
    ['an unknown type', '{"type":"resume","id":"c1"}'],
    ['subscribe with no id', '{"type":"subscribe","channels":["sessions"]}'],
    ['subscribe with no channels', '{"type":"subscribe","id":"c1"}'],
    ['subscribe with empty channels', '{"type":"subscribe","id":"c1","channels":[]}'],
    ['subscribe with a non-string channel', '{"type":"subscribe","id":"c1","channels":[7]}'],
    ['prompt with no sessionId', '{"type":"prompt","id":"c1","content":"hi"}'],
    ['prompt with empty content', '{"type":"prompt","id":"c1","sessionId":"s","content":""}'],
  ])('rejects %s without throwing', (_label, raw) => {
    const parsed = parseClientFrame(raw);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection.code).toBe('VALIDATION_FAILED');
  });

  it('echoes the frame id in a rejection when the frame carried a usable one', () => {
    const parsed = parseClientFrame('{"type":"subscribe","id":"c9","channels":"sessions"}');

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.rejection.id).toBe('c9');
  });

  it('refuses an id long enough to be a memory amplifier', () => {
    const id = 'x'.repeat(MAX_FRAME_ID_LENGTH + 1);
    const parsed = parseClientFrame(JSON.stringify({ type: 'subscribe', id, channels: ['audit'] }));

    expect(parsed.ok).toBe(false);
  });

  it('refuses more channels in one frame than a connection may hold', () => {
    const channels = Array.from({ length: MAX_CHANNELS_PER_FRAME + 1 }, (_, i) => `session:${i}`);
    const parsed = parseClientFrame(JSON.stringify({ type: 'subscribe', id: 'c1', channels }));

    expect(parsed.ok).toBe(false);
  });

  it('pins the protocol constants the client contract depends on', () => {
    // WS4 §5.1 keys its non-retry behaviour off exactly one close code; the rest must not
    // collide with it, and the protocol version is what a client asserts in `hello`.
    expect(PROTOCOL_VERSION).toBe(1);
    expect(WS_CLOSE.AUTH_EXPIRED).toBe(4001);
    expect(new Set(Object.values(WS_CLOSE)).size).toBe(Object.values(WS_CLOSE).length);
  });
});
