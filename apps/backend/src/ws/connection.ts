import type { FastifyBaseLogger } from 'fastify';
import type { Principal } from '../auth/principal.js';
import type { ConnectionCredential } from './ports.js';
import {
  MAX_CHANNELS_PER_CONNECTION,
  MAX_PROTOCOL_VIOLATIONS,
  type ServerFrame,
  WS_CLOSE,
  type WsCloseCode,
} from './protocol.js';

/**
 * One live WebSocket connection: its subscription set, its liveness bookkeeping, and the
 * backpressure policy that decides what a slow browser is allowed to cost the server.
 *
 * The transport is behind `HubSocket` rather than used directly. That is what lets the whole
 * hub — heartbeat timeouts, slow-consumer handling, malformed-frame accounting — be unit
 * tested with no sockets, no listener and no database, which is the tier those rules have to
 * live in if they are to be checked on every commit (TDS 07 §2).
 */

export interface HubSocket {
  /** Bytes queued in the transport but not yet flushed to the peer (`ws.bufferedAmount`). */
  bufferedAmount(): number;
  isOpen(): boolean;
  send(payload: string): void;
  /** Protocol-level ping (§14.6). `ws` answers a peer's ping automatically. */
  ping(): void;
  close(code: number, reason: string): void;
  /** Drop the TCP connection now, without waiting for a close handshake. */
  terminate(): void;
}

/**
 * BACKPRESSURE POLICY (TDS 02 §4.2, F6.3) — the reasoning, because the numbers alone read
 * like arbitrary constants.
 *
 * The relay is fire-and-forget: `send()` returns as soon as the frame is queued, so a browser
 * that stops reading turns into unbounded memory growth in this process, and — if we ever
 * awaited it — into backpressure on the Agent SDK pump and the database write path. TDS 02
 * §4.2 forbids exactly that: "never stalling the pump or the DB write path".
 *
 * Two tiers, chosen because the traffic has two very different classes:
 *
 *  1. **Soft limit — drop ephemeral events.** Above `SOFT_LIMIT_BYTES` of queued data,
 *     `session.message.delta_appended` frames are discarded for that connection. Deltas are
 *     the only high-volume traffic (token-by-token streaming) and they are the only traffic
 *     that is *self-healing*: the turn ends with a durable `session.message.appended`, and
 *     WS4 §6.2's commit path renders the finished Message from the API, not from the delta
 *     stream. A dropped delta costs a moment of missing typewriter animation and nothing else,
 *     which is precisely why F6.3 marks this class ephemeral. No marker frame is sent — the
 *     recovery signal already exists in the protocol, and pushing extra bytes at a congested
 *     socket makes the congestion worse.
 *
 *  2. **Hard limit — close the connection.** If the queue still reaches `HARD_LIMIT_BYTES`
 *     with deltas already being dropped, the peer is not draining at all and the durable
 *     events now backing up are ones we cannot silently discard without lying about what the
 *     client has seen. Closing is the honest move: F6.3 gives the client exactly one recovery
 *     mechanism — reconnect and refetch (§14.7) — and closing is how we invoke it. The
 *     alternative, dropping durable events silently, leaves a client that believes it is live
 *     while its state is wrong, which is the one failure mode an operator console must not have.
 *
 * Sizes: durable payloads are ids and small scalars (F6.1), a few hundred bytes each, so
 * 1 MiB is thousands of queued events — no healthy client ever reaches it. 4 MiB is the point
 * at which one wedged tab is costing real memory.
 */
export const SOFT_LIMIT_BYTES = 1024 * 1024;
export const HARD_LIMIT_BYTES = 4 * 1024 * 1024;

export interface HubConnectionOptions {
  readonly id: string;
  readonly socket: HubSocket;
  readonly principal: Principal;
  readonly log: FastifyBaseLogger;
  readonly credential?: ConnectionCredential | undefined;
  readonly softLimitBytes?: number | undefined;
  readonly hardLimitBytes?: number | undefined;
}

export interface ConnectionStats {
  readonly sent: number;
  readonly droppedEphemeral: number;
  readonly violations: number;
  readonly subscriptions: number;
}

export class HubConnection {
  readonly id: string;
  readonly principal: Principal;
  readonly log: FastifyBaseLogger;
  readonly credential: ConnectionCredential | null;
  /** Channel names this connection is subscribed to (§14.3). Never restored across reconnects. */
  readonly subscriptions = new Set<string>();

  /** Sliding expiry captured at upgrade; refreshed by a successful revalidation. */
  credentialExpiresAt: Date | null;
  /** Ticks since a credential re-check, for token principals with no known expiry. */
  ticksSinceCredentialCheck = 0;
  /** Consecutive unanswered server pings (§14.6: closed after 2). */
  missedPongs = 0;
  /** Set once a close has been requested; the next heartbeat tick terminates the socket. */
  closing = false;

