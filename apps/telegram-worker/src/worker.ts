import {
  type EventEnvelope,
  type Heartbeat,
  type Logger,
  QUEUE_NAMES,
  type QueueConsumerPort,
  type Unsubscribe,
} from '@mc/shared';

/**
 * Telegram Worker core (TDS 02 §2.2).
 *
 * SCAFFOLD STATE: subscriptions are declared and wired; handlers do nothing but log.
 * No Telegram Bot API call, no `notifications` write, no retry policy — all Phase 2.
 *
 * What the shape already enforces, and must keep enforcing:
 *   - the worker talks to the Backend ONLY through the queue (F2.2) — no HTTP client, no
 *     import of any Backend module
 *   - delivery is at-least-once, so every handler must be idempotent on `event.id` (F6.3)
 *   - the process exposes no port; health is derived from the heartbeat row (TDS 02 §7.2)
 */

/** Queues this worker consumes. Phase 2 adds the notification-dispatch and cron queues. */
export const SUBSCRIBED_QUEUES: readonly string[] = [QUEUE_NAMES.EVENTS];

export interface WorkerOptions {
  readonly queue: QueueConsumerPort;
  readonly logger: Logger;
  readonly heartbeat?: Heartbeat;
}

export interface Worker {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createWorker(options: WorkerOptions): Worker {
  const { queue, logger, heartbeat } = options;
  const unsubscribes: Unsubscribe[] = [];
  let running = false;

  const handle = async (event: EventEnvelope): Promise<void> => {
    // Phase 2: decide per NotificationsSettings whether to create/deliver a Notification
    // for session.completed / session.failed / repository.sync_failed / sync.failed,
    // then send via the Bot API and record delivery state.
    logger.debug({ eventId: event.id, eventType: event.type }, 'event received (no-op scaffold)');
  };

  return {
    async start() {
      if (running) return;
      running = true;

      for (const name of SUBSCRIBED_QUEUES) {
        unsubscribes.push(await queue.subscribe(name, handle));
      }

      heartbeat?.start();
      await heartbeat?.beat();

      logger.info({ queues: [...SUBSCRIBED_QUEUES] }, 'telegram worker started');
    },

    async stop() {
      if (!running) return;
      running = false;

      heartbeat?.stop();
      for (const unsubscribe of unsubscribes.reverse()) await unsubscribe();
      unsubscribes.length = 0;
      await queue.stop();

      logger.info('telegram worker stopped');
    },
  };
}
