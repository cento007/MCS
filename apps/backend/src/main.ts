import process from 'node:process';
import { createLoggerFromConfig, createShutdownController, loadConfigOrExit } from '@mc/shared';
import { buildApp } from './app.js';
import { createDatabase } from './db/index.js';

/**
 * Backend process entry (TDS 02 §2).
 *
 * Process contract (F8.1): starts in the foreground, logs JSON to stdout, exits nonzero on
 * a fatal error. Identical behaviour under a Windows dev console and under a systemd unit;
 * no process-manager knowledge lives in application code.
 *
 * Startup order once the rest exists (TDS 03 §7.1): config -> DB pool -> drizzle-kit
 * migrations (the Backend is the sole migration runner) -> `boss.start()` -> accept work.
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log = createLoggerFromConfig('backend', config);

  const database = createDatabase({ connectionString: config.databaseUrl });
  const app = buildApp({ config, db: database.db });
  const shutdown = createShutdownController({ logger: log });

  // Hooks run in REVERSE registration order, so the pool is registered first and drained
  // last — nothing can still be querying it once the HTTP server has closed.
  shutdown.onShutdown('database-pool', async () => {
    await database.close();
  });
  shutdown.onShutdown('http-server', async () => {
    await app.close();
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    log.info(
      { host: config.host, port: config.port, dataDir: config.dataDir, env: config.nodeEnv },
      'backend listening',
    );
  } catch (error) {
    log.fatal({ err: error }, 'backend failed to start');
    process.exit(1);
  }
}

await main();
