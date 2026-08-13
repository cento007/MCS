import type {
  NotificationSeverity,
  NotificationType,
  TelegramDeliveryStatus,
} from '../entities/notification.js';
import type { EventType } from '../events/types.js';
import type { NotificationEventToggles } from '../settings/types.js';

/**
 * The Notification production policy — pure, and shared because **both** processes produce
 * Notifications: the Backend from its own domain events (TDS 04 §15.2 rows 6, 7, 15, and the
 * cost-budget note), the Telegram Worker from its daily-report tick (TDS 02 §2.2). Two copies
 * of "is this event notification-worthy, and may it go to Telegram right now" would drift, and
 * the copy that drifted would be discovered by an operator who stopped getting alerts.
 *
 * Nothing here touches a database or a clock: everything is a function of already-read
 * settings plus an already-evaluated quiet-hours window.
 */

// ------------------------------------------------------------------- type ↔ event ↔ toggle

/**
 * The F6 event types that become Notifications (TDS 04 §15.2 "Notif." column).
 *
 * `daily_report` and `cost_budget_alert` are deliberately absent: they have **no** originating
 * event (a scheduled job and a threshold evaluation respectively), which is exactly why
 * `notifications.type` is its own enum and not an event name (arbitration A8 / finding B10).
 */
export const NOTIFICATION_EVENT_TYPES: Readonly<Record<string, NotificationType>> = Object.freeze({
  'session.completed': 'session_completed',
  'session.failed': 'session_failed',
  'repository.sync_failed': 'repository_problem',
  'sync.failed': 'sync_failed',
});

export function notificationTypeForEvent(type: EventType | string): NotificationType | null {
  return NOTIFICATION_EVENT_TYPES[type] ?? null;
}

/**
 * Which `notifications.events` toggle governs each notification type (PRD §4.4.3).
 *
 * `daily_report` maps to `null` because it is governed by its own setting
 * (`notifications.dailyReport.enabled`), not by an event toggle — §7.7's schedule row reads
 * that same field, so the two cannot disagree about whether a report is due.
 */
export const NOTIFICATION_TYPE_TOGGLES: Readonly<
  Record<NotificationType, keyof NotificationEventToggles | null>
> = Object.freeze({
  session_completed: 'sessionComplete',
  session_failed: 'sessionFailed',
  sync_failed: 'syncFailed',
  repository_problem: 'repositoryProblem',
  cost_budget_alert: 'costBudgetAlert',
  daily_report: null,
});

/**
 * Severity per type. A failed Session and a failed sync are `error` because something the
 * operator asked for did not happen; a repository problem is `warning` because tracking
 * degraded but nothing the operator started was lost; a budget alert is `warning` because it
 * is a threshold crossing, not a failure.
 */
export const NOTIFICATION_TYPE_SEVERITIES: Readonly<
  Record<NotificationType, NotificationSeverity>
> = Object.freeze({
  session_completed: 'info',
  session_failed: 'error',
  sync_failed: 'error',
  repository_problem: 'warning',
  cost_budget_alert: 'warning',
  daily_report: 'info',
});

export function isEventToggleEnabled(
  type: NotificationType,
  toggles: NotificationEventToggles,
): boolean {
  const toggle = NOTIFICATION_TYPE_TOGGLES[type];
  return toggle === null ? true : toggles[toggle];
}

// --------------------------------------------------------------------------- the decision

/** Why a Notification will not reach Telegram. Recorded in `telegram_error`, never invented. */
export type TelegramSkipReason =
  | 'telegram_disabled'
  | 'bot_token_missing'
  | 'chat_id_missing'
  | null;

export interface TelegramConfiguration {
  /** `integrations.telegram.enabled` — the master switch (PRD §4.4.3). */
  readonly enabled: boolean;
  /** `secret_items` presence only. The token itself never reaches this module. */
  readonly botTokenIsSet: boolean;
  readonly chatIdIsSet: boolean;
}

/** The already-evaluated quiet-hours window (see `quiet-hours.ts`). */
export interface QuietHoursWindow {
  readonly active: boolean;
  /** The instant the window ends. `null` when the window is not active. */
  readonly resumeAt: Date | null;
}

export interface NotificationDecisionInput {
  readonly type: NotificationType;
  readonly toggles: NotificationEventToggles;
  readonly telegram: TelegramConfiguration;
  readonly quietHours: QuietHoursWindow;
}

