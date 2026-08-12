import { createEvent, type EntityId, type EventEnvelope, newId } from '@mc/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Principal } from '../auth/principal.js';
import { ApiError } from '../http/errors.js';
import {
  channelsForEvent,
  isEphemeral,
  parseChannel,
  SESSION_DELTA_EVENT_TYPE,
} from './channels.js';
import { HubConnection, type HubSocket } from './connection.js';
import type { ConnectionCredential, PromptPort, SessionAccessPort } from './ports.js';
import {
  ackError,
  ackOk,
  type ClientFrame,
  errorFrame,
  eventFrame,
  helloFrame,
  MAX_CHANNELS_PER_CONNECTION,
  MAX_CLIENT_FRAME_BYTES,
  parseClientFrame,
  WS_CLOSE,
  type WsCloseCode,
} from './protocol.js';

/**
 * The WebSocket hub — TDS 02 §2: **a dumb relay**.
 *
 * It subscribes to the in-process event bus, filters per channel through `channels.ts`, and
 * forwards F6 envelopes verbatim to subscribed connections. It owns no business logic and
 * never mutates domain state: the two operations that *could* have domain effects — checking
 * whether a Session is readable and submitting a prompt — are delegated to ports
 * (`ports.ts`) implemented by the modules that own those decisions.
 *
 * Delivery is **best-effort with no replay** (F6.3, §14.7). There is deliberately no buffer of
 * missed events, no per-connection cursor and no resume token: a client that reconnects
 * re-subscribes and refetches current state over REST. Anything that looks like a replay
 * buffer being added here is a contract violation, not an optimisation — it would make the
 * hub the second source of truth for conversation history.
 *
 * Concurrency model: frames from one connection are processed strictly in order (see
 * `HubConnection#enqueue` usage below), because `subscribe` followed by `unsubscribe` for the
 * same channel must not be able to interleave across an `await`. Different connections are
 * independent.
 */

/** §14.6 — "closed after 2 missed pongs". */
export const MAX_MISSED_PONGS = 2;

/** §14.6 — server pings every 30 s. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Heartbeat ticks between credential re-checks for principals with no known expiry. */
const DEFAULT_CREDENTIAL_RECHECK_TICKS = 10;

export interface WebSocketHubOptions {
  readonly log: FastifyBaseLogger;
  readonly sessionAccess: SessionAccessPort;
  /** Absent until the session domain wires it; `prompt` frames answer OPERATION_NOT_SUPPORTED. */
  readonly prompts?: PromptPort | undefined;
  readonly now?: (() => Date) | undefined;
  readonly newConnectionId?: (() => string) | undefined;
  readonly softLimitBytes?: number | undefined;
  readonly hardLimitBytes?: number | undefined;
  readonly credentialRecheckTicks?: number | undefined;
}

export interface AcceptConnectionOptions {
  readonly socket: HubSocket;
  readonly principal: Principal;
  readonly credential?: ConnectionCredential | undefined;
  /** Request-scoped logger, so hub lines carry the upgrade's `requestId`. */
  readonly log?: FastifyBaseLogger | undefined;
}

/**
 * The payload of `session.message.delta_appended` (§14.5). Field names and the delta/stream
 * vocabulary are the runtime's own (F1.5 / spike §2), carried through unchanged so the client
 * can reconstruct a turn without the Backend inventing a parallel dialect.
 */
export interface SessionMessageDelta {
  readonly sessionId: EntityId;
  readonly messageId: EntityId;
  readonly blockIndex: number;
  readonly deltaType: 'text_delta' | 'input_json_delta' | 'thinking_delta';
  /** Text/thinking deltas. `null` for `input_json_delta`. */
  readonly text?: string | null | undefined;
  /** `input_json_delta` fragments, accumulated client-side. `null` otherwise. */
  readonly partialJson?: string | null | undefined;
  readonly streamEventType:
    | 'message_start'
    | 'content_block_start'
    | 'content_block_delta'
    | 'content_block_stop'
    | 'message_delta'
    | 'message_stop';
  /** Links the delta stream to the turn that produced it (F6.2). */
  readonly correlationId?: EntityId | null | undefined;
}

