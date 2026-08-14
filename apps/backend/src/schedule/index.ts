import { type Db, type MemoryPolicy, readMemoryPolicy, retentionDisabled } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../http/errors.js';
import { DEFAULT_TIMEZONE, readTimezone } from '../settings/general.js';
import {
  readScheduleIntegrationSettings,
  type ScheduleIntegrationSettings,
} from '../settings/integrations.js';
import {
  type NotificationsSettings,
  readNotificationsSettings,
} from '../settings/notifications.js';
import { isInvalidTimezoneError } from '../spend/aggregate.js';
import { readNextDailyReportAt, readScheduleSources, type ScheduleSources } from './repository.js';
import { nextIntervalRunAt } from './rules.js';

/**
 * `GET /api/v1/schedule` — the computed schedule read model (TDS 04 §7.7, arbitration A1).
 *
 * Backs the Dashboard "Upcoming Tasks" widget. **No entity, no table, no worker, no event**:
 * every value is derived at read time from settings plus existing rows, and nothing here is
 * ever persisted. A1 settled this in WS5's favour precisely so no Task entity would be
 * invented — F4.1 is untouched, and none is implied.
 *
 * Fixed cardinality (four kinds), so no cursor pagination and no `meta` (§1.2). Read-only: there
 * is no POST/PATCH — the operator changes the schedule in Settings, and manual runs use the
 * existing action endpoints.
 *
 * Phase 2 kinds are returned from Phase 1 with `enabled: false` until their workers exist,
 * which is what makes the widget honest on day one rather than empty.
 *
 * ## The fourth kind, and the rule it was added under
 *
 * `memory_retention` is Phase 3's expiry sweep (`memory/retention.ts`). It is a **real
 * self-rescheduling chain** — the same species as `github.poll`, `obsidian.schedule` and
 * `notification.schedule`, all three of which this endpoint already reports — and it was the only
 * one of the four that was invisible. A recurring job that deletes an operator's memory on a timer
 * they cannot see is the same defect as a setting nothing reads, pointed the other way: the
 * schedule is real and the read model denied it existed.
 *
 * It is the one row whose `nextRunAt` comes from the queue rather than from an interval setting,
 * and that is not an inconsistency to iron out. The other three each have a domain artifact to
 * count from; a retention tick that deletes nothing writes nothing, and its interval is a constant
 * rather than a setting (`MEMORY_RETENTION_TICK_MINUTES`, deliberately not a knob). See
 * `readQueueTickTimes`.
 */

export * from './repository.js';
export * from './rules.js';

export const SCHEDULE_KINDS = [
  'obsidian_sync',
  'github_poll',
  'daily_report',
  'memory_retention',
] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export interface ScheduleEntry {
  readonly kind: ScheduleKind;
  readonly label: string;
  readonly enabled: boolean;
  /** ISO 8601 UTC; `null` when disabled or the interval is 0. */
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
}

const LABELS: Readonly<Record<ScheduleKind, string>> = {
  obsidian_sync: 'Obsidian vault sync',
  github_poll: 'GitHub repository poll',
  daily_report: 'Daily report',
  memory_retention: 'Memory retention sweep',
};

export interface ScheduleServiceOptions {
  readonly db: Db;
  readonly now?: () => Date;
}

export class ScheduleService {
  readonly #db: Db;
  readonly #now: () => Date;

  constructor(options: ScheduleServiceOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
  }

