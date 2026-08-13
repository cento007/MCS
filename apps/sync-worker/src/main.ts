import process from 'node:process';
import {
  createDatabaseHeartbeatSink,
  createHeartbeat,
  createLoggerFromConfig,
  createShutdownController,
  loadConfigOrExit,
} from '@mc/shared';
import { AdrGenerationService } from './adr-generation.js';
import { createDatabase } from './db.js';
import { WorkerOutbox } from './outbox.js';
import { createWorkerQueue } from './queue.js';
import { SyncScheduler } from './schedule.js';
import { SyncService } from './sync.js';
import { createWorker } from './worker.js';

/**
 * Sync Worker process entry (TDS 02 §2.2, Phase 2).
 *
 * Process contract (F8.1): foreground, JSON logs to stdout, nonzero exit on fatal. Under
 * systemd this is `mission-control-sync-worker.service`; in a dev console it is one of the
 * `pnpm dev:workers` processes. No process-manager knowledge lives here.
 *
 * Shutdown is wired to BOTH SIGINT and SIGTERM: Ubuntu sends SIGTERM, Windows delivers Ctrl-C
 * as SIGINT and has no true SIGTERM (TDS 07 §7.2).
 *
 * **This process is the only one that writes to the operator's Obsidian vault.** It exposes no
 * port and never calls the Backend; everything arrives on a pg-boss queue and everything it
 * reports goes back through PostgreSQL — the `sync_runs` row, the `obsidian_sync_states`
 * ledger, `audit_log_entries`, and F6 events on the `events` queue.
 *
 * Startup order: config -> DB pool -> `boss.start()` (pg-boss migrates its own vendored schema;
 * the **Backend** owns the app migrations, TDS 03 §7.1) -> subscribe -> accept work.
 */
const VERSION = process.env['MC_VERSION'] ?? '0.0.0';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log = createLoggerFromConfig('sync-worker', config);

  const database = createDatabase({ connectionString: config.databaseUrl });
  const shutdown = createShutdownController({ logger: log });

  // Aborted before anything else on shutdown, so a sync part-way through a vault unblocks
  // between files instead of holding `offWork` open (see `worker.ts`'s `stop`).
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

  const outbox = new WorkerOutbox({ db: database.db, queue });

  const worker = createWorker({
    queue,
    logger: log,
    sync: new SyncService({ db: database.db, outbox, logger: log }),
    scheduler: new SyncScheduler({ db: database.db, queue, logger: log }),
    adrs: new AdrGenerationService({ db: database.db, outbox, logger: log }),
    shutdown: inFlight,
    heartbeat: createHeartbeat({
      service: 'sync-worker',
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
    log.fatal({ err: error }, 'sync worker failed to start');
    await queue.stop();
    await database.close();
    process.exit(1);
  }
}

await main();
