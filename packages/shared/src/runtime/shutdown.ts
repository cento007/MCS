import process from 'node:process';
import type { Logger } from 'pino';

/**
 * Graceful shutdown for every Mission Control process (F8.1: "starts in foreground, logs
 * to stdout, exits nonzero on fatal — works identically under a console or systemd").
 *
 * BOTH signals are wired on purpose (TDS 07 §7.2): Ubuntu/systemd sends SIGTERM, while on
 * Windows a console Ctrl-C arrives as SIGINT and there is no true SIGTERM delivery. A
 * handler wired to only one of them is a dev/prod parity bug, not a portability nicety.
 */
export const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

export type ShutdownHook = () => Promise<void> | void;

/**
 * Minimal signal-source shape. Defaults to `process`; injectable so the wiring itself can
 * be unit-tested without emitting real signals into the test runner (which has its own
 * SIGINT handler).
 */
export interface SignalTarget {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface ShutdownOptions {
  readonly logger: Logger;
  /** Hard-exit deadline. Past this the process exits nonzero regardless. */
  readonly timeoutMs?: number;
  readonly signalTarget?: SignalTarget;
}

export interface ShutdownController {
  /** Hooks run in reverse registration order (last registered, first torn down). */
  onShutdown(name: string, hook: ShutdownHook): void;
  /** Idempotent: a second signal while draining is ignored. */
  shutdown(reason: string): Promise<void>;
  /** Detach the signal listeners — used by tests so handlers do not leak between cases. */
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createShutdownController(options: ShutdownOptions): ShutdownController {
  const { logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const hooks: { name: string; hook: ShutdownHook }[] = [];

  let draining = false;

  const shutdown = async (reason: string): Promise<void> => {
    if (draining) return;
    draining = true;

    logger.info({ reason }, 'shutdown requested');

    const deadline = setTimeout(() => {
      logger.error({ reason, timeoutMs }, 'shutdown timed out — forcing exit');
      process.exit(1);
    }, timeoutMs);
    deadline.unref();

    for (const { name, hook } of [...hooks].reverse()) {
      try {
        await hook();
        logger.debug({ hook: name }, 'shutdown hook complete');
      } catch (error) {
        logger.error({ hook: name, err: error }, 'shutdown hook failed');
      }
    }

    clearTimeout(deadline);
    logger.info({ reason }, 'shutdown complete');
  };

  const signalTarget: SignalTarget = options.signalTarget ?? process;
  const listeners = new Map<ShutdownSignal, () => void>();
  for (const signal of SHUTDOWN_SIGNALS) {
    const listener = () => {
      void shutdown(signal);
    };
    listeners.set(signal, listener);
    signalTarget.on(signal, listener);
  }

  return {
    onShutdown(name, hook) {
      hooks.push({ name, hook });
    },
    shutdown,
    dispose() {
      for (const [signal, listener] of listeners) signalTarget.off(signal, listener);
      listeners.clear();
    },
  };
}
