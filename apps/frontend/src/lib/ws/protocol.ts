import type { EventEnvelope } from '@mc/shared/types';

/**
 * The client half of the `/api/v1/ws` wire protocol (TDS 04 §14.4–§14.6).
 *
 * These declarations mirror `apps/backend/src/ws/protocol.ts` frame-for-frame. They are
 * duplicated rather than imported because `apps/backend` is an application, not a package —
 * the frontend may only depend on `@mc/shared`, and F6's *envelope* (the part that actually
 * has to agree) does come from there. This file is the single codec module TDS 05 §13.1
 * anticipated: if WS2 changes a frame shape, exactly one frontend file changes.
 */

export const WS_PATH = '/api/v1/ws';
export const PROTOCOL_VERSION = 1;

/** TDS 04 §14.3 — 64 concurrent channel subscriptions per connection. */
export const MAX_CHANNELS_PER_CONNECTION = 64;

/**
 * Close codes (TDS 04 §14.6).
 *
 * `AUTH_EXPIRED` (4001) is the one code a client must NOT retry — it routes through the §8
 * auth path instead of hammering reconnects at a Backend that has already said no. Every
 * other code, `SLOW_CONSUMER` (4002) included, reconnects with backoff and refetches; a
 * connection dropped for backpressure is not an authorisation problem and must not log the
 * operator out.
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

export type ClientFrame =
  | { readonly type: 'subscribe'; readonly id: string; readonly channels: readonly string[] }
  | { readonly type: 'unsubscribe'; readonly id: string; readonly channels: readonly string[] }
  | {
      readonly type: 'prompt';
      readonly id: string;
      readonly sessionId: string;
      readonly content: string;
    }
  | { readonly type: 'ping'; readonly id?: string };

// ------------------------------------------------------------------ server -> client (§14.5)

export interface HelloFrame {
  readonly type: 'hello';
  readonly connectionId: string;
  readonly serverTime: string;
  readonly protocolVersion: number;
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
  readonly id?: string;
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

// ------------------------------------------------------------------------------ channels

/** Static channels, TDS 04 §14.3. `memory`/`agents` are subscribable and silent by design. */
export const STATIC_CHANNELS = [
  'sessions',
  'repositories',
  'settings',
  'audit',
  'notifications',
  'sync',
  'adrs',
  'memory',
  'agents',
] as const;

export type StaticChannel = (typeof STATIC_CHANNELS)[number];

export const SESSION_CHANNEL_PREFIX = 'session:';

/** Channel name for one Session. Lower-cased to match the Backend's normalisation. */
export function sessionChannel(sessionId: string): string {
  return `${SESSION_CHANNEL_PREFIX}${sessionId.toLowerCase()}`;
}

/** The Session id inside a `session:{id}` channel, or `null` for any other channel. */
export function sessionIdOfChannel(channel: string): string | null {
  return channel.startsWith(SESSION_CHANNEL_PREFIX)
    ? channel.slice(SESSION_CHANNEL_PREFIX.length)
    : null;
}

// -------------------------------------------------------------------------------- parsing

/**
 * Decode one text frame. Never throws: a Backend that sends something unexpected must
 * degrade to "ignored frame", not to a dead socket — the connection is the operator's only
 * liveness signal and killing it over an unparseable byte would be self-defeating.
 */
export function parseServerFrame(raw: unknown): ServerFrame | null {
  if (typeof raw !== 'string') return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;

  const frame = decoded as Record<string, unknown>;
  const type = frame['type'];

  switch (type) {
    case 'hello':
      return typeof frame['connectionId'] === 'string' ? (frame as unknown as HelloFrame) : null;
    case 'ack':
      return typeof frame['id'] === 'string' && typeof frame['ok'] === 'boolean'
        ? (frame as unknown as AckOkFrame | AckErrorFrame)
        : null;
    case 'event':
      return typeof frame['channel'] === 'string' && isEventEnvelope(frame['event'])
        ? (frame as unknown as EventFrame)
        : null;
    case 'pong':
      return frame as unknown as PongFrame;
    case 'error':
      return typeof frame['error'] === 'object' && frame['error'] !== null
        ? (frame as unknown as ErrorFrame)
        : null;
    default:
      return null;
  }
}

function isEventEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    typeof envelope['id'] === 'string' &&
    typeof envelope['type'] === 'string' &&
    typeof envelope['payload'] === 'object' &&
    envelope['payload'] !== null
  );
}

/** Read a string field out of an F6 payload. Payloads carry ids and scalars only (F6.1). */
export function payloadString(event: EventEnvelope, field: string): string | null {
  const value = event.payload[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
