import { type Logger, pino } from 'pino';
import type { AppConfig, LogLevel } from '../config/index.js';
import type { EventSource } from '../events/index.js';

export type { Logger };

/**
 * pino factory (TDS 02 §2.1, §9.4).
 *
 * JSON to stdout ONLY — no app-managed log files, no log directory in `MC_DATA_DIR`.
 * Production capture is journald per systemd unit; development is the console. Every log
 * line carries a correlation key: `requestId` (HTTP, matching the F5.4 error envelope),
 * `sessionId` (wrapper paths), or the job id (workers).
 */
export interface LoggerOptions {
  /** Which process is logging — same vocabulary as the F6 envelope `source`. */
  readonly service: EventSource;
  readonly level?: LogLevel;
  /** Pretty-print is deliberately NOT wired: stdout stays machine-readable everywhere. */
  readonly base?: Record<string, unknown>;
}

export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level ?? 'info',
    base: { service: options.service, ...options.base },
    // ISO 8601 UTC with Z, matching the F4.2 wire format for timestamps.
    timestamp: () => `,"time":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      // Defence in depth: bootstrap secrets and auth material must never reach stdout.
      paths: [
        'encryptionKey',
        'password',
        'token',
        'secret',
        '*.encryptionKey',
        '*.password',
        '*.token',
        '*.secret',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[redacted]',
    },
  });
}

/** Convenience overload for process entry points that already loaded config. */
export function createLoggerFromConfig(service: EventSource, config: AppConfig): Logger {
  return createLogger({ service, level: config.logLevel });
}
