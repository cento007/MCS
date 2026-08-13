import process from 'node:process';
import type { Logger } from 'pino';
import type { EventSource } from '../events/index.js';

/**
 * Worker heartbeat (TDS 02 §7.2).
 *
 * Workers expose no HTTP port, so the Services health view derives their status from the
 * age of one upserted row: `healthy` < 90 s, `stale` 90 s–5 min, `down` beyond that.
 * The interval is 30 s — three ticks inside the healthy window.
 *
 * The sink is pluggable and defaults to a LOG-ONLY sink so a process can start with no
 * database. The real one is `createDatabaseHeartbeatSink` next door, which upserts into
 * `service_heartbeats` (TDS 03 §4.4); each worker's composition root supplies it.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const HEARTBEAT_HEALTHY_MS = 90_000;
export const HEARTBEAT_STALE_MS = 300_000;

export interface HeartbeatSample {
  readonly service: EventSource;
  readonly pid: number;
  readonly version: string;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
  /** Small counters (jobs processed/failed since start) — never payload data. */
  readonly stats: Readonly<Record<string, number>>;
}

export type HeartbeatSink = (sample: HeartbeatSample) => Promise<void> | void;

export interface HeartbeatOptions {
  readonly service: EventSource;
  readonly version: string;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly sink?: HeartbeatSink;
  readonly stats?: () => Readonly<Record<string, number>>;
}

export interface Heartbeat {
  start(): void;
  stop(): void;
  /** Emit one sample immediately (used at startup and by tests). */
  beat(): Promise<void>;
}

/** Derived status for the Services health view (TDS 02 §7.2). */
export function heartbeatStatus(ageMs: number): 'healthy' | 'stale' | 'down' {
  if (ageMs < HEARTBEAT_HEALTHY_MS) return 'healthy';
  if (ageMs < HEARTBEAT_STALE_MS) return 'stale';
  return 'down';
}

export function createHeartbeat(options: HeartbeatOptions): Heartbeat {
  const { service, version, logger } = options;
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const startedAt = new Date();

  const sink: HeartbeatSink =
    options.sink ??
    ((sample) => {
      // Log-only: no database was wired at this composition root, so the Services panel will
      // show this worker as `disabled` ("not deployed") however healthy the process actually is.
      logger.debug(
        { heartbeat: { service: sample.service, pid: sample.pid, stats: sample.stats } },
        'heartbeat intent (no sink configured — service_heartbeats not written)',
      );
    });

  let timer: NodeJS.Timeout | null = null;

  const beat = async (): Promise<void> => {
    try {
      await sink({
        service,
        pid: process.pid,
        version,
        startedAt,
        heartbeatAt: new Date(),
        stats: options.stats?.() ?? {},
      });
    } catch (error) {
      logger.warn({ err: error }, 'heartbeat write failed');
    }
  };

  return {
    start() {
      if (timer !== null) return;
      timer = setInterval(() => void beat(), intervalMs);
      // Never hold the event loop open on account of the heartbeat.
      timer.unref();
    },
    stop() {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
    beat,
  };
}
