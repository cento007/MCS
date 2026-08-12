import type { EventEnvelope } from '@mc/shared/types';
import {
  MAX_CHANNELS_PER_CONNECTION,
  parseServerFrame,
  type ServerFrame,
  WS_CLOSE,
  WS_PATH,
} from './protocol.js';

/**
 * `SocketClient` — the single multiplexed WebSocket at `/api/v1/ws` (F5.6, TDS 05 §5).
 *
 * One instance per authenticated app-shell lifetime. It owns four things and nothing else:
 *
 *   1. the connection state machine (§5.1) with exponential backoff + jitter,
 *   2. refcounted channel subscriptions with a linger window (§5.2),
 *   3. application-level liveness (§5.1 heartbeat), and
 *   4. idempotent event dispatch (§5.3 / F6.3) plus the reconnect sequence.
 *
 * It deliberately knows nothing about React, TanStack Query or Zustand: every outward
 * effect is a callback the caller supplies. That is what makes the whole state machine
 * testable against a scripted in-memory socket (TDS 07 §4) with no DOM and no server.
 *
 * **There is no replay, by design (F6.3).** Anything missed during a drop is healed by
 * refetching, which is why `onReconnected` fires with the exact channel set that was just
 * re-subscribed — the caller maps those to query groups and invalidates them.
 */

// ---------------------------------------------------------------------------- transport

export interface SocketMessageEvent {
  readonly data: unknown;
}

export interface SocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

