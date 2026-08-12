import process from 'node:process';
import { createLoggerFromConfig, createShutdownController, loadConfigOrExit } from '@mc/shared';
import { buildAppWithServices } from './app.js';
import { createDatabase } from './db/index.js';
import { createBackendQueue } from './queue/index.js';
// Imported from the adapter module directly, never through `sessions/`'s barrel: this is the
// one import of `@anthropic-ai/claude-agent-sdk` in the process, and routing it through a
// barrel would load the SDK into every unit test that touches the Session domain.
import { createClaudeAgentRuntime } from './sessions/managed/claude-agent-runtime.js';
import { recoverManagedSessions } from './sessions/managed/index.js';
import { readClaudeCodeLaunchSettings, readMaxConcurrentSessions } from './settings/claude-code.js';

/**
 * Backend process entry (TDS 02 §2).
 *
 * Process contract (F8.1): starts in the foreground, logs JSON to stdout, exits nonzero on
 * a fatal error. Identical behaviour under a Windows dev console and under a systemd unit;
 * no process-manager knowledge lives in application code.
 *
 * Startup order (TDS 03 §7.1), and it is not negotiable: config -> DB pool -> drizzle-kit
 * migrations (the Backend is the sole migration runner) -> `boss.start()` (pg-boss migrates
 * its own vendored `pgboss` schema) -> subscribe consumers -> accept work.
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const log = createLoggerFromConfig('backend', config);

  const database = createDatabase({ connectionString: config.databaseUrl });
  const shutdown = createShutdownController({ logger: log });

  const queue = createBackendQueue({
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

  const maxConcurrentSessions = await readMaxConcurrentSessions(database.db);
  const claudeCode = await readClaudeCodeLaunchSettings(database.db);

  const { app, sessions } = buildAppWithServices({
    config,
    db: database.db,
    queue,
    maxConcurrentSessions,
    // The managed Claude Code wrapper (F1.5). This is the one place the Agent SDK enters the
    // process graph; every test substitutes the WS6 §5.2 mock at this same seam.
    agentRuntime: createClaudeAgentRuntime({
      cliPath: claudeCode.cliPath,
      defaultModel: claudeCode.defaultModel,
      onStderr: (data, sessionId) => {
        log.warn({ sessionId, stderr: data.slice(0, 2000) }, 'claude runtime stderr');
      },
    }),
  });

  // BEFORE anything can launch: every SDK child died with the previous process, so a Session
  // still marked `running` is an orphan (TDS 02 §4.4). Running this after the launch consumer
  // subscribes would race a queued launch against its own recovery.
  const recovery = await recoverManagedSessions({
    db: database.db,
    stateMachine: sessions.stateMachine,
    onError: (error, sessionId) => {
      log.error({ err: error, sessionId }, 'restart recovery failed for session');
    },
  });
  if (recovery.orphaned.length > 0) {
    log.warn(
      { orphaned: recovery.orphaned.length, failed: recovery.failed.length },
      'marked sessions orphaned by a backend restart as failed',
    );
  }

  // The launch consumer and the slot-release listener. Registered before `listen` so a queued
  // launch left over from a previous run is picked up as soon as the process is healthy.
  await sessions.registry.start();
  // The rate-limit retry consumer (TDS 02 §4.3).
  await sessions.managed?.start();

  // Hooks run in REVERSE registration order, so the pool is registered first and drained
  // last — nothing can still be querying it once the HTTP server has closed.
  shutdown.onShutdown('database-pool', async () => {
    await database.close();
  });
  shutdown.onShutdown('queue', async () => {
    await queue.stop();
  });
  shutdown.onShutdown('session-registry', async () => {
    await sessions.registry.stop();
  });
  shutdown.onShutdown('http-server', async () => {
    await app.close();
  });

  try {
    await app.listen({ host: config.host, port: config.port });
    log.info(
      {
        host: config.host,
        port: config.port,
        dataDir: config.dataDir,
        env: config.nodeEnv,
        maxConcurrentSessions,
      },
      'backend listening',
    );
  } catch (error) {
    log.fatal({ err: error }, 'backend failed to start');
    process.exit(1);
  }
}

await main();