export interface NotificationDecision {
  /**
   * Write the `notifications` row at all.
   *
   * `false` **only** when the per-event toggle is off. That is a deliberate reading of
   * PRD §4.4.3: `notifications.events` decides whether an event is notification-worthy, and
   * the `notifications` row *is* the in-app notification (§8 — `readAt` is its only UI state).
   * An operator who unticked "Session complete" does not want it in the unread badge either.
   *
   * The master switch behaves differently on purpose: `integrations.telegram.enabled` names a
   * *channel*, so turning it off leaves the in-app record and marks the channel `skipped` —
   * which is TDS 04 §8's own reading of `skipped` ("Telegram is disabled").
   */
  readonly create: boolean;
  readonly severity: NotificationSeverity;
  readonly telegramStatus: TelegramDeliveryStatus;
  /** Enqueue a `notification.deliver` job. False whenever `telegramStatus` is terminal. */
  readonly dispatch: boolean;
  /** Non-null when delivery is deferred past a quiet-hours window. */
  readonly deferUntil: Date | null;
  readonly skipReason: TelegramSkipReason;
  /** Operator-facing sentence for `telegram_error`; `null` when nothing was skipped. */
  readonly skipMessage: string | null;
}

const SKIP_MESSAGES: Readonly<Record<Exclude<TelegramSkipReason, null>, string>> = Object.freeze({
  telegram_disabled:
    'Telegram delivery is switched off in Settings → Integrations → Telegram. The notification was kept in Mission Control only.',
  bot_token_missing:
    'No Telegram bot token is saved. Add one in Settings → Integrations → Telegram, then re-run the action.',
  chat_id_missing:
    'No Telegram chat ID is saved. Add one in Settings → Integrations → Telegram, then re-run the action.',
});

export function telegramSkipMessage(reason: Exclude<TelegramSkipReason, null>): string {
  return SKIP_MESSAGES[reason];
}

/**
 * Decide, for one prospective Notification, whether it exists and where it goes.
 *
 * **Quiet hours defer, they do not suppress** (see `quiet-hours.ts` for the full argument):
 * an alert raised at 02:00 is still delivered, at the end of the window, and the record says
 * so. A missing configuration is terminal `skipped` rather than `pending`, because a delivery
 * with nowhere to go is not pending — it is finished, and telling an operator otherwise is how
 * a queue grows a permanent backlog nobody can drain.
 */
export function decideNotification(input: NotificationDecisionInput): NotificationDecision {
  const severity = NOTIFICATION_TYPE_SEVERITIES[input.type];

  if (!isEventToggleEnabled(input.type, input.toggles)) {
    return {
      create: false,
      severity,
      telegramStatus: 'skipped',
      dispatch: false,
      deferUntil: null,
      skipReason: null,
      skipMessage: null,
    };
  }

  const skipReason = telegramSkipReason(input.telegram);
  if (skipReason !== null) {
    return {
      create: true,
      severity,
      telegramStatus: 'skipped',
      dispatch: false,
      deferUntil: null,
      skipReason,
      skipMessage: telegramSkipMessage(skipReason),
    };
  }

  const deferUntil = input.quietHours.active ? input.quietHours.resumeAt : null;

  return {
    create: true,
    severity,
    telegramStatus: 'pending',
    dispatch: true,
    deferUntil,
    skipReason: null,
    skipMessage: null,
  };
}

function telegramSkipReason(telegram: TelegramConfiguration): TelegramSkipReason {
  if (!telegram.enabled) return 'telegram_disabled';
  if (!telegram.botTokenIsSet) return 'bot_token_missing';
  if (!telegram.chatIdIsSet) return 'chat_id_missing';
  return null;
}

// ------------------------------------------------------------------------ delivery backoff

/**
 * Attempts one Notification's Telegram delivery gets before it is recorded as `failed`.
 *
 * Bounded, and the bound is the point: a bad token or a deleted chat never becomes deliverable,
 * and an unbounded retry against `api.telegram.org` is how a home server earns a rate-limit ban
 * on top of the fault it already had. Only *retriable* outcomes consume an attempt — a `401`
 * settles on the first try.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;

/** Ceiling for any single backoff, including one Telegram asked for. Five minutes. */
export const MAX_DELIVERY_BACKOFF_SECONDS = 300;

const BASE_DELIVERY_BACKOFF_SECONDS = 5;

/**
 * How long to wait before delivery attempt `attempt + 1`.
 *
 * `retryAfterSeconds` is Telegram's own `parameters.retry_after` from a `429`; when it is
 * present it **wins**, because it is the only number in the exchange that reflects the actual
 * limit rather than our guess at one. Everything else is exponential from 5 s, capped, so a
 * transient network fault settles quickly and a persistent one stops bothering the API.
 */
export function deliveryBackoffSeconds(attempt: number, retryAfterSeconds?: number | null): number {
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) {
    return clampBackoff(Math.ceil(retryAfterSeconds));
  }
  const exponential = BASE_DELIVERY_BACKOFF_SECONDS * 2 ** Math.max(0, attempt - 1);
  return clampBackoff(exponential);
}

function clampBackoff(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds < 1) return 1;
  return Math.min(MAX_DELIVERY_BACKOFF_SECONDS, Math.floor(seconds));
}
