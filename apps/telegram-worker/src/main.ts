import process from 'node:process';
import {
  createDatabaseHeartbeatSink,
  createHeartbeat,
  createLoggerFromConfig,
  createShutdownController,
  loadConfigOrExit,
  type UndeliverableEvent,
} from '@mc/shared';
import { DailyReportService } from './daily-report.js';
import { createDatabase } from './db.js';
import { DeliveryService } from './delivery.js';
import { createWorkerQueue } from './queue.js';
import { TelegramClient } from './telegram/client.js';
import { createTelegramHttpPort } from './telegram/http.js';
import { createWorker } from './worker.js';

/**
 * Telegram Worker process entry (TDS 02 §2.2, Phase 2).
 *
 * Process contract (F8.1): foreground, JSON logs to stdout, nonzero exit on fatal. Under
 * systemd this is `mission-control-telegram-worker.service`; in a dev console it is one of the
 * `pnpm dev:workers` processes. No process-manager knowledge lives here.
 *
 * Shutdown is wired to BOTH SIGINT and SIGTERM: Ubuntu sends SIGTERM, Windows delivers Ctrl-C
 * as SIGINT and has no true SIGTERM (TDS 07 §7.2).
 *
 * **This is the only place the real Telegram transport is constructed.** Everything below it
 * takes the port as an argument, which is what lets every test drive the whole delivery path
 * without a network — and what lets the integration harness install a port that *throws*, so a
 * suite that forgot to inject fails loudly instead of messaging a real chat.
 *
 * Startup order: config -> DB pool -> `boss.start()` (pg-boss migrates its own vendored schema;
 * the **Backend** owns the app migrations, TDS 03 §7.1) -> subscribe -> accept work.
 */
const VERSION = process.env['MC_VERSION'] ?? '0.0.0';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log = createLoggerFromConfig('telegram-worker', config);

  const database = createDatabase({ connectionString: config.databaseUrl });
  const shutdown = createShutdownController({ logger: log });

  // Aborted before anything else on shutdown, so an in-flight Bot API call unblocks instead of
  // holding `offWork` open (see `worker.ts`'s `stop`).
  const inFlight = new AbortController();

  const queue = createWorkerQueue({
    connectionString: config.databaseUrl,
    onError: (error) => {
      log.error({ err: error }, 'queue error');
    },
    onWarning: (warning) => {
      log.warn({ warning }, 'queue warning');
    },
  });

  try {
    await queue.start();
  } catch (error) {
    log.fatal({ err: error }, 'queue failed to start');
    await database.close();
    process.exit(1);
  }

  // The relay is best-effort, so an envelope it cannot carry is a log line and nothing else —
  // but it must be a log line, not silence (TDS 04 §15.1).
  const onUndeliverable = ({ event, bytes, limit }: UndeliverableEvent): void => {
    log.warn(
      { eventId: event.id, eventType: event.type, bytes, limit },
      'event was too large for the LISTEN/NOTIFY relay; the durable queue copy is unaffected',
    );
  };

  const delivery = new DeliveryService({
    db: database.db,
    queue,
    client: new TelegramClient({ http: createTelegramHttpPort() }),
    encryptionKey: config.encryptionKey,
    signal: inFlight.signal,
    onUndeliverable,
  });

  const dailyReport = new DailyReportService({ db: database.db, queue, onUndeliverable });

  const worker = createWorker({
    queue,
    logger: log,
    delivery,
    dailyReport,
    shutdown: inFlight,
    heartbeat: createHeartbeat({
      service: 'telegram-worker',
      version: VERSION,
      logger: log,
      // The real sink. Writing this row is what flips Settings -> Services from
      // `disabled` ("not deployed") to `healthy` (TDS 02 §7.2).
      sink: createDatabaseHeartbeatSink(database.db),
      stats: () => worker.stats(),
    }),
  });

  // Hooks run in REVERSE registration order, so the pool is registered first and drained last —
  // nothing can still be querying it once the consumers have stopped.
  shutdown.onShutdown('database-pool', async () => {
    await database.close();
  });
  shutdown.onShutdown('worker', async () => {
    await worker.stop();
  });

  try {
    await worker.start();
  } catch (error) {
    log.fatal({ err: error }, 'telegram worker failed to start');
    await queue.stop();
    await database.close();
    process.exit(1);
  }
}

await main();
