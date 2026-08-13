import process from 'node:process';
import {
  createLoggerFromConfig,
  createShutdownController,
  loadConfigOrExit,
  readMemoryPolicy,
} from '@mc/shared';
import { buildAppWithServices } from './app.js';
import { createDatabase } from './db/index.js';
import { describeRetention, verifyMemoryAtStartup } from './memory/index.js';
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

  const { app, sessions, github, memory } = buildAppWithServices({
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

  // The `repository.sync` consumer and the self-rescheduling `github.poll` chain (TDS 02 §2).
  // After the Session consumers because it is the lower-priority producer, and before `listen`
  // so a tick left over from the previous run is picked up as soon as the process is healthy.
  await github.start();

  // Phase 3 memory (PRD §6): identify the embedding model, then create or verify the stamped
  // Qdrant collection.
  //
  // **Deliberately not awaited into the startup critical path, and deliberately never fatal.**
  // Two reasons, and both are about what an operator loses when it fails. Awaiting it would put
  // an optional local service — one that may be stopped, or configured against a model that is
  // not pulled — between a restart and the moment sessions can be launched again; and treating
  // a failure as fatal would take out session management to protect a search box that does not
  // exist yet. It logs, the Services panel reports the same facts, and the Backend serves.
  void verifyMemoryAtStartup(memory, log).catch((error: unknown) => {
    // `verifyMemoryAtStartup` does not throw. This is the arm that holds if that ever changes.
    log.error({ err: error }, 'memory startup verification failed unexpectedly');
  });

  // The single `memory.index` consumer (arbitration A16), its domain-event triggers, and the
  // reclamation of any backfill run a previous process left `running`. Awaited, unlike the
  // verification above, because it only subscribes and reclaims — it makes no outbound call and
  // does no work until a job arrives, which cannot happen before a model is configured.
  await memory.indexing.start();

  // The `memory.retention` chain (PRD §4.4 item 4). `start()` subscribes the tick consumer and
  // primes a tick **only if some tier actually expires** — every tier defaults to `0` (never),
  // so a default install schedules nothing at all. Turning retention on from Settings re-primes
  // the chain through `setting.updated`, exactly as the GitHub poller is re-primed.
  await memory.retention.start();
  // Logged because retention is the one part of this subsystem whose absence looks exactly like
  // its presence: "why has nothing expired" and "why did my session memory disappear" have the
  // same answer, and it is not visible anywhere else.
  log.info(
    { retention: describeRetention(await readMemoryPolicy(database.db)) },
    'memory retention policy',
  );

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
  shutdown.onShutdown('github', async () => {
    await github.stop();
  });
  shutdown.onShutdown('memory-indexing', async () => {
    memory.indexing.stop();
    await memory.retention.stop();
  });
  shutdown.onShutdown('http-server', async () => {
    await app.close();
  });

  await listenWithRetry(app, config, log, { dataDir: config.dataDir, maxConcurrentSessions });
}

/**
 * Bind the HTTP port, tolerating the brief window where a previous process still holds it.
 *
 * `tsx watch` starts the replacement as soon as a source file changes, and on Windows the
 * outgoing process's listening socket can outlive it by a second or two. A single `listen`
 * attempt therefore loses the race and — because the failure was fatal — the dev server
 * stayed down until someone noticed. Observed: one edit to `http/index.ts` killed the backend
 * for twenty minutes; every later edit re-ran the same doomed bind, and the only visible
 * symptom in the browser was `MALFORMED_RESPONSE`, because Vite proxies a dead upstream as an
 * empty 500 that no client can parse as an F5.4 envelope.
 *
 * Retrying is scoped to development on purpose. In production a busy port means another
 * instance is already serving — silently waiting for it to disappear would be worse than
 * failing loudly, so there the first `EADDRINUSE` is still fatal.
 */
async function listenWithRetry(
  app: ReturnType<typeof buildAppWithServices>['app'],
  config: { host: string; port: number; nodeEnv: string },
  log: {
    info: (o: object, m: string) => void;
    warn: (o: object, m: string) => void;
    fatal: (o: object, m: string) => void;
  },
  extra: Record<string, unknown>,
): Promise<void> {
  const retryable = config.nodeEnv === 'development';
  const attempts = retryable ? 10 : 1;
  const delayMs = 500;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await app.listen({ host: config.host, port: config.port });
      log.info(
        { host: config.host, port: config.port, env: config.nodeEnv, ...extra },
        'backend listening',
      );
      return;
    } catch (error) {
      const busy = (error as NodeJS.ErrnoException).code === 'EADDRINUSE';
      if (!busy || attempt === attempts) {
        log.fatal({ err: error, attempt }, 'backend failed to start');
        process.exit(1);
      }
      log.warn(
        { port: config.port, attempt, attempts },
        'port still held by the previous process, retrying',
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

await main();
