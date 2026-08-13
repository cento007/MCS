import {
  type DailyReportSettings,
  type Db,
  DEFAULT_DAILY_REPORT,
  type NotificationEventToggles,
  normalizeSetting,
  type QuietHoursSettings,
  settingKey,
} from '@mc/shared';
import { readCategoryValues } from './values.js';

/**
 * `notifications` settings (TDS 04 §7.2, PRD §4.4.3) — the internal read path.
 *
 * Storage coordinates per the §7.6 derivation rule — nested objects are stored WHOLE as one
 * JSONB row with camelCase inner keys:
 *
 *   `notifications.events`      -> `('notifications', 'events')`, object
 *   `notifications.dailyReport` -> `('notifications', 'daily_report')`, object
 *   `notifications.quietHours`  -> `('notifications', 'quiet_hours')`, object
 *
 * Two Phase 1 read models consume this category: `GET /spend` reads `events.costBudgetAlert`
 * for `budget.alertsEnabled` (§7.8), and `GET /schedule` reads `dailyReport` for the
 * `daily_report` row (§7.7). Phase 2 adds the Notification producer, which reads all three:
 * `events` decides whether a Notification exists at all, `quietHours` decides whether its
 * Telegram delivery is deferred (see `notifications/produce.ts`).
 */

export type { DailyReportSettings, NotificationEventToggles, QuietHoursSettings };

/** WS5 §5.7.8 renders "Daily report deliver at [18:00]", enabled. */
export const DEFAULT_DAILY_REPORT_TIME = DEFAULT_DAILY_REPORT.time;

export const NOTIFICATION_SETTING_KEYS = Object.freeze({
  events: settingKey('notifications.events'),
  dailyReport: settingKey('notifications.dailyReport'),
  quietHours: settingKey('notifications.quietHours'),
} as const);

export interface NotificationsSettings {
  readonly events: NotificationEventToggles;
  readonly dailyReport: DailyReportSettings;
  readonly quietHours: QuietHoursSettings;
}

export function parseNotificationsSettings(
  values: ReadonlyMap<string, unknown>,
): NotificationsSettings {
  return {
    events: normalizeSetting<NotificationEventToggles>(
      'notifications.events',
      values.get(NOTIFICATION_SETTING_KEYS.events),
    ),
    dailyReport: normalizeSetting<DailyReportSettings>(
      'notifications.dailyReport',
      values.get(NOTIFICATION_SETTING_KEYS.dailyReport),
    ),
    quietHours: normalizeSetting<QuietHoursSettings>(
      'notifications.quietHours',
      values.get(NOTIFICATION_SETTING_KEYS.quietHours),
    ),
  };
}

export async function readNotificationsSettings(db: Db): Promise<NotificationsSettings> {
  return parseNotificationsSettings(await readCategoryValues(db, 'notifications'));
}
