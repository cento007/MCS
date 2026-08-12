import {
  type EventEnvelope,
  type Heartbeat,
  type Logger,
  QUEUE_NAMES,
  type QueueConsumerPort,
  type Unsubscribe,
} from '@mc/shared';

/**
 * Sync Worker core (TDS 02 §2.2).
 *
 * SCAFFOLD STATE: subscriptions are declared and wired; handlers do nothing but log.
 * No vault I/O, no git polling, no ADR generation — all Phase 2.
 *
 * Constraints that already bind the Phase 2 implementation:
 *   - queue-only communication with the Backend (F2.2); no HTTP client between services
 *   - every handler idempotent on `event.id` — delivery is at-least-once (F6.3)
 *   - every filesystem path comes from Settings as a validated absolute native path and is
 *     composed with `node:path`; no shell-outs, `execFile` with explicit paths only (F8.1)
 *   - Graphify graph-refresh jobs hang off this worker in Phase 3+ (TDS 02 §11.3)
 */

/** Queues this worker consumes. Phase 2 adds the Obsidian sync and repo-poll queues. */
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
    // Phase 2: two-way vault sync with the configured conflict policy, ADR file
    // generation on adr.created/adr.updated, scheduled repository polling; emits
    // repository.synced / sync.* events.
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

      logger.info({ queues: [...SUBSCRIBED_QUEUES] }, 'sync worker started');
    },

    async stop() {
      if (!running) return;
      running = false;

      heartbeat?.stop();
      for (const unsubscribe of unsubscribes.reverse()) await unsubscribe();
      unsubscribes.length = 0;
      await queue.stop();

      logger.info('sync worker stopped');
    },
  };
}
