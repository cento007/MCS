import type { Db } from '@mc/shared';
import { booleanValue, objectValue, readCategoryValues, timeOfDayValue } from './values.js';

/**
 * `notifications` settings (TDS 04 §7.2, PRD §4.4.3).
 *
 * Storage coordinates per the §7.6 derivation rule — nested objects are stored WHOLE as one
 * JSONB row with camelCase inner keys:
 *
 *   `notifications.events`      -> `('notifications', 'events')`, object
 *   `notifications.dailyReport` -> `('notifications', 'daily_report')`, object
 *
 * Two Phase 1 read models consume this category and nothing else does yet: `GET /spend` reads
 * `events.costBudgetAlert` for `budget.alertsEnabled` (§7.8), and `GET /schedule` reads
 * `dailyReport` for the `daily_report` row (§7.7).
 */

/** WS5 §5.7.8 renders every event toggle checked. */
const DEFAULT_EVENT_ENABLED = true;

/** WS5 §5.7.8 renders "Daily report deliver at [18:00]", enabled. */
export const DEFAULT_DAILY_REPORT_TIME = '18:00';

export const NOTIFICATION_SETTING_KEYS = Object.freeze({
  events: 'events',
  dailyReport: 'daily_report',
  quietHours: 'quiet_hours',
} as const);

export interface NotificationEventToggles {
  readonly sessionComplete: boolean;
  readonly sessionFailed: boolean;
  readonly syncFailed: boolean;
  readonly repositoryProblem: boolean;
  readonly costBudgetAlert: boolean;
}

export interface DailyReportSettings {
  readonly enabled: boolean;
  /** `"HH:mm"` in `general.timezone` (§7.2). */
  readonly time: string;
}

export interface NotificationsSettings {
  readonly events: NotificationEventToggles;
  readonly dailyReport: DailyReportSettings;
}

export function parseNotificationsSettings(
  values: ReadonlyMap<string, unknown>,
): NotificationsSettings {
  const events = objectValue(values.get(NOTIFICATION_SETTING_KEYS.events)) ?? {};
  const dailyReport = objectValue(values.get(NOTIFICATION_SETTING_KEYS.dailyReport)) ?? {};

  return {
    events: {
      sessionComplete: booleanValue(events['sessionComplete'], DEFAULT_EVENT_ENABLED),
      sessionFailed: booleanValue(events['sessionFailed'], DEFAULT_EVENT_ENABLED),
      syncFailed: booleanValue(events['syncFailed'], DEFAULT_EVENT_ENABLED),
      repositoryProblem: booleanValue(events['repositoryProblem'], DEFAULT_EVENT_ENABLED),
      costBudgetAlert: booleanValue(events['costBudgetAlert'], DEFAULT_EVENT_ENABLED),
    },
    dailyReport: {
      enabled: booleanValue(dailyReport['enabled'], DEFAULT_EVENT_ENABLED),
      time: timeOfDayValue(dailyReport['time'], DEFAULT_DAILY_REPORT_TIME),
    },
  };
}

export async function readNotificationsSettings(db: Db): Promise<NotificationsSettings> {
  return parseNotificationsSettings(await readCategoryValues(db, 'notifications'));
}