  async read(): Promise<readonly ScheduleEntry[]> {
    const [timezone, integrations, notifications, sources, memoryPolicy] = await Promise.all([
      readTimezone(this.#db),
      readScheduleIntegrationSettings(this.#db),
      readNotificationsSettings(this.#db),
      readScheduleSources(this.#db),
      readMemoryPolicy(this.#db),
    ]);

    const now = this.#now();

    return [
      obsidianEntry(integrations, sources, now),
      githubEntry(integrations, sources, now),
      await this.#dailyReportEntry(integrations, notifications, sources, timezone),
      memoryRetentionEntry(memoryPolicy, sources),
    ];
  }

  /**
   * The one row whose next run is a wall-clock time rather than an interval, so it is the one
   * row that needs the instance timezone. A zone PostgreSQL rejects falls back to UTC (§7.8's
   * rule, applied here for the same reason): reporting the report an hour off is better than
   * failing the whole widget, and silently adopting the host zone is what neither may do.
   */
  async #dailyReportEntry(
    integrations: ScheduleIntegrationSettings,
    notifications: NotificationsSettings,
    sources: ScheduleSources,
    timezone: string,
  ): Promise<ScheduleEntry> {
    const enabled = notifications.dailyReport.enabled && integrations.telegram.enabled;

    let nextRunAt: Date | null = null;
    if (enabled) {
      try {
        nextRunAt = await readNextDailyReportAt(this.#db, {
          timezone,
          time: notifications.dailyReport.time,
        });
      } catch (error) {
        if (!isInvalidTimezoneError(error) || timezone === DEFAULT_TIMEZONE) throw error;
        nextRunAt = await readNextDailyReportAt(this.#db, {
          timezone: DEFAULT_TIMEZONE,
          time: notifications.dailyReport.time,
        });
      }
    }

    return entry('daily_report', enabled, nextRunAt, sources.dailyReportLastRunAt);
  }
}

function obsidianEntry(
  integrations: ScheduleIntegrationSettings,
  sources: ScheduleSources,
  now: Date,
): ScheduleEntry {
  const { obsidian } = integrations;
  const enabled =
    obsidian.vaultPath !== null &&
    obsidian.syncMode !== 'paused' &&
    obsidian.syncIntervalMinutes > 0;

  return entry(
    'obsidian_sync',
    enabled,
    nextIntervalRunAt({
      enabled,
      intervalMinutes: obsidian.syncIntervalMinutes,
      lastRunAt: sources.obsidianLastRunAt,
      now,
    }),
    sources.obsidianLastRunAt,
  );
}

function githubEntry(
  integrations: ScheduleIntegrationSettings,
  sources: ScheduleSources,
  now: Date,
): ScheduleEntry {
  const { github } = integrations;
  const enabled = github.tokenIsSet && github.syncIntervalMinutes > 0;

  return entry(
    'github_poll',
    enabled,
    nextIntervalRunAt({
      enabled,
      intervalMinutes: github.syncIntervalMinutes,
      lastRunAt: sources.repositoriesLastSyncedAt,
      now,
    }),
    sources.repositoriesLastSyncedAt,
  );
}

/**
 * The Phase 3 expiry sweep (`memory/retention.ts`).
 *
 * **`enabled` is the policy, not the runtime.** It is true exactly when at least one tier has a
 * non-zero `retentionDays` — which is exactly when `MemoryRetentionScheduler.prime()` keeps a tick
 * queued. Every tier at `0` means nothing expires and the chain deliberately stops; that is the
 * off position of the only control an operator has here, and it lives in Settings → Memory.
 *
 * It is deliberately **not** conditioned on the memory runtime being reachable. A tick that finds
 * Ollama down postpones rather than skips (deleting rows whose vectors it cannot delete is the one
 * outcome worse than deleting nothing), so the sweep is still scheduled and still due. Reporting
 * `enabled: false` because Qdrant is asleep would answer a question the operator did not ask; the
 * Services panel is where reachability is reported, and it already is.
 *
 * `lastRunAt` can be `null` while `enabled` is true — pg-boss eventually deletes the completed
 * tick, and nothing else records a sweep. "Never run" is then a slightly weaker claim than the
 * other rows make, and it is the one the data supports.
 */
function memoryRetentionEntry(policy: MemoryPolicy, sources: ScheduleSources): ScheduleEntry {
  const enabled = !retentionDisabled(policy);
  return entry(
    'memory_retention',
    enabled,
    sources.memoryRetention.nextAt,
    sources.memoryRetention.lastRunAt,
  );
}

function entry(
  kind: ScheduleKind,
  enabled: boolean,
  nextRunAt: Date | null,
  lastRunAt: Date | null,
): ScheduleEntry {
  return {
    kind,
    label: LABELS[kind],
    enabled,
    nextRunAt: enabled ? (nextRunAt?.toISOString() ?? null) : null,
    lastRunAt: lastRunAt?.toISOString() ?? null,
  };
}

export interface RegisterScheduleOptions {
  readonly db: Db;
  readonly now?: () => Date;
}

export function registerSchedule(
  app: FastifyInstance,
  options: RegisterScheduleOptions,
): ScheduleService {
  const service = new ScheduleService({
    db: options.db,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  // §1.2: a fixed-cardinality read model returns `{ data: [...] }` with no `meta`.
  app.get('/api/v1/schedule', async () => dataEnvelope(await service.read()));

  return service;
}
