import {
  decodeRelayEvent,
  EVENT_RELAY_CHANNEL,
  type EventEnvelope,
  type RelayRejectReason,
} from '@mc/shared';
import pg from 'pg';
import type { EventBus } from './bus.js';

/**
 * The Backend half of the worker -> hub event relay (TDS 04 §15.1, TDS 02 §7.2).
 *
 * One dedicated PostgreSQL connection sits on `LISTEN mc_events` and republishes every valid
 * F6 envelope it receives onto the **existing in-process bus**. That last word is the whole
 * point of the shape: `ws/hub.ts` already subscribes to that bus and already routes through
 * `ws/channels.ts`, so a relayed `sync.completed` reaches the `sync` channel by exactly the
 * same code path as an in-process one and the hub needs no notion of provenance. The
 * `notifications/produce.ts` mapping for `sync.failed` — written complete and documented as
 * unreachable "until §15.1's LISTEN/NOTIFY arm exists" — comes alive for the same reason.
 *
 * ## Fan-out, not a queue
 *
 * `NOTIFY` is a broadcast: PostgreSQL copies the payload to every session that has issued
 * `LISTEN` on the channel. There is no row, no lock and nothing to claim, so N Backend
 * processes each receive every envelope and none can take another's. Contrast the `events`
 * pg-boss queue, which is `FOR UPDATE SKIP LOCKED` — one job, one winner, everybody else sees
 * nothing. That difference is why TDS 04 §15.2's "both workers consume `events`" cannot work
 * and why this relay is not simply another subscriber on that queue.
 *
 * ## What this connection is, and why it is its own
 *
 * A `LISTEN` is session state. Taken from the app pool it would be silently lost the moment the
 * client was released and handed to the next query — the relay would look alive and deliver
 * nothing. So: a dedicated `pg.Client`, never pooled, tagged `application_name = mc-event-relay`
 * so an operator can see it in `pg_stat_activity`.
 *
 * ## Losing the connection
 *
 * A dropped `LISTEN` never comes back on its own, and nothing else in the process would notice:
 * the failure mode is a relay that is silently dead for the life of the Backend. Two mechanisms
 * answer that, and both are tested:
 *
 *  1. **Reconnect.** `error` and `end` both schedule a fresh client with exponential backoff and
 *     jitter, and re-issue the `LISTEN`. The timer is `unref`ed so a reconnect loop can never be
 *     the reason the process refuses to exit (F8.1).
 *  2. **Gap recovery.** `NOTIFY` is not durable — anything raised while nobody was listening is
 *     gone, and there is no backlog to replay. Rather than leave connected browsers quietly
 *     stale, a reconnect *after a drop* invokes `onGap`, which `app.ts` wires to
 *     `hub.closeAll(4003)`. That is not an invention: §14.7 already defines reconnect-and-refetch
 *     as the client's one recovery mechanism, and closing is how the server invokes it. A
 *     Backend **restart** needs nothing extra — every socket dies with the process, so the same
 *     §14.7 path runs.
 *
 * The relay never replays and never reads the durable queue. Draining `events` here would make
 * the Backend a competing consumer against the Telegram Worker, which is the precise mistake
 * this whole module exists to avoid.
 */

/** §14.7 recovery after a relay gap; see `WS_CLOSE.RELAY_GAP` in `ws/protocol.ts`. */
export const DEFAULT_RECONNECT_DELAY_MS = 500;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 10_000;

/**
 * Envelope ids remembered for de-duplication.
 *
 * Delivery is at-least-once by contract (F6.3) and the in-process bus has subscribers with real
 * side effects — `notifications/produce.ts` writes a row and enqueues a Telegram send. A repeat
 * of the same envelope must therefore be dropped here rather than merely tolerated downstream.
 * 4096 is generous next to the traffic this relay carries (worker events, single-user system)
 * and costs a few hundred kilobytes at worst.
 */
export const DEDUPE_CAPACITY = 4096;

export type EventRelayState = 'stopped' | 'connecting' | 'listening' | 'reconnecting';

/**
 * The operator-facing status. Surfaced through `GET /services/health`'s Backend row
 * (`meta.eventRelay`) so "the relay is down" is a thing an operator can *see* rather than infer
 * from events that never arrive.
 */