export class WebSocketHub {
  readonly #log: FastifyBaseLogger;
  readonly #sessionAccess: SessionAccessPort;
  readonly #prompts: PromptPort | null;
  readonly #now: () => Date;
  readonly #newConnectionId: () => string;
  readonly #softLimitBytes: number | undefined;
  readonly #hardLimitBytes: number | undefined;
  readonly #credentialRecheckTicks: number;

  readonly #connections = new Map<string, HubConnection>();
  /** channel name -> subscribers. The fan-out index; rebuilt from nothing on every restart. */
  readonly #channelIndex = new Map<string, Set<HubConnection>>();
  /** Per-connection frame serialisation tails (see the concurrency note above). */
  readonly #tails = new WeakMap<HubConnection, Promise<void>>();
  readonly #credentialChecks = new WeakSet<HubConnection>();

  constructor(options: WebSocketHubOptions) {
    this.#log = options.log;
    this.#sessionAccess = options.sessionAccess;
    this.#prompts = options.prompts ?? null;
    this.#now = options.now ?? (() => new Date());
    this.#newConnectionId = options.newConnectionId ?? newId;
    this.#softLimitBytes = options.softLimitBytes;
    this.#hardLimitBytes = options.hardLimitBytes;
    this.#credentialRecheckTicks =
      options.credentialRecheckTicks ?? DEFAULT_CREDENTIAL_RECHECK_TICKS;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Subscriber count for a channel — used by tests and by the operator health surface. */
  subscriberCount(channel: string): number {
    return this.#channelIndex.get(channel)?.size ?? 0;
  }

  // ------------------------------------------------------------------- connection lifecycle

  /**
   * Register an upgraded socket and send `hello` (§14.1: "on success the server completes the
   * upgrade and immediately sends `hello`").
   *
   * The connection starts with an EMPTY subscription set. §14.7 is explicit that the server
   * keeps no subscription state across connections — the client re-subscribes after every
   * reconnect, which is what makes "no replay" coherent rather than lossy.
   */
  accept(options: AcceptConnectionOptions): HubConnection {
    const connection = new HubConnection({
      id: this.#newConnectionId(),
      socket: options.socket,
      principal: options.principal,
      log: options.log ?? this.#log,
      credential: options.credential,
      softLimitBytes: this.#softLimitBytes,
      hardLimitBytes: this.#hardLimitBytes,
    });

    this.#connections.set(connection.id, connection);
    connection.send(helloFrame(connection.id, this.#now()));
    return connection;
  }

  /** Detach a closed connection from the fan-out index. Idempotent. */
  handleClose(connection: HubConnection): void {
    for (const channel of connection.subscriptions) {
      const subscribers = this.#channelIndex.get(channel);
      if (subscribers === undefined) continue;
      subscribers.delete(connection);
      if (subscribers.size === 0) this.#channelIndex.delete(channel);
    }
    connection.subscriptions.clear();
    this.#connections.delete(connection.id);
  }

  handlePong(connection: HubConnection): void {
    connection.markAlive();
  }

  // -------------------------------------------------------------------------- inbound frames

  /**
   * Handle one inbound frame. Never throws and never returns a rejected promise: a client can
   * send anything, and none of it may be able to take down the relay.
   */
  handleMessage(connection: HubConnection, data: Buffer | string, isBinary: boolean): void {
    connection.markAlive();

    if (isBinary) {
      this.#violation(connection, 'VALIDATION_FAILED', 'Binary frames are not supported');
      return;
    }

    const byteLength = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
    if (byteLength > MAX_CLIENT_FRAME_BYTES) {
      this.#violation(
        connection,
        'PAYLOAD_TOO_LARGE',
        `Frame exceeds the ${MAX_CLIENT_FRAME_BYTES}-byte limit`,
      );
      return;
    }

    const parsed = parseClientFrame(typeof data === 'string' ? data : data.toString('utf8'));
    if (!parsed.ok) {
      // §14.4: malformed frames get an `error` frame. Semantic rejections of a WELL-FORMED
      // frame get an `ack { ok: false }` instead (below), so a client can always tell "you
      // sent nonsense" from "your request was understood and refused".
      const suffix = parsed.rejection.id === null ? '' : ` (frame id ${parsed.rejection.id})`;
      this.#violation(connection, parsed.rejection.code, `${parsed.rejection.message}${suffix}`);
      return;
    }

    this.#enqueue(connection, async () => {
      await this.#dispatch(connection, parsed.frame);
    });
  }

