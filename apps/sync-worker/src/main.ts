import process from 'node:process';
import {
  createHeartbeat,
  createLoggerFromConfig,
  createNoopQueue,
  createShutdownController,
  keepAlive,
  loadConfigOrExit,
} from '@mc/shared';
import { createWorker } from './worker.js';

/**
 * Sync Worker process entry (TDS 02 §2.2, Phase 2).
 *
 * Process contract (F8.1): foreground, JSON logs to stdout, nonzero exit on fatal. Under
 * systemd this is `mission-control-sync-worker.service`; in a dev console it is one of the
 * `pnpm dev:workers` processes.
 *
 * Shutdown is wired to BOTH SIGINT and SIGTERM: Ubuntu sends SIGTERM, Windows delivers
 * Ctrl-C as SIGINT and has no true SIGTERM (TDS 07 §7.2).
 *
 * SCAFFOLD STATE: the queue is the in-memory `createNoopQueue()` placeholder, so this
 * process starts and stops cleanly with no database present.
 */
const VERSION = process.env['MC_VERSION'] ?? '0.0.0';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log = createLoggerFromConfig('sync-worker', config);

  const queue = createNoopQueue();
  const heartbeat = createHeartbeat({ service: 'sync-worker', version: VERSION, logger: log });
  const worker = createWorker({ queue, logger: log, heartbeat });

  const shutdown = createShutdownController({ logger: log });
  // Remove once the pg-boss driver holds the event loop itself — see keep-alive.ts.
  const stopKeepAlive = keepAlive();

  shutdown.onShutdown('keep-alive', stopKeepAlive);
  shutdown.onShutdown('worker', async () => {
    await worker.stop();
  });

  try {
    await worker.start();
  } catch (error) {
    log.fatal({ err: error }, 'sync worker failed to start');
    process.exit(1);
  }
}

await main();
