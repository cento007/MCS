import type { EventEnvelope } from '@mc/shared';
import type { ErrorCode } from '../http/errors.js';

/**
 * The wire protocol for `/api/v1/ws` — TDS 04 §14.4 (client frames), §14.5 (server frames),
 * §14.6 (heartbeat, limits, close codes). Pure data and pure functions only: nothing here
 * touches a socket, a database or the clock, so every rule below is unit-testable without a
 * transport.
 *
 * All domain traffic is an `event` frame carrying the F6.2 envelope **verbatim** (F5.6). The
 * hub never rewrites, enriches or unwraps an envelope — see `hub.ts`.
 */

/** Single multiplexed endpoint (F5.6, F1.1). */
export const WS_PATH = '/api/v1/ws';

/** Bumped only on a breaking frame change; reported in `hello`. */
export const PROTOCOL_VERSION = 1;

/**
 * Contract ceiling for a client frame (TDS 04 §14.4) — the same 256 KiB as the prompt body
 * limit in §6.4, because a `prompt` frame is transport-equivalent to that endpoint.
 */
export const MAX_CLIENT_FRAME_BYTES = 256 * 1024;

/**
 * Transport-level hard stop handed to `ws` as `maxPayload`. Deliberately ABOVE the contract
 * ceiling: at 256 KiB exactly, `ws` would tear the connection down with a 1009 before our
 * handler ever ran, and §14.4 requires an `error` frame first and a `4000` close only on
 * *repeated* violation. This value exists solely so a hostile peer cannot make us buffer an
 * unbounded frame while we are being polite about the contract one.
 */
export const TRANSPORT_MAX_PAYLOAD_BYTES = 512 * 1024;

/** TDS 04 §14.3 — 64 concurrent channel subscriptions per connection. */
export const MAX_CHANNELS_PER_CONNECTION = 64;

/** Upper bound on `channels[]` in a single subscribe/unsubscribe frame. */
export const MAX_CHANNELS_PER_FRAME = MAX_CHANNELS_PER_CONNECTION;

/** Client-chosen ack correlation id; bounded so it cannot be used as a memory amplifier. */
export const MAX_FRAME_ID_LENGTH = 128;

/**
 * How many malformed frames a connection may send before it is closed with `4000`
 * ("repeated violations", §14.4). One typo in a hand-written client should not be fatal;
 * a loop emitting garbage should be.
 */
export const MAX_PROTOCOL_VIOLATIONS = 5;

/**
 * Close codes (TDS 04 §14.6). `SLOW_CONSUMER` is an addition — see `connection.ts` for the
 * backpressure policy and the report of this contract gap. It is deliberately NOT `4001`:
 * WS4 §5.1 makes `4001` the one code a client must not retry, and a slow consumer must
 * reconnect and refetch (§14.7), not log the operator out.
 */
export const WS_CLOSE = Object.freeze({
  NORMAL: 1000,
  SERVER_SHUTDOWN: 1001,
  PROTOCOL_VIOLATION: 4000,
  AUTH_EXPIRED: 4001,
  SLOW_CONSUMER: 4002,
} as const);

export type WsCloseCode = (typeof WS_CLOSE)[keyof typeof WS_CLOSE];

// ------------------------------------------------------------------ client -> server (§14.4)

export interface SubscribeFrame {
  readonly type: 'subscribe';
  readonly id: string;
  readonly channels: readonly string[];
}

export interface UnsubscribeFrame {
  readonly type: 'unsubscribe';
  readonly id: string;
  readonly channels: readonly string[];
}

export interface PromptFrame {
  readonly type: 'prompt';
  readonly id: string;
  readonly sessionId: string;
  readonly content: string;
}

export interface PingFrame {
  readonly type: 'ping';
  readonly id?: string | undefined;
}

export type ClientFrame = SubscribeFrame | UnsubscribeFrame | PromptFrame | PingFrame;

// ------------------------------------------------------------------ server -> client (§14.5)

export interface HelloFrame {
  readonly type: 'hello';
  readonly connectionId: string;
  readonly serverTime: string;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
}

export interface AckOkFrame {
  readonly type: 'ack';
  readonly id: string;
  readonly ok: true;
  readonly channels?: readonly string[];
  readonly messageId?: string;
}

export interface AckErrorFrame {
  readonly type: 'ack';
  readonly id: string;
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string };
}