  async #dispatch(connection: HubConnection, frame: ClientFrame): Promise<void> {
    switch (frame.type) {
      case 'ping':
        connection.send({ type: 'pong', ...(frame.id === undefined ? {} : { id: frame.id }) });
        return;
      case 'subscribe':
        await this.#handleSubscribe(connection, frame.id, frame.channels);
        return;
      case 'unsubscribe':
        this.#handleUnsubscribe(connection, frame.id, frame.channels);
        return;
      case 'prompt':
        await this.#handlePrompt(connection, frame.id, frame.sessionId, frame.content);
        return;
    }
  }

  /**
   * Subscribe is **atomic**: if any requested channel is unknown, unauthorised, or would blow
   * the 64-channel budget, nothing is applied and one `ack { ok: false }` explains why. The
   * §14.5 ack shape carries a single error, so partial success would be unreportable — the
   * client could not tell which half of its request took effect.
   */
  async #handleSubscribe(
    connection: HubConnection,
    frameId: string,
    requested: readonly string[],
  ): Promise<void> {
    const additions: { name: string; sessionId: string | null }[] = [];
    const seen = new Set<string>();

    for (const raw of requested) {
      const channel = parseChannel(raw);
      if (channel === null) {
        connection.send(
          ackError(frameId, 'VALIDATION_FAILED', `Unknown channel '${truncate(raw)}'`),
        );
        return;
      }
      if (seen.has(channel.name) || connection.subscriptions.has(channel.name)) continue;
      seen.add(channel.name);
      additions.push({
        name: channel.name,
        sessionId: channel.kind === 'session' ? channel.sessionId : null,
      });
    }

    if (connection.wouldExceedChannelLimit(additions.length)) {
      connection.send(
        ackError(
          frameId,
          'VALIDATION_FAILED',
          `A connection may hold at most ${MAX_CHANNELS_PER_CONNECTION} channel subscriptions`,
        ),
      );
      return;
    }

    for (const addition of additions) {
      if (addition.sessionId === null) continue;
      let readable = false;
      try {
        readable = await this.#sessionAccess.canRead(connection.principal, addition.sessionId);
      } catch (error) {
        connection.log.error(
          { err: error, connectionId: connection.id, channel: addition.name },
          'session access check failed',
        );
        connection.send(ackError(frameId, 'INTERNAL', 'Could not verify channel access'));
        return;
      }
      if (!readable) {
        // NOT_FOUND, not FORBIDDEN: in a single-user system (§14.3) "you may not read it" and
        // "it does not exist" are the same fact, and the code that discloses less is the one
        // that stays honest when that stops being true.
        connection.send(
          ackError(frameId, 'NOT_FOUND', `No session channel '${truncate(addition.name)}'`),
        );
        return;
      }
    }

    // The access checks above are awaited, so the socket may have gone away underneath us.
    // Registering now would put a dead connection into the fan-out index that `handleClose`
    // has already swept — a permanent leak, since nothing will sweep it a second time.
    if (connection.isDead || connection.closing) return;

    for (const addition of additions) {
      connection.subscriptions.add(addition.name);
      let subscribers = this.#channelIndex.get(addition.name);
      if (subscribers === undefined) {
        subscribers = new Set();
        this.#channelIndex.set(addition.name, subscribers);
      }
      subscribers.add(connection);
    }

    connection.send(ackOk(frameId, { channels: additions.map((addition) => addition.name) }));
  }

  #handleUnsubscribe(
    connection: HubConnection,
    frameId: string,
    requested: readonly string[],
  ): void {
    const removed: string[] = [];

    for (const raw of requested) {
      const channel = parseChannel(raw);
      if (channel === null) {
        connection.send(
          ackError(frameId, 'VALIDATION_FAILED', `Unknown channel '${truncate(raw)}'`),
        );
        return;
      }
      if (!connection.subscriptions.delete(channel.name)) continue;

      const subscribers = this.#channelIndex.get(channel.name);
      if (subscribers !== undefined) {
        subscribers.delete(connection);
        if (subscribers.size === 0) this.#channelIndex.delete(channel.name);
      }
      removed.push(channel.name);
    }

    connection.send(ackOk(frameId, { channels: removed }));
  }

  /**
   * `prompt` (§14.4) is transport-equivalent to `POST /sessions/{id}/prompts` (§6.4), so it
   * delegates to the same port rather than duplicating any of it. The hub contributes exactly
   * two things: the read-access check and the ack.
   */
  async #handlePrompt(
    connection: HubConnection,
    frameId: string,
    sessionId: string,
    content: string,
  ): Promise<void> {
    const channel = parseChannel(`session:${sessionId}`);
    if (channel === null) {
      connection.send(ackError(frameId, 'VALIDATION_FAILED', 'sessionId is not a valid id'));
      return;
    }

    if (this.#prompts === null) {
      connection.send(
        ackError(
          frameId,
          'OPERATION_NOT_SUPPORTED',
          'Prompt submission over WebSocket is not wired yet; use POST /api/v1/sessions/{id}/prompts',
        ),
      );
      return;
    }

    try {
      if (!(await this.#sessionAccess.canRead(connection.principal, sessionId))) {
        connection.send(ackError(frameId, 'NOT_FOUND', `No session with id ${sessionId}`));
        return;
      }
      const result = await this.#prompts.submit({
        principal: connection.principal,
        sessionId,
        content,
      });
      connection.send(ackOk(frameId, { messageId: result.messageId }));
    } catch (error) {
      if (error instanceof ApiError) {
        connection.send(ackError(frameId, error.code, error.message));
        return;
      }
      connection.log.error(
        { err: error, connectionId: connection.id, sessionId },
        'prompt submission failed',
      );
      connection.send(ackError(frameId, 'INTERNAL', 'Prompt submission failed'));
    }
  }

  // ------------------------------------------------------------------------- outbound relay

  /**
   * Relay one F6 envelope to every subscriber of every channel it routes to.
   *
   * The envelope crosses the wire **unchanged** (F5.6, §14.5) — no re-wrapping, no added
   * fields, no per-client view. An event type absent from the `channels.ts` routing table
   * reaches nobody.
   */
  publish(event: EventEnvelope): void {
    const channels = channelsForEvent(event);
    if (channels.length === 0) return;

    const ephemeral = isEphemeral(event);

    for (const channel of channels) {
      const subscribers = this.#channelIndex.get(channel);
      if (subscribers === undefined || subscribers.size === 0) continue;

      // Serialised once per channel, shared by every subscriber on it.
      const payload = JSON.stringify(eventFrame(channel, event));
      for (const connection of [...subscribers]) {
        connection.deliver(payload, ephemeral);
      }
    }
  }

  /**
   * THE publish path for assistant token streaming — used by the managed-session wrapper
   * (F1.5, TDS 02 §4.2).
   *
   * `session.message.delta_appended` is **ephemeral**: WebSocket-only, relayed to
   * `session:{id}` subscribers, **never enqueued to pg-boss and never persisted** (§14.5,
   * §15.2 row 10). That is not an oversight to be tidied up later — it is the reason the
   * streaming path can run at token rate without touching PostgreSQL, and the durable record
   * of the same content arrives as `session.message.appended` when the turn completes.
   *
   * Consequently this method is the ONLY constructor of that envelope in the codebase, and it
   * does not go through `events/`'s outbox helper. If you find yourself wanting to route
   * deltas through the outbox "for reliability", the design already answered that: a client
   * that missed deltas refetches the finished Message (§14.7).
   */
  publishSessionDelta(delta: SessionMessageDelta): EventEnvelope {
    const event = createEvent(
      SESSION_DELTA_EVENT_TYPE,
      'backend',
      {
        sessionId: delta.sessionId,
        messageId: delta.messageId,
        blockIndex: delta.blockIndex,
        deltaType: delta.deltaType,
        text: delta.text ?? null,
        partialJson: delta.partialJson ?? null,
        streamEventType: delta.streamEventType,
      },
      { correlationId: delta.correlationId ?? null, occurredAt: this.#now() },
    );

    this.publish(event);
    return event;
  }

  // --------------------------------------------------------------------------- maintenance

  /**
   * One heartbeat step (§14.6). Called on an interval by `registerWebSocketHub`; called
   * directly by tests, which is why the hub owns no timer of its own.
   */
  tick(now: Date = this.#now()): void {
    for (const connection of [...this.#connections.values()]) {
      if (connection.closing) {
        // A close was requested a tick ago and the peer still has not completed the
        // handshake. Stop waiting: this is the wedged-client case the close was for.
        connection.terminate();
        this.handleClose(connection);
        continue;
      }

      if (connection.isDead) {
        this.handleClose(connection);
        continue;
      }

      if (connection.missedPongs >= MAX_MISSED_PONGS) {
        connection.log.info(
          { connectionId: connection.id, missedPongs: connection.missedPongs },
          'websocket heartbeat timeout; terminating connection',
        );
        connection.terminate();
        this.handleClose(connection);
        continue;
      }

      connection.ping();
      this.#checkCredential(connection, now);
    }
  }

  /**
   * Close code `4001` (§14.6) — "auth session expired or token revoked".
   *
   * The cached expiry is a floor, not a verdict: the idle timeout slides forward on REST
   * activity, so reaching it means "ask the database". A confirmed-dead credential closes the
   * socket; a live one just refreshes the floor. Nothing here closes a connection on a
   * database error — a PostgreSQL blip is not a logout.
   */
  #checkCredential(connection: HubConnection, now: Date): void {
    const credential = connection.credential;
    if (credential === null || this.#credentialChecks.has(connection)) return;

    const expiresAt = connection.credentialExpiresAt;
    if (expiresAt === null) {
      connection.ticksSinceCredentialCheck += 1;
      if (connection.ticksSinceCredentialCheck < this.#credentialRecheckTicks) return;
    } else if (now.getTime() < expiresAt.getTime()) {
      return;
    }

    connection.ticksSinceCredentialCheck = 0;
    this.#credentialChecks.add(connection);

    void credential
      .revalidate()
      .then((result) => {
        if (result.valid) {
          connection.credentialExpiresAt = result.expiresAt;
          return;
        }
        connection.log.info(
          { connectionId: connection.id },
          'websocket credential no longer valid; closing',
        );
        connection.beginClose(WS_CLOSE.AUTH_EXPIRED, 'authentication expired');
      })
      .catch((error: unknown) => {
        connection.log.warn(
          { err: error, connectionId: connection.id },
          'websocket credential revalidation failed; keeping connection',
        );
      })
      .finally(() => {
        this.#credentialChecks.delete(connection);
      });
  }

  /** Graceful shutdown (§14.6 close code 1001). */
  closeAll(code: WsCloseCode = WS_CLOSE.SERVER_SHUTDOWN, reason = 'server shutting down'): void {
    for (const connection of [...this.#connections.values()]) {
      connection.beginClose(code, reason);
      this.handleClose(connection);
    }
    this.#channelIndex.clear();
    this.#connections.clear();
  }

  // ------------------------------------------------------------------------------ internals

  #violation(connection: HubConnection, code: string, message: string): void {
    connection.send(errorFrame(code, message));
    if (connection.recordViolation()) {
      connection.log.warn(
        { connectionId: connection.id, ...connection.stats },
        'websocket protocol violation limit reached; closing',
      );
      connection.beginClose(WS_CLOSE.PROTOCOL_VIOLATION, 'repeated protocol violations');
    }
  }

  /** Serialise a connection's frame handling; failures are logged, never rethrown. */
  #enqueue(connection: HubConnection, task: () => Promise<void>): void {
    const tail = (this.#tails.get(connection) ?? Promise.resolve())
      .then(task)
      .catch((error: unknown) => {
        connection.log.error(
          { err: error, connectionId: connection.id },
          'websocket frame handling failed',
        );
      });
    this.#tails.set(connection, tail);
  }

  /** Test seam: await the point where every queued frame for a connection has been handled. */
  async settled(connection: HubConnection): Promise<void> {
    await (this.#tails.get(connection) ?? Promise.resolve());
  }
}

function truncate(value: string, max = 80): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
