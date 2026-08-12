import type { SessionMessageDelta } from '../../ws/hub.js';
import type { AppendMessageInput, AppendMessageResult } from '../messages.js';
import type { TransitionRequest, TransitionResult } from '../state-machine.js';
import type { SessionCostSnapshot } from './cost.js';

/**
 * The narrow interfaces `ManagedSessionController` consumes.
 *
 * Every one of them is satisfied structurally by the real service (`MessageService`,
 * `SessionStateMachine`, `WebSocketHub`, …) and by a three-line fake in a unit test. That is the
 * point: TDS 07 §3 keeps `pnpm test` runnable with **no PostgreSQL installed**, and a controller
 * that depended on `MessageService` the class would drag `Outbox` -> `Db` -> a live connection
 * into the unit tier with it.
 *
 * Nothing here re-implements anything. `MessageSink` is `MessageService.append`'s signature
 * exactly, so ordinal assignment, partial-index de-duplication and A13 title derivation stay in
 * the one transaction that owns them (§6.11.1).
 */

/** `MessageService.append` (TDS 04 §6.6 write half). */
export interface MessageSink {
  append(input: AppendMessageInput): Promise<AppendMessageResult>;
}

/** `SessionStateMachine.transition` — the only writer of `sessions.state` (TDS 02 §2). */
export interface SessionStatePort {
  transition(request: TransitionRequest): Promise<TransitionResult>;
}

/**
 * `WebSocketHub.publishSessionDelta` (§14.5, §15.2 row 10). Ephemeral by contract: the hub
 * relays it to `session:{id}` subscribers and it is never enqueued and never persisted.
 */
export interface SessionDeltaSink {
  publishSessionDelta(delta: SessionMessageDelta): unknown;
}

/** The Session's persisted cost/usage totals (TDS 03 §3.9), read at launch and written per turn. */
export interface SessionCostStore {
  read(sessionId: string): Promise<SessionCostSnapshot>;
  write(sessionId: string, snapshot: SessionCostSnapshot): Promise<void>;
}

/** A turn that ended on a rate limit and must be retried with backoff (WS1 §4.3). */
export interface RateLimitedTurn {
  readonly sessionId: string;
  /** The prompt to re-send. `null` when the turn was not started by a Mission Control prompt. */
  readonly content: string | null;
  /** The user Message the prompt was persisted as, so a retry does not create a second one. */
  readonly messageId: string | null;
  readonly attempt: number;
  readonly reason: string;
}

/**
 * Re-enqueues a rate-limited prompt as a **delayed** job (WS1 §4.3: exponential backoff +
 * jitter). Separate from the controller because backoff policy is queue-shaped and a controller
 * must not own a queue.
 */
export interface TurnRetryScheduler {
  schedule(turn: RateLimitedTurn): Promise<void>;
}