/**
 * The slice of `WebSocket` this client uses. Declared structurally so tests can drive a
 * scripted socket; the browser adapter below bridges the real DOM type, whose handler
 * signatures are not assignable to a narrower interface.
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((event: SocketMessageEvent) => void) | null;
  onclose: ((event: SocketCloseEvent) => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

function createBrowserSocket(url: string): SocketLike {
  const socket = new WebSocket(url);
  const adapter: SocketLike = {
    get readyState() {
      return socket.readyState;
    },
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  socket.onopen = () => adapter.onopen?.();
  socket.onmessage = (event) => adapter.onmessage?.({ data: event.data });
  socket.onclose = (event) => adapter.onclose?.({ code: event.code, reason: event.reason });
  socket.onerror = () => adapter.onerror?.();
  return adapter;
}

/** Same-origin WS URL for the current page. `https:` -> `wss:`; dev proxies this untouched. */
export function defaultSocketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${WS_PATH}`;
}

// -------------------------------------------------------------------------------- state

/** TDS 05 §5.1. `idle` covers both "never connected" and "explicitly disconnected". */
export type ConnectionState = 'idle' | 'connecting' | 'open' | 'backoff';

export interface SocketSnapshot {
  readonly state: ConnectionState;
  /** Consecutive failed attempts since the last successful `hello`. */
  readonly attempt: number;
  readonly connectionId: string | null;
  /** Epoch ms of the most recent `hello`. Survives a drop — it is the "last live" mark. */
  readonly lastConnectedAt: number | null;
  /** Epoch ms of the most recent inbound frame of any kind. Drives the liveness deadline. */
  readonly lastFrameAt: number | null;
  /** Epoch ms the next reconnect is scheduled for, while in `backoff`. */
  readonly nextAttemptAt: number | null;
  /** Set when the server closed with 4001. The client does not retry; §8 takes over. */
  readonly authFailed: boolean;
  /** Channels the client wants the server to hold, in registration order. */
  readonly channels: readonly string[];
}

export type EventListener = (channel: string, event: EventEnvelope) => void;

export interface SocketClientOptions {
  readonly url?: string;
  readonly socketFactory?: SocketFactory;
  readonly now?: () => number;
  /** Injected so backoff jitter is deterministic under test. */
  readonly random?: () => number;
  readonly setTimer?: (handler: () => void, ms: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
  /** §5.1 — client ping cadence. */
  readonly pingIntervalMs?: number;
  /** §5.1 — dead if no frame of any kind arrives inside this window. */
  readonly livenessTimeoutMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** §5.2 — how long a zero-refcount channel is held before unsubscribing. */
  readonly lingerMs?: number;
  readonly dedupeCapacity?: number;
  readonly ackTimeoutMs?: number;
  readonly onStateChange?: (snapshot: SocketSnapshot) => void;
  /** Fires after dedupe, for every relayed event. */
  readonly onEvent?: EventListener;
  /**
   * Fires after a *re*connect once the resubscribe frame has been sent, carrying exactly
   * the channels re-subscribed. Never fires for the first connection of a session — there
   * is no gap to heal before the first `hello`.
   */
  readonly onReconnected?: (channels: readonly string[]) => void;
  /** Close code 4001: session expired or token revoked. Route through the §8 auth path. */
  readonly onAuthFailure?: () => void;
  /** A well-formed frame refused on its merits (`ack { ok: false }`, §14.4). */
  readonly onAckError?: (id: string, error: { code: string; message: string }) => void;
  readonly onServerError?: (error: { code: string; message: string }) => void;
}

export type TimerHandle = ReturnType<typeof setTimeout>;

export const DEFAULT_PING_INTERVAL_MS = 25_000;
export const DEFAULT_LIVENESS_TIMEOUT_MS = 60_000;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_CAP_MS = 30_000;
export const DEFAULT_LINGER_MS = 5_000;
export const DEFAULT_DEDUPE_CAPACITY = 512;
export const DEFAULT_ACK_TIMEOUT_MS = 15_000;

/**
 * Equal-jitter exponential backoff (§5.1: 1 s → 30 s cap).
 *
 * Half the window is deterministic and half is random: pure exponential synchronises every
 * tab that dropped at the same moment into a thundering herd, while pure random throws away
 * the growth that keeps a long outage from generating thousands of futile upgrades.
 */
export function backoffDelayMs(
  attempt: number,
  options: { base?: number; cap?: number; random?: () => number } = {},
): number {
  const base = options.base ?? DEFAULT_BACKOFF_BASE_MS;
  const cap = options.cap ?? DEFAULT_BACKOFF_CAP_MS;
  const random = options.random ?? Math.random;
  const target = Math.min(cap, base * 2 ** Math.max(0, attempt));
  return Math.round(target / 2 + random() * (target / 2));
}

interface ChannelEntry {
  refs: number;
  /** True once a `subscribe` frame has been sent on the current connection. */
  sent: boolean;
  lingerTimer: TimerHandle | null;
  handlers: Set<EventListener>;
}

interface PendingAck {
  readonly resolve: (frame: { messageId?: string; channels?: readonly string[] }) => void;
  readonly reject: (error: Error) => void;
  readonly timer: TimerHandle;
}

/** `ack { ok: false }` — a semantic refusal, not a protocol violation (§14.4). */
export class SocketAckError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SocketAckError';
    this.code = code;
  }
}

export class SocketClient {
  readonly #options: Required<
    Pick<
      SocketClientOptions,
      | 'pingIntervalMs'
      | 'livenessTimeoutMs'
      | 'backoffBaseMs'
      | 'backoffCapMs'
      | 'lingerMs'
      | 'dedupeCapacity'
      | 'ackTimeoutMs'
    >
  >;

  readonly #url: string;
  readonly #createSocket: SocketFactory;
  readonly #now: () => number;
  readonly #random: () => number;
  readonly #setTimer: (handler: () => void, ms: number) => TimerHandle;
  readonly #clearTimer: (handle: TimerHandle) => void;
  readonly #callbacks: Pick<
    SocketClientOptions,
    'onStateChange' | 'onEvent' | 'onReconnected' | 'onAuthFailure' | 'onAckError' | 'onServerError'
  >;

  #socket: SocketLike | null = null;
  #state: ConnectionState = 'idle';
  #attempt = 0;
  #connectionId: string | null = null;
  #lastConnectedAt: number | null = null;
  #lastFrameAt: number | null = null;
  #nextAttemptAt: number | null = null;
  #authFailed = false;
  /** False until the first successful `hello`; gates the reconnect refetch. */
  #hasConnected = false;
  #disposed = false;

  #backoffTimer: TimerHandle | null = null;
  #pingTimer: TimerHandle | null = null;
  #livenessTimer: TimerHandle | null = null;

  #frameSequence = 0;
  readonly #channels = new Map<string, ChannelEntry>();
  readonly #globalHandlers = new Set<EventListener>();
  readonly #pendingAcks = new Map<string, PendingAck>();
  /** Insertion-ordered LRU of seen event ids — F6.3 requires idempotent consumers. */
  readonly #seenEventIds = new Set<string>();

  constructor(options: SocketClientOptions = {}) {
    this.#options = {
      pingIntervalMs: options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      livenessTimeoutMs: options.livenessTimeoutMs ?? DEFAULT_LIVENESS_TIMEOUT_MS,
      backoffBaseMs: options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
      backoffCapMs: options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS,
      lingerMs: options.lingerMs ?? DEFAULT_LINGER_MS,
      dedupeCapacity: options.dedupeCapacity ?? DEFAULT_DEDUPE_CAPACITY,
      ackTimeoutMs: options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
    };
    this.#url =
      options.url ?? (typeof window === 'undefined' ? WS_PATH : defaultSocketUrl(window.location));
    this.#createSocket = options.socketFactory ?? createBrowserSocket;
    this.#now = options.now ?? Date.now;
    this.#random = options.random ?? Math.random;
    this.#setTimer = options.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
    this.#clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
    this.#callbacks = {
      ...(options.onStateChange === undefined ? {} : { onStateChange: options.onStateChange }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.onReconnected === undefined ? {} : { onReconnected: options.onReconnected }),
      ...(options.onAuthFailure === undefined ? {} : { onAuthFailure: options.onAuthFailure }),
      ...(options.onAckError === undefined ? {} : { onAckError: options.onAckError }),
      ...(options.onServerError === undefined ? {} : { onServerError: options.onServerError }),
    };
  }

  // ------------------------------------------------------------------------- inspection

  get snapshot(): SocketSnapshot {
    return {
      state: this.#state,
      attempt: this.#attempt,
      connectionId: this.#connectionId,
      lastConnectedAt: this.#lastConnectedAt,
      lastFrameAt: this.#lastFrameAt,
      nextAttemptAt: this.#nextAttemptAt,
      authFailed: this.#authFailed,
      channels: [...this.#channels.keys()],
    };
  }

  get state(): ConnectionState {
    return this.#state;
  }

  // -------------------------------------------------------------------------- lifecycle

  /** idle -> connecting. No-op while already connecting or open. */
  connect(): void {
    if (this.#disposed) return;
    if (this.#state === 'connecting' || this.#state === 'open') return;
    this.#authFailed = false;
    this.#openSocket();
  }

  /**
   * Explicit teardown: logout, or the app shell unmounting. Goes straight to `idle` with no
   * retry — this is the one transition that must not bounce back through `backoff`.
   */
  disconnect(code: number = WS_CLOSE.NORMAL, reason = 'client disconnect'): void {
    this.#clearBackoff();
    this.#stopHeartbeat();
    this.#failPendingAcks(new Error('Socket disconnected'));
    const socket = this.#socket;
    this.#detachSocket();
    if (socket !== null) {
      try {
        socket.close(code, reason);
      } catch {
        // A socket that throws on close is already gone; nothing to recover.
      }
    }
    for (const entry of this.#channels.values()) {
      entry.sent = false;
    }
    this.#attempt = 0;
    this.#nextAttemptAt = null;
    this.#connectionId = null;
    this.#setState('idle');
  }

  /** Operator-initiated retry from the ConnectionChip: cancel backoff and try immediately. */
  retryNow(): void {
    if (this.#disposed) return;
    this.#clearBackoff();
    this.#attempt = 0;
    this.#nextAttemptAt = null;
    if (this.#state !== 'open' && this.#state !== 'connecting') {
      this.#authFailed = false;
      this.#openSocket();
    }
  }

  /** Permanent teardown — the instance is unusable afterwards. */
  dispose(): void {
    this.disconnect();
    this.#disposed = true;
    this.#globalHandlers.clear();
    for (const entry of this.#channels.values()) {
      if (entry.lingerTimer !== null) this.#clearTimer(entry.lingerTimer);
    }
    this.#channels.clear();
    this.#seenEventIds.clear();
  }

  // ----------------------------------------------------------------------- subscriptions

  /**
   * Refcounted channel subscription (§5.2). The first subscriber sends a `subscribe` frame;
   * the last release starts a linger timer, and only when that expires is `unsubscribe`
   * sent. The linger is what stops a route transition between two views of the same Session
   * from churning a subscribe/unsubscribe pair on every navigation.
   *
   * Returns the release function. Calling it twice is safe and counts once.
   */
  subscribe(channel: string, handler?: EventListener): () => void {
    let entry = this.#channels.get(channel);
    if (entry === undefined) {
      entry = { refs: 0, sent: false, lingerTimer: null, handlers: new Set() };
      this.#channels.set(channel, entry);
    }

    if (entry.lingerTimer !== null) {
      this.#clearTimer(entry.lingerTimer);
      entry.lingerTimer = null;
    }

    entry.refs += 1;
    if (handler !== undefined) entry.handlers.add(handler);

    if (!entry.sent && this.#state === 'open') {
      this.#sendSubscribe([channel]);
      entry.sent = true;
    }
    this.#emitState();

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (handler !== undefined) entry.handlers.delete(handler);
      this.#release(channel);
    };
  }

  #release(channel: string): void {
    const entry = this.#channels.get(channel);
    if (entry === undefined) return;

    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0) return;

    if (entry.lingerTimer !== null) this.#clearTimer(entry.lingerTimer);
    entry.lingerTimer = this.#setTimer(() => {
      const current = this.#channels.get(channel);
      if (current === undefined || current.refs > 0) return;
      this.#channels.delete(channel);
      if (current.sent && this.#state === 'open') {
        this.#send({ type: 'unsubscribe', id: this.#nextFrameId('unsub'), channels: [channel] });
      }
      this.#emitState();
    }, this.#options.lingerMs);
  }

  /** A listener for every channel, e.g. the query invalidator. Returns its remover. */
  addEventListener(listener: EventListener): () => void {
    this.#globalHandlers.add(listener);
    return () => {
      this.#globalHandlers.delete(listener);
    };
  }

  // ----------------------------------------------------------------------------- sending

  /**
   * Prompt transmission (§14.4 `prompt`, ≡ `POST /sessions/{id}/prompts`). Resolves with the
   * server-assigned `messageId` on `ack { ok: true }`; rejects with a `SocketAckError` on a
   * refusal such as `SESSION_NOT_RUNNING`. Never optimistic — the caller renders the prompt
   * as visibly-pending until this settles (§6.8, §11.3).
   */
  sendPrompt(sessionId: string, content: string): Promise<{ messageId: string | null }> {
    const id = this.#nextFrameId('prompt');
    return new Promise((resolve, reject) => {
      if (this.#state !== 'open') {
        reject(new SocketAckError('NETWORK_ERROR', 'Not connected'));
        return;
      }
      const timer = this.#setTimer(() => {
        this.#pendingAcks.delete(id);
        reject(new SocketAckError('NETWORK_ERROR', 'No acknowledgement from the server'));
      }, this.#options.ackTimeoutMs);

      this.#pendingAcks.set(id, {
        resolve: (frame) => resolve({ messageId: frame.messageId ?? null }),
        reject,
        timer,
      });
      this.#send({ type: 'prompt', id, sessionId, content });
    });
  }

  // --------------------------------------------------------------------------- internals

  #openSocket(): void {
    this.#detachSocket();
    this.#setState('connecting');

    let socket: SocketLike;
    try {
      socket = this.#createSocket(this.#url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.onopen = () => {
      // Transport is up, but the connection is not trustworthy until `hello` arrives: the
      // upgrade can still be refused on Origin (§14.2) or the credential re-checked (4001).
      // Reporting `live` here would flash a green chip at a socket about to close.
      this.#touchFrame();
    };
    socket.onmessage = (event) => {
      this.#touchFrame();
      const frame = parseServerFrame(event.data);
      if (frame !== null) this.#handleFrame(frame);
    };
    socket.onerror = () => {
      // `error` is always followed by `close` in the DOM contract; the close handler owns
      // the transition so a failed connect is not counted twice.
    };
    socket.onclose = (event) => {
      this.#handleClose(event.code);
    };
  }

  #handleClose(code: number): void {
    this.#detachSocket();
    this.#stopHeartbeat();
    this.#failPendingAcks(new Error(`Socket closed (${code})`));
    this.#connectionId = null;
    for (const entry of this.#channels.values()) {
      entry.sent = false;
    }

    if (code === WS_CLOSE.AUTH_EXPIRED) {
      // §5.1: the ONE code that must not be retried. Hammering reconnects at a Backend that
      // has revoked the credential produces a login-loop, not a recovery.
      this.#authFailed = true;
      this.#attempt = 0;
      this.#nextAttemptAt = null;
      this.#setState('idle');
      this.#callbacks.onAuthFailure?.();
      return;
    }

    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#disposed) {
      this.#setState('idle');
      return;
    }
    const delay = backoffDelayMs(this.#attempt, {
      base: this.#options.backoffBaseMs,
      cap: this.#options.backoffCapMs,
      random: this.#random,
    });
    this.#attempt += 1;
    this.#nextAttemptAt = this.#now() + delay;
    this.#setState('backoff');
    this.#clearBackoff();
    this.#backoffTimer = this.#setTimer(() => {
      this.#backoffTimer = null;
      this.#nextAttemptAt = null;
      this.#openSocket();
    }, delay);
  }

  #handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'hello': {
        this.#connectionId = frame.connectionId;
        this.#lastConnectedAt = this.#now();
        this.#attempt = 0;
        this.#nextAttemptAt = null;
        this.#setState('open');
        this.#startHeartbeat();

        // §14.7 step 2 + §5.3 reconnect protocol, in this exact order: resubscribe FIRST so
        // no event produced during the refetch is missed, THEN invalidate. The reverse order
        // has a window in which the refetch has completed but the subscription has not, and
        // anything that changes inside it is lost until the next unrelated event.
        const channels = this.#resubscribeAll();
        if (this.#hasConnected) {
          this.#callbacks.onReconnected?.(channels);
        }
        this.#hasConnected = true;
        return;
      }

      case 'ack': {
        const pending = this.#pendingAcks.get(frame.id);
        if (pending !== undefined) {
          this.#pendingAcks.delete(frame.id);
          this.#clearTimer(pending.timer);
          if (frame.ok) {
            pending.resolve({
              ...(frame.messageId === undefined ? {} : { messageId: frame.messageId }),
              ...(frame.channels === undefined ? {} : { channels: frame.channels }),
            });
          } else {
            pending.reject(new SocketAckError(frame.error.code, frame.error.message));
          }
          return;
        }
        if (!frame.ok) this.#callbacks.onAckError?.(frame.id, frame.error);
        return;
      }

      case 'event':
        this.#dispatchEvent(frame.channel, frame.event);
        return;

      case 'error':
        this.#callbacks.onServerError?.(frame.error);
        return;

      case 'pong':
        // Liveness is already recorded by `#touchFrame` — any inbound frame proves the peer
        // is alive, which is why the deadline is "no frame of any kind", not "no pong".
        return;

      default:
        return;
    }
  }

  /** Idempotent per F6.3: duplicates across a reconnect boundary are expected, not a fault. */
  #dispatchEvent(channel: string, event: EventEnvelope): void {
    if (this.#seenEventIds.has(event.id)) return;
    this.#seenEventIds.add(event.id);
    if (this.#seenEventIds.size > this.#options.dedupeCapacity) {
      const oldest = this.#seenEventIds.values().next();
      if (!oldest.done) this.#seenEventIds.delete(oldest.value);
    }

    const entry = this.#channels.get(channel);
    if (entry !== undefined) {
      for (const handler of entry.handlers) handler(channel, event);
    }
    this.#callbacks.onEvent?.(channel, event);
    for (const handler of this.#globalHandlers) handler(channel, event);
  }

  /**
   * Re-send `subscribe` for every desired channel (§14.7 step 2 — the server keeps no
   * subscription state across connections). One frame, because the protocol takes an array
   * and 6 open Sessions plus the always-on channels should cost one round trip.
   */
  #resubscribeAll(): readonly string[] {
    const channels = [...this.#channels.keys()].slice(0, MAX_CHANNELS_PER_CONNECTION);
    if (channels.length === 0) return channels;
    this.#sendSubscribe(channels);
    for (const name of channels) {
      const entry = this.#channels.get(name);
      if (entry !== undefined) entry.sent = true;
    }
    return channels;
  }

  #sendSubscribe(channels: readonly string[]): void {
    this.#send({ type: 'subscribe', id: this.#nextFrameId('sub'), channels });
  }

  #send(frame: { type: string; [key: string]: unknown }): void {
    const socket = this.#socket;
    if (socket === null) return;
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A send on a socket the browser has already torn down throws; the close handler is
      // on its way and owns the transition.
    }
  }

  #nextFrameId(prefix: string): string {
    this.#frameSequence += 1;
    return `${prefix}-${this.#frameSequence}`;
  }

  // -------------------------------------------------------------------------- heartbeat

  /**
   * §5.1 liveness. The client sends an application-level `ping` every 25 s and treats the
   * connection as dead if no frame of ANY kind arrives for 60 s.
   *
   * It has to be an application-level ping: browsers do not surface protocol-level
   * ping/pong to JavaScript, so the server's 30 s protocol ping (§14.6) — which does keep
   * the *server's* view honest — is invisible here. Without this, a silently half-open
   * socket would show `live` indefinitely, which is precisely the lie §3.3 exists to
   * prevent.
   */
  #startHeartbeat(): void {
    this.#stopHeartbeat();
    this.#scheduleNextPing();
    this.#armLiveness();
  }

  /**
   * Ping scheduling is deliberately separate from liveness arming.
   *
   * Folding them together — re-arming the deadline every time we send a ping — is the bug
   * that makes a liveness check useless: the client would keep resetting its own deadline
   * from its own outbound traffic and a half-open socket would read `live` forever. Only an
   * INBOUND frame is evidence the peer is there.
   */
  #scheduleNextPing(): void {
    this.#pingTimer = this.#setTimer(() => {
      this.#pingTimer = null;
      if (this.#state !== 'open') return;
      this.#send({ type: 'ping', id: this.#nextFrameId('ping') });
      this.#scheduleNextPing();
    }, this.#options.pingIntervalMs);
  }

  #armLiveness(): void {
    if (this.#livenessTimer !== null) this.#clearTimer(this.#livenessTimer);
    this.#livenessTimer = this.#setTimer(() => {
      this.#livenessTimer = null;
      if (this.#state !== 'open' && this.#state !== 'connecting') return;
      // Force-close and go to backoff ourselves: a half-open socket may never fire `close`.
      const socket = this.#socket;
      this.#detachSocket();
      try {
        socket?.close(WS_CLOSE.NORMAL, 'liveness timeout');
      } catch {
        // Already gone.
      }
      this.#stopHeartbeat();
      for (const entry of this.#channels.values()) entry.sent = false;
      this.#connectionId = null;
      this.#scheduleReconnect();
    }, this.#options.livenessTimeoutMs);
  }

  #touchFrame(): void {
    this.#lastFrameAt = this.#now();
    if (this.#livenessTimer !== null) this.#armLiveness();
  }

  #stopHeartbeat(): void {
    if (this.#pingTimer !== null) {
      this.#clearTimer(this.#pingTimer);
      this.#pingTimer = null;
    }
    if (this.#livenessTimer !== null) {
      this.#clearTimer(this.#livenessTimer);
      this.#livenessTimer = null;
    }
  }

  // ------------------------------------------------------------------------------ misc

  #detachSocket(): void {
    const socket = this.#socket;
    if (socket === null) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    this.#socket = null;
  }

  #clearBackoff(): void {
    if (this.#backoffTimer !== null) {
      this.#clearTimer(this.#backoffTimer);
      this.#backoffTimer = null;
    }
  }

  #failPendingAcks(error: Error): void {
    for (const pending of this.#pendingAcks.values()) {
      this.#clearTimer(pending.timer);
      pending.reject(error);
    }
    this.#pendingAcks.clear();
  }

  #setState(state: ConnectionState): void {
    if (this.#state === state) {
      this.#emitState();
      return;
    }
    this.#state = state;
    this.#emitState();
  }

  #emitState(): void {
    this.#callbacks.onStateChange?.(this.snapshot);
  }
}