export interface EventRelayStatus {
  readonly state: EventRelayState;
  readonly channel: string;
  /** When the current `LISTEN` was established; `null` while not listening. */
  readonly listeningSince: string | null;
  readonly lastEventAt: string | null;
  /** Successful `LISTEN`s since `start()`. `1` in a healthy process that has never dropped. */
  readonly connects: number;
  /** Re-established connections — i.e. `connects - 1`, floored at 0. Nonzero means flapping. */
  readonly reconnects: number;
  /** Gaps announced to the hub (a reconnect that followed a real drop). */
  readonly gaps: number;
  readonly received: number;
  readonly relayed: number;
  readonly dropped: {
    readonly duplicate: number;
    readonly unparsable: number;
    readonly malformed: number;
    readonly unknownType: number;
    readonly ephemeral: number;
  };
  readonly lastError: string | null;
  readonly lastErrorAt: string | null;
}

/**
 * The subset of `pg.Client` this module uses.
 *
 * Narrow on purpose: the reconnect behaviour is the part most likely to rot and the part a real
 * database makes slowest to test, so the unit tier drives it through a hand-written double and
 * `createPgRelayClient` is the only place the real driver is named.
 */
export interface RelayNotification {
  readonly channel: string;
  readonly payload?: string | undefined;
}

export interface RelayClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  onNotification(listener: (message: RelayNotification) => void): void;
  onError(listener: (error: Error) => void): void;
  onEnd(listener: () => void): void;
  end(): Promise<void>;
}

export type RelayClientFactory = () => RelayClient;

export interface EventRelayLogger {
  info(object: object, message: string): void;
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
  debug(object: object, message: string): void;
}

export interface EventRelayOptions {
  readonly bus: EventBus;
  readonly log: EventRelayLogger;
  readonly newClient: RelayClientFactory;
  readonly channel?: string | undefined;
  /**
   * Called when the relay re-establishes after a drop. Events raised during the outage are
   * unrecoverable (`NOTIFY` keeps no backlog), so this is where the §14.7 refetch is triggered.
   * Never called for the first successful connect — there is no gap before the stream started.
   */
  readonly onGap?: ((info: { readonly downForMs: number }) => void) | undefined;
  readonly reconnectDelayMs?: number | undefined;
  readonly maxReconnectDelayMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Jitter source; tests pin it to make the backoff deterministic. */
  readonly random?: (() => number) | undefined;
}

export class EventRelay {
  readonly #bus: EventBus;
  readonly #log: EventRelayLogger;
  readonly #newClient: RelayClientFactory;
  readonly #channel: string;
  readonly #onGap: ((info: { downForMs: number }) => void) | undefined;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #now: () => Date;
  readonly #random: () => number;

  /** Insertion-ordered id -> nothing; `Map` gives us O(1) eviction of the oldest key. */
  readonly #seen = new Map<string, true>();

  #state: EventRelayState = 'stopped';
  #client: RelayClient | null = null;
  #timer: NodeJS.Timeout | null = null;
  #attempt = 0;
  #stopped = true;
  /** Guards against two in-flight connect attempts after a fast error/end pair. */
  #generation = 0;

  #listeningSince: Date | null = null;
  #disconnectedAt: Date | null = null;
  #lastEventAt: Date | null = null;
  #connects = 0;
  #gaps = 0;
  #received = 0;
  #relayed = 0;
  #duplicate = 0;
  #unparsable = 0;
  #malformed = 0;
  #unknownType = 0;
  #ephemeral = 0;
  #lastError: string | null = null;
  #lastErrorAt: Date | null = null;

  constructor(options: EventRelayOptions) {
    this.#bus = options.bus;
    this.#log = options.log;
    this.#newClient = options.newClient;
    this.#channel = options.channel ?? EVENT_RELAY_CHANNEL;
    this.#onGap = options.onGap;
    this.#baseDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.#maxDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
  }