export interface EventFrame {
  readonly type: 'event';
  readonly channel: string;
  readonly event: EventEnvelope;
}

export interface PongFrame {
  readonly type: 'pong';
  readonly id?: string | undefined;
}

export interface ErrorFrame {
  readonly type: 'error';
  readonly error: { readonly code: string; readonly message: string };
}

export type ServerFrame =
  | HelloFrame
  | AckOkFrame
  | AckErrorFrame
  | EventFrame
  | PongFrame
  | ErrorFrame;

export function helloFrame(connectionId: string, serverTime: Date): HelloFrame {
  return {
    type: 'hello',
    connectionId,
    serverTime: serverTime.toISOString(),
    protocolVersion: PROTOCOL_VERSION,
  };
}

export function ackOk(
  id: string,
  extra: { channels?: readonly string[]; messageId?: string } = {},
) {
  const frame: AckOkFrame = {
    type: 'ack',
    id,
    ok: true,
    ...(extra.channels === undefined ? {} : { channels: extra.channels }),
    ...(extra.messageId === undefined ? {} : { messageId: extra.messageId }),
  };
  return frame;
}

export function ackError(id: string, code: string, message: string): AckErrorFrame {
  return { type: 'ack', id, ok: false, error: { code, message } };
}

export function errorFrame(code: string, message: string): ErrorFrame {
  return { type: 'error', error: { code, message } };
}

export function eventFrame(channel: string, event: EventEnvelope): EventFrame {
  return { type: 'event', channel, event };
}

// ------------------------------------------------------------------------------- parsing

/** Why a frame was refused. `id` is echoed into the `ack` when the frame carried a usable one. */
export interface FrameRejection {
  readonly code: ErrorCode;
  readonly message: string;
  readonly id: string | null;
}

export type ParsedFrame =
  | { readonly ok: true; readonly frame: ClientFrame }
  | { readonly ok: false; readonly rejection: FrameRejection };

function reject(code: ErrorCode, message: string, id: string | null = null): ParsedFrame {
  return { ok: false, rejection: { code, message, id } };
}

function readFrameId(source: Record<string, unknown>): string | null {
  const value = source['id'];
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FRAME_ID_LENGTH
    ? value
    : null;
}

function readChannels(source: Record<string, unknown>): readonly string[] | null {
  const value = source['channels'];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHANNELS_PER_FRAME) {
    return null;
  }
  const channels: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 256) return null;
    channels.push(entry);
  }
  return channels;
}

/**
 * Parse and validate one text frame. Never throws: a malformed frame is a client error to be
 * reported over the socket (§14.4), not an exception that could take the connection — or the
 * relay pump behind it — down.
 */
export function parseClientFrame(raw: string): ParsedFrame {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return reject('VALIDATION_FAILED', 'Frame is not valid JSON');
  }

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return reject('VALIDATION_FAILED', 'Frame must be a JSON object');
  }

  const source = decoded as Record<string, unknown>;
  const type = source['type'];
  if (typeof type !== 'string') {
    return reject('VALIDATION_FAILED', 'Frame is missing a string `type`');
  }

  const id = readFrameId(source);

  switch (type) {
    case 'ping':
      return { ok: true, frame: { type: 'ping', ...(id === null ? {} : { id }) } };

    case 'subscribe':
    case 'unsubscribe': {
      if (id === null) {
        return reject('VALIDATION_FAILED', `A ${type} frame requires a non-empty string \`id\``);
      }
      const channels = readChannels(source);
      if (channels === null) {
        return reject(
          'VALIDATION_FAILED',
          `A ${type} frame requires \`channels\`: 1–${MAX_CHANNELS_PER_FRAME} non-empty strings`,
          id,
        );
      }
      return { ok: true, frame: { type, id, channels } };
    }

    case 'prompt': {
      if (id === null) {
        return reject('VALIDATION_FAILED', 'A prompt frame requires a non-empty string `id`');
      }
      const sessionId = source['sessionId'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return reject('VALIDATION_FAILED', 'A prompt frame requires `sessionId`', id);
      }
      const content = source['content'];
      if (typeof content !== 'string' || content.length === 0) {
        return reject('VALIDATION_FAILED', 'A prompt frame requires non-empty `content`', id);
      }
      return { ok: true, frame: { type: 'prompt', id, sessionId, content } };
    }

    default:
      return reject('VALIDATION_FAILED', `Unknown frame type '${type}'`, id);
  }
}
