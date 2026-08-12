import { createJob, QUEUE_NAMES, type QueuePort } from '@mc/shared';
import type { OutboxTransaction } from '../../events/index.js';
import type { RateLimitedTurn, TurnRetryScheduler } from './ports.js';

/**
 * Rate-limit backoff (TDS 02 §4.3, F1.5 "rate-limit stop reasons trigger backoff/queueing via
 * the F3 queue").
 *
 * The contract this module exists to keep, and the one WS6 §5.2's `rate-limit-stop` script
 * asserts: **the Session stays `running`.** The turn failed; the process is healthy; there is
 * nothing for F7 to say about it. So no transition happens, no `session.state_changed` is
 * emitted, and the only durable consequence is a delayed `session.prompt.retry` job.
 *
 * Backoff is exponential with jitter. The jitter is not decoration: a single Backend hitting a
 * plan-wide rate limit will typically have several sessions stop at once, and un-jittered
 * retries would re-collide with each other on every wave.
 */

export type PromptRetryJob = {
  readonly sessionId: string;
  readonly content: string;
  /** The already-persisted user Message, so a retry never creates a second one. */
  readonly messageId: string | null;
  readonly attempt: number;
  readonly reason: string;
};

/**
 * The slice of `Outbox` this module needs. Declared narrowly so the scheduler is unit-testable
 * with no database: `Outbox` has private fields, so nothing can stand in for the class itself.
 */
export interface RetryOutbox {
  run<T>(work: (ctx: OutboxTransaction) => Promise<T>): Promise<T>;
}

export interface TurnRetrySchedulerOptions {
  readonly queue: QueuePort;
  readonly outbox: RetryOutbox;
  /** Attempts past which the turn is given up on (§4.3 "repeated exhaustion"). */
  readonly maxAttempts?: number;
  readonly baseDelaySeconds?: number;
  readonly maxDelaySeconds?: number;
  /** Injectable for tests; the default is `Math.random`. */
  readonly random?: () => number;
  /**
   * Called when the retry policy is exhausted. §4.3: "marks that prompt's turn failed and
   * notifies (Phase 2: Telegram alert path) — it does not transition the Session to `failed`."
   */
  readonly onExhausted?: (turn: RateLimitedTurn) => void;
}

export const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_BASE_DELAY_SECONDS = 30;
export const DEFAULT_MAX_DELAY_SECONDS = 900;

/** `base * 2^(attempt-1)`, capped, plus up to 20% jitter. Pure, so the policy is testable. */
export function retryDelaySeconds(
  attempt: number,
  options: { base: number; max: number; random: () => number },
): number {
  const exponential = options.base * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, options.max);
  return Math.round(capped * (1 + options.random() * 0.2));
}

export function createTurnRetryScheduler(options: TurnRetrySchedulerOptions): TurnRetryScheduler {
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const base = options.baseDelaySeconds ?? DEFAULT_BASE_DELAY_SECONDS;
  const max = options.maxDelaySeconds ?? DEFAULT_MAX_DELAY_SECONDS;
  const random = options.random ?? Math.random;

  return {
    async schedule(turn: RateLimitedTurn): Promise<void> {
      // Nothing to re-send: the turn was not started by a Mission Control prompt (a resumed
      // conversation continuing on its own). Backing off would have nothing to back off *to*.
      if (turn.content === null || turn.content.length === 0) {
        options.onExhausted?.(turn);
        return;
      }

      if (turn.attempt > maxAttempts) {
        options.onExhausted?.(turn);
        return;
      }

      const payload: PromptRetryJob = {
        sessionId: turn.sessionId,
        content: turn.content,
        messageId: turn.messageId,
        attempt: turn.attempt,
        reason: turn.reason,
      };

      // The same transactional enqueue every producer uses (F6.3). Nothing else happens in this
      // transaction — deliberately: a rate-limited turn changes no domain state at all.
      await options.outbox.run(async (outboxTx) => {
        await options.queue.enqueueJob(
          outboxTx.tx,
          QUEUE_NAMES.SESSION_PROMPT_RETRY,
          createJob(payload, undefined, {
            startAfterSeconds: retryDelaySeconds(turn.attempt, { base, max, random }),
          }),
        );
      });
    },
  };
}