  get status(): EventRelayStatus {
    return {
      state: this.#state,
      channel: this.#channel,
      listeningSince: this.#listeningSince?.toISOString() ?? null,
      lastEventAt: this.#lastEventAt?.toISOString() ?? null,
      connects: this.#connects,
      reconnects: Math.max(0, this.#connects - 1),
      gaps: this.#gaps,
      received: this.#received,
      relayed: this.#relayed,
      dropped: {
        duplicate: this.#duplicate,
        unparsable: this.#unparsable,
        malformed: this.#malformed,
        unknownType: this.#unknownType,
        ephemeral: this.#ephemeral,
      },
      lastError: this.#lastError,
      lastErrorAt: this.#lastErrorAt?.toISOString() ?? null,
    };
  }

  /**
   * Connect and `LISTEN`. Resolves once the first attempt has settled either way — a database
   * that is not up yet must not stop the Backend from starting, so a failed first attempt
   * schedules a retry instead of rejecting.
   */
  async start(): Promise<void> {
    if (!this.#stopped) return;
    this.#stopped = false;
    await this.#connect();
  }

  /** Idempotent. Cancels any pending reconnect and releases the connection. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#generation += 1;
    this.#state = 'stopped';
    this.#listeningSince = null;

    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }

    const client = this.#client;
    this.#client = null;
    if (client === null) return;

    try {
      await client.end();
    } catch (error) {
      this.#log.debug({ err: error }, 'event relay client failed to close cleanly');
    }
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;

    this.#generation += 1;
    const generation = this.#generation;
    this.#state = this.#connects === 0 ? 'connecting' : 'reconnecting';

    let client: RelayClient;
    try {
      client = this.#newClient();
    } catch (error) {
      this.#fail(error, generation);
      return;
    }

    // Attached BEFORE `connect()`: `pg.Client` emits `error` for connection-level failures and
    // an unhandled 'error' event is fatal in Node. A window with no handler is a process crash.
    client.onError((error) => {
      this.#log.warn({ err: error }, 'event relay connection error');
      this.#fail(error, generation);
    });
    client.onEnd(() => {
      this.#fail(new Error('event relay connection closed by the server'), generation);
    });
    client.onNotification((message) => {
      // Bound to this attempt. A real `pg.Client` stops emitting once ended, but the relay must
      // not depend on that: a notification arriving from a client we have already abandoned —
      // or after `stop()` — would publish an event into a bus whose subscribers believe the
      // process is shutting down.
      if (this.#stopped || generation !== this.#generation) return;
      this.#handle(message);
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${this.#channel}`);
    } catch (error) {
      this.#client = client;
      this.#fail(error, generation);
      return;
    }

    if (this.#stopped || generation !== this.#generation) {
      // Stopped (or superseded) while the handshake was in flight. Release the orphan rather
      // than leaving a live connection nothing will ever close.
      try {
        await client.end();
      } catch {
        /* nothing left to do with it */
      }
      return;
    }

    const listeningSince = this.#now();
    this.#client = client;
    this.#state = 'listening';
    this.#attempt = 0;
    this.#connects += 1;
    this.#listeningSince = listeningSince;

    const disconnectedAt = this.#disconnectedAt;
    this.#disconnectedAt = null;

    if (disconnectedAt === null) {
      this.#log.info({ channel: this.#channel }, 'event relay listening');
      return;
    }

