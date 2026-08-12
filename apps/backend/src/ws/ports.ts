import type { EntityId, EventEnvelope } from '@mc/shared';
import type { Principal } from '../auth/principal.js';

/**
 * The narrow interfaces `ws/` consumes from the rest of the Backend.
 *
 * TDS 02 §2 makes the hub a **dumb relay**: it owns no business logic and never mutates
 * domain state. Every capability it needs from a domain module is expressed here as a port
 * with the smallest possible surface, and injected at wiring time (`app.ts`). Nothing in
 * `ws/` imports `sessions/`, `events/` or `queue/`, so the two directories can be developed —
 * and reviewed — independently.
 *
 * ASSUMPTIONS RECORDED HERE (these ports were written before their producers existed, and are
 * kept as ports afterwards so the hub still depends on a shape rather than on a module):
 *   - `EventBusPort` assumed `events/` would expose an in-process fan-out of finished F6
 *     envelopes with a "subscribe to everything" entry point. The bus that landed satisfies it
 *     structurally, so `app.ts` passes it with no adapter. Had it been per-type
 *     (`on(type, handler)`), the adapter would have been a loop over the event-type registry
 *     in `@mc/shared` — confined to `app.ts`, with nothing in the hub moving.
 *   - `SessionAccessPort` assumes read-authorization for a Session is answerable from the
 *     Session id and the Principal alone.
 *   - `PromptPort` assumes prompt submission returns the persisted user Message id, which is
 *     what §14.5's `ack { messageId }` and §6.4's `202 { data: { messageId } }` both carry.
 *     It is still unsupplied: the managed-session wrapper owns it.
 */

/**
 * In-process fan-out of F6 envelopes (F3.2, TDS 02 §2 / §15.1 "in-process EventEmitter").
 *
 * The hub is a SUBSCRIBER only — it never publishes back onto the bus, because a relay that
 * can inject events into the durable path is no longer a relay. Delivery here is best-effort
 * and in-memory: the bus makes no durability claim, and neither does the hub (F6.3, no replay).
 */
export interface EventBusPort {
  /**
   * Receive every envelope published in this process. Returns an unsubscribe function.
   *
   * A "firehose plus a routing table" rather than per-type registration is deliberate: the
   * filter that decides what a browser may see is `channels.ts`, in one reviewable place,
   * and an event type added elsewhere cannot become visible to clients by accident.
   */
  subscribeAll(listener: (event: EventEnvelope) => void): () => void;
}

/**
 * "May this principal read this Session?" — the authorization check on `session:{id}`
 * subscriptions and on `prompt` frames.
 *
 * V1 is a single-user system and §14.3 says any authenticated `full` principal may subscribe
 * to any channel, so the only honest question left is whether the Session exists. The port
 * exists anyway because the alternative — hardcoding "yes" — makes the authorization point
 * invisible on the day it stops being true (Phase 4 agents, multi-user in V2+).
 */
export interface SessionAccessPort {
  canRead(principal: Principal, sessionId: EntityId): Promise<boolean>;
}

/**
 * Prompt submission (§6.4). The WebSocket `prompt` frame is explicitly *transport-equivalent*
 * to `POST /api/v1/sessions/{id}/prompts`, so it must land in the same code path — the hub
 * delegates and never re-implements title derivation, Message persistence or state checks.
 *
 * Implementations throw `ApiError` for domain failures (`SESSION_NOT_RUNNING`,
 * `OPERATION_NOT_SUPPORTED`, …); the hub renders the code and message into an `ack`.
 */
export interface PromptPort {
  submit(input: {
    readonly principal: Principal;
    readonly sessionId: EntityId;
    readonly content: string;
  }): Promise<{ readonly messageId: EntityId }>;
}

export type CredentialCheck =
  | { readonly valid: true; readonly expiresAt: Date | null }
  | { readonly valid: false };

/**
 * The credential that authorised the upgrade, re-checkable for the life of the connection.
 *
 * Without this, close code `4001` ("auth session expired or token revoked", §14.6) could
 * never fire: a WebSocket authenticates once, at upgrade, and a logout or a revoked token on
 * another tab would leave the stream running until the socket happened to drop.
 *
 * `expiresAt` is the known expiry captured at upgrade. The hub uses it as a *floor*, not as
 * the answer: an idle timeout slides forward on REST activity (auth service `#touchSession`),
 * so reaching it means "ask the database", not "close". See `hub.ts` `#checkCredentials`.
 */
export interface ConnectionCredential {
  readonly expiresAt: Date | null;
  revalidate(): Promise<CredentialCheck>;
}
