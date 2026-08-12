import type { Db } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../http/errors.js';
import { type CostBudget, readCostBudget } from '../settings/claude-code.js';
import { DEFAULT_TIMEZONE, readTimezone } from '../settings/general.js';
import { readNotificationsSettings } from '../settings/notifications.js';
import { isInvalidTimezoneError, readSpendAggregate } from './aggregate.js';
import { type DayStatus, deriveDayStatus } from './status.js';

/**
 * `GET /api/v1/spend` — the bounded spend read model (TDS 04 §7.8).
 *
 * Four surfaces state the same number and must never disagree: the Dashboard Spend widget, the
 * shell top-bar chip, the Needs Attention budget row, and the current-spend line in Settings →
 * Claude Code. `Session.costUsd` is per-Session and `GET /sessions` is cursor-paginated, so
 * without this endpoint a client would walk every page of every day to add up one number.
 *
 * Fixed shape, no pagination, **no `meta`** (§1.2 fixed read model). Read-only: no POST/PATCH,
 * no persistence, no event.
 *
 * **Caching: none, deliberately** (§7.8). The month aggregate is a bounded index-only scan; a
 * TTL would buy microseconds and cost correctness at the two moments the number matters most —
 * immediately after a Session completes, and at local midnight, which is precisely where a
 * cache keyed on the wrong clock produces a confidently stale number.
 *
 * **Not an alerting path.** The `cost_budget_alert` Notification stays the Backend's threshold
 * evaluation on `session.completed`; a read of this endpoint raises nothing.
 */

export * from './aggregate.js';
export * from './status.js';

export interface SpendPeriodResource {
  /** ISO 8601 UTC, inclusive. */
  readonly periodStart: string;
  /** ISO 8601 UTC, exclusive. */
  readonly periodEnd: string;
  readonly totalCostUsd: number;
  readonly sessionCount: number;
}

export interface SpendResource {
  /** The IANA name actually used — `general.timezone`, or `'UTC'` when unset/unparseable. */
  readonly timezone: string;
  readonly generatedAt: string;
  readonly day: SpendPeriodResource;
  readonly month: SpendPeriodResource;
  readonly budget: {
    readonly dailyUsd: number | null;
    readonly perSessionUsd: number | null;
    readonly alertThresholdPercent: number;
    readonly alertsEnabled: boolean;
  };
  readonly dayStatus: DayStatus;
}

export interface SpendServiceOptions {
  readonly db: Db;
  readonly now?: () => Date;
  /** Reported when a stored zone reaches PostgreSQL and is rejected there. */
  readonly onTimezoneRejected?: (timezone: string, error: unknown) => void;
}

export class SpendService {
  readonly #db: Db;
  readonly #now: () => Date;
  readonly #onTimezoneRejected: ((timezone: string, error: unknown) => void) | undefined;

  constructor(options: SpendServiceOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#onTimezoneRejected = options.onTimezoneRejected;
  }

  async read(): Promise<SpendResource> {
    const [configured, budget, notifications] = await Promise.all([
      readTimezone(this.#db),
      readCostBudget(this.#db),
      readNotificationsSettings(this.#db),
    ]);

    const { timezone, aggregate } = await this.#aggregate(configured);

    const dayStatus = deriveDayStatus(aggregate.day.totalCostUsd, budget);

    return {
      timezone,
      generatedAt: this.#now().toISOString(),
      day: serializePeriod(aggregate.day),
      month: serializePeriod(aggregate.month),
      budget: serializeBudget(budget, notifications.events.costBudgetAlert),
      dayStatus,
    };
  }

  /**
   * `general.timezone` is validated through `Intl` before it gets here, but ICU and
   * PostgreSQL keep separate zone databases — so a name this process accepts can still be
   * rejected by the server. §7.8 says the endpoint neither fails nor silently adopts the host
   * zone: it falls back to UTC and *reports* UTC.
   */
  async #aggregate(
    configured: string,
  ): Promise<{ timezone: string; aggregate: Awaited<ReturnType<typeof readSpendAggregate>> }> {
    try {
      return { timezone: configured, aggregate: await readSpendAggregate(this.#db, configured) };
    } catch (error) {
      if (!isInvalidTimezoneError(error) || configured === DEFAULT_TIMEZONE) throw error;
      this.#onTimezoneRejected?.(configured, error);
      return {
        timezone: DEFAULT_TIMEZONE,
        aggregate: await readSpendAggregate(this.#db, DEFAULT_TIMEZONE),
      };
    }
  }
}

function serializePeriod(period: {
  periodStart: Date;
  periodEnd: Date;
  totalCostUsd: number;
  sessionCount: number;
}): SpendPeriodResource {
  return {
    // Echoed as UTC instants so no client recomputes a boundary from the browser clock.
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    totalCostUsd: period.totalCostUsd,
    sessionCount: period.sessionCount,
  };
}

function serializeBudget(budget: CostBudget, alertsEnabled: boolean): SpendResource['budget'] {
  return {
    dailyUsd: budget.dailyUsd,
    perSessionUsd: budget.perSessionUsd,
    alertThresholdPercent: budget.alertThresholdPercent,
    // `alertsEnabled: false` hides the top-bar chip (WS5 §3.1); the numbers are still
    // returned. Spend is never withheld because no limit was set or alerting is off.
    alertsEnabled,
  };
}

export interface RegisterSpendOptions {
  readonly db: Db;
  readonly now?: () => Date;
  readonly onTimezoneRejected?: (timezone: string, error: unknown) => void;
}

export function registerSpend(app: FastifyInstance, options: RegisterSpendOptions): SpendService {
  const service = new SpendService({
    db: options.db,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.onTimezoneRejected === undefined
      ? {}
      : { onTimezoneRejected: options.onTimezoneRejected }),
  });

  app.get('/api/v1/spend', async () => dataEnvelope(await service.read()));

  return service;
}