    // A gap: something happened while we were not listening, and `NOTIFY` kept none of it.
    const downForMs = Math.max(0, listeningSince.getTime() - disconnectedAt.getTime());
    this.#gaps += 1;
    this.#log.warn(
      { channel: this.#channel, downForMs, gaps: this.#gaps },
      'event relay reconnected after a gap; worker events may have been missed',
    );
    try {
      this.#onGap?.({ downForMs });
    } catch (error) {
      this.#log.error({ err: error }, 'event relay gap handler failed');
    }
  }

  /** Record a failure, drop the client, and schedule the next attempt. */
  #fail(error: unknown, generation: number): void {
    if (this.#stopped || generation !== this.#generation) return;
    this.#generation += 1;

    this.#lastError = error instanceof Error ? error.message : String(error);
    this.#lastErrorAt = this.#now();
    // Only a relay that was ONCE listening can have a gap. A database that is still coming up
    // at boot has cost us nothing — there was no stream to miss events from — and treating it
    // as a gap would greet every cold start by closing the sockets that had just connected.
    if (this.#connects > 0) this.#disconnectedAt ??= this.#lastErrorAt;
    this.#state = 'reconnecting';
    this.#listeningSince = null;

    const client = this.#client;
    this.#client = null;
    if (client !== null) {
      void Promise.resolve()
        .then(async () => client.end())
        .catch(() => {
          /* already broken; nothing to salvage */
        });
    }

    this.#attempt += 1;
    const delayMs = this.#backoffMs(this.#attempt);
    this.#log.warn(
      { err: error, attempt: this.#attempt, delayMs },
      'event relay disconnected; reconnecting',
    );

    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#connect();
    }, delayMs);
    // A relay that is trying to reconnect must never hold the process open (F8.1).
    this.#timer.unref?.();
  }

  /** Exponential with full-width jitter, capped. Jitter stops a database restart from being met by a thundering herd. */
  #backoffMs(attempt: number): number {
    const exponential = Math.min(this.#maxDelayMs, this.#baseDelayMs * 2 ** (attempt - 1));
    return Math.round(exponential * (0.5 + this.#random() * 0.5));
  }

  /** One inbound notification. Never throws: a bad payload must not kill the connection. */
  #handle(message: RelayNotification): void {
    if (message.channel !== this.#channel) return;
    this.#received += 1;
    this.#lastEventAt = this.#now();

    const payload = message.payload ?? '';
    const decoded = decodeRelayEvent(payload);
    if (!decoded.ok) {
      this.#countRejection(decoded.reason);
      this.#log.warn(
        { reason: decoded.reason, bytes: payload.length },
        'event relay dropped a notification it could not accept',
      );
      return;
    }

    if (this.#remember(decoded.event.id)) {
      this.#duplicate += 1;
      this.#log.debug(
        { eventId: decoded.event.id, eventType: decoded.event.type },
        'event relay dropped a duplicate envelope',
      );
      return;
    }

    this.#relayed += 1;
    this.publish(decoded.event);
  }

  /**
   * Inject one already-validated envelope into the in-process bus.
   *
   * Separate from `#handle` so the failure boundary is explicit: the bus swallows subscriber
   * errors, but a throw from anywhere else here would escape into a `pg` event handler and take
   * the connection with it.
   */
  publish(event: EventEnvelope): void {
    try {
      this.#bus.publish(event);
    } catch (error) {
      /* c8 ignore next 2 — the bus already isolates listener errors; this is belt and braces */
      this.#log.error({ err: error, eventId: event.id }, 'event relay failed to publish');
    }
  }

  #countRejection(reason: RelayRejectReason): void {
    switch (reason) {
      case 'unparsable':
        this.#unparsable += 1;
        return;
      case 'malformed':
        this.#malformed += 1;
        return;
      case 'unknown_type':
        this.#unknownType += 1;
        return;
      case 'ephemeral':
        this.#ephemeral += 1;
    }
  }

  /** `true` if this id has been seen before. Bounded, insertion-ordered eviction. */
  #remember(id: string): boolean {
    if (this.#seen.has(id)) return true;
    this.#seen.set(id, true);
    if (this.#seen.size > DEDUPE_CAPACITY) {
      const oldest = this.#seen.keys().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
    return false;
  }
}

/** `application_name` for the relay's connection — how an operator finds it in `pg_stat_activity`. */
export const RELAY_APPLICATION_NAME = 'mc-event-relay';

/**
 * The real driver. The only place `pg.Client` is named for this purpose, and deliberately thin:
 * everything interesting about the relay is tested against `RelayClient` instead.
 */
export function createPgRelayClient(connectionString: string): RelayClient {
  const client = new pg.Client({ connectionString, application_name: RELAY_APPLICATION_NAME });

  return {
    connect: async () => {
      await client.connect();
    },
    query: async (text) => client.query(text),
    onNotification: (listener) => {
      client.on('notification', (message) => {
        listener({ channel: message.channel, payload: message.payload });
      });
    },
    onError: (listener) => {
      client.on('error', listener);
    },
    onEnd: (listener) => {
      client.on('end', listener);
    },
    end: async () => {
      await client.end();
    },
  };
}
