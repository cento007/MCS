/**
 * Queue name constants (TDS 02 §2.1 — `queue` export owns them).
 *
 * A queue name is NOT an event type. `session.launch` is a job name that carries no F6
 * envelope (TDS 04 §15.2 note); domain events all travel on the `events` queue and are
 * routed by consumers on `envelope.type`.
 *
 * SCAFFOLD STATE: only the names the foundation documents already fix are declared.
 * The full job catalog (notification dispatch, Obsidian sync, repo polling, exports,
 * daily report) lands with WS1/Phase 2 implementation.
 */
export const QUEUE_NAMES = Object.freeze({
  /** Every F6 domain event enqueued transactionally with its domain write (F6.3). */
  EVENTS: 'events',
  /** Durable managed-session launch requests when the concurrency pool is saturated (TDS 02 §4.3). */
  SESSION_LAUNCH: 'session.launch',
  /**
   * Rate-limited turns awaiting retry (TDS 02 §4.3). Also a job name, not an event: the Session
   * stays `running` throughout, so nothing in the F6 catalog describes it.
   */
  SESSION_PROMPT_RETRY: 'session.prompt.retry',
} as const);

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];