  readonly #socket: HubSocket;
  readonly #softLimitBytes: number;
  readonly #hardLimitBytes: number;

  #sent = 0;
  #droppedEphemeral = 0;
  #violations = 0;
  #dead = false;

  constructor(options: HubConnectionOptions) {
    this.id = options.id;
    this.#socket = options.socket;
    this.principal = options.principal;
    this.log = options.log;
    this.credential = options.credential ?? null;
    this.credentialExpiresAt = options.credential?.expiresAt ?? null;
    this.#softLimitBytes = options.softLimitBytes ?? SOFT_LIMIT_BYTES;
    this.#hardLimitBytes = options.hardLimitBytes ?? HARD_LIMIT_BYTES;
  }

  get stats(): ConnectionStats {
    return {
      sent: this.#sent,
      droppedEphemeral: this.#droppedEphemeral,
      violations: this.#violations,
      subscriptions: this.subscriptions.size,
    };
  }

  get isDead(): boolean {
    return this.#dead || !this.#socket.isOpen();
  }

  /**
   * Send a control frame (hello/ack/pong/error). Control frames bypass the soft limit: they
   * are single, small, and a client that never learns its subscribe failed is worse off than
   * one that gets a few hundred extra bytes.
   */
  send(frame: ServerFrame): void {
    this.#write(JSON.stringify(frame));
  }

  /**
   * Relay one already-serialised `event` frame. Returns `true` if it was queued.
   *
   * The frame is serialised once per channel by the hub and shared across every subscriber —
   * fan-out must not cost one `JSON.stringify` per socket.
   */
  deliver(payload: string, ephemeral: boolean): boolean {
    if (this.isDead || this.closing) return false;

    const buffered = this.#socket.bufferedAmount();

    if (buffered >= this.#hardLimitBytes) {
      this.log.warn(
        { connectionId: this.id, bufferedAmount: buffered, dropped: this.#droppedEphemeral },
        'websocket slow consumer exceeded hard buffer limit; closing',
      );
      this.beginClose(WS_CLOSE.SLOW_CONSUMER, 'client too slow; reconnect and refetch');
      return false;
    }

    if (ephemeral && buffered >= this.#softLimitBytes) {
      this.#droppedEphemeral += 1;
      return false;
    }

    this.#write(payload);
    return true;
  }

  /** True once the connection holds the §14.3 maximum of 64 channels. */
  wouldExceedChannelLimit(additional: number): boolean {
    return this.subscriptions.size + additional > MAX_CHANNELS_PER_CONNECTION;
  }

  /**
   * Record a protocol violation and report whether the connection has now earned a `4000`
   * close (§14.4 "repeated violations").
   */
  recordViolation(): boolean {
    this.#violations += 1;
    return this.#violations >= MAX_PROTOCOL_VIOLATIONS;
  }

  /** Any inbound traffic proves the peer is alive, not just a protocol pong. */
  markAlive(): void {
    this.missedPongs = 0;
  }

  ping(): void {
    if (this.isDead) return;
    this.missedPongs += 1;
    try {
      this.#socket.ping();
    } catch (error) {
      this.log.debug({ err: error, connectionId: this.id }, 'websocket ping failed');
      this.#dead = true;
    }
  }

  /**
   * Request a graceful close. The socket is *not* terminated here: `ws` flushes whatever is
   * queued before emitting the close frame, which is what lets a client see the reason. The
   * next heartbeat tick terminates anything still lingering (see `WebSocketHub#tick`), so a
   * wedged peer cannot hold the queue open indefinitely.
   */
  beginClose(code: WsCloseCode, reason: string): void {
    if (this.closing) return;
    this.closing = true;
    try {
      this.#socket.close(code, reason);
    } catch (error) {
      this.log.debug({ err: error, connectionId: this.id }, 'websocket close failed');
      this.terminate();
    }
  }

  terminate(): void {
    this.#dead = true;
    try {
      this.#socket.terminate();
    } catch (error) {
      this.log.debug({ err: error, connectionId: this.id }, 'websocket terminate failed');
    }
  }

  #write(payload: string): void {
    if (this.#dead) return;
    try {
      this.#socket.send(payload);
      this.#sent += 1;
    } catch (error) {
      // A send that throws means the socket went away between our check and the write. That
      // is normal on disconnect and must never propagate into the relay loop.
      this.log.debug({ err: error, connectionId: this.id }, 'websocket send failed');
      this.#dead = true;
    }
  }
}
