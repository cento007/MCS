import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPES } from '../entities/notification.js';
import { EVENT_TYPES } from '../events/types.js';
import { DEFAULT_EVENT_TOGGLES } from '../settings/registry.js';
import type { NotificationEventToggles } from '../settings/types.js';
import {
  decideNotification,
  deliveryBackoffSeconds,
  MAX_DELIVERY_ATTEMPTS,
  MAX_DELIVERY_BACKOFF_SECONDS,
  NOTIFICATION_EVENT_TYPES,
  NOTIFICATION_TYPE_SEVERITIES,
  NOTIFICATION_TYPE_TOGGLES,
  notificationTypeForEvent,
} from './policy.js';
import { QUIET_HOURS_INACTIVE } from './quiet-hours.js';

const configured = { enabled: true, botTokenIsSet: true, chatIdIsSet: true } as const;

function toggles(overrides: Partial<NotificationEventToggles> = {}): NotificationEventToggles {
  return { ...DEFAULT_EVENT_TOGGLES, ...overrides };
}

describe('event -> notification type mapping (TDS 04 §15.2)', () => {
  it('maps exactly the four events the catalog marks as notification-worthy', () => {
    expect(Object.keys(NOTIFICATION_EVENT_TYPES).sort()).toEqual([
      'repository.sync_failed',
      'session.completed',
      'session.failed',
      'sync.failed',
    ]);
  });

  it('only maps names that are real F6 event types', () => {
    for (const eventType of Object.keys(NOTIFICATION_EVENT_TYPES)) {
      expect(EVENT_TYPES).toContain(eventType);
    }
  });

  it('produces only values from the closed notification-type enum', () => {
    for (const type of Object.values(NOTIFICATION_EVENT_TYPES)) {
      expect(NOTIFICATION_TYPES).toContain(type);
    }
  });

  it('returns null for an event that is not notification-worthy', () => {
    expect(notificationTypeForEvent('session.created')).toBeNull();
    expect(notificationTypeForEvent('setting.updated')).toBeNull();
  });

  it('covers every notification type with a toggle and a severity', () => {
    for (const type of NOTIFICATION_TYPES) {
      expect(NOTIFICATION_TYPE_TOGGLES).toHaveProperty(type);
      expect(NOTIFICATION_TYPE_SEVERITIES[type]).toMatch(/^(info|warning|error)$/);
    }
  });

  it('leaves daily_report ungoverned by an event toggle — it has its own setting', () => {
    expect(NOTIFICATION_TYPE_TOGGLES.daily_report).toBeNull();
  });
});

describe('decideNotification', () => {
  it('creates a pending, dispatchable notification when everything is configured', () => {
    const decision = decideNotification({
      type: 'session_completed',
      toggles: toggles(),
      telegram: configured,
      quietHours: QUIET_HOURS_INACTIVE,
    });

    expect(decision).toMatchObject({
      create: true,
      telegramStatus: 'pending',
      dispatch: true,
      deferUntil: null,
      skipReason: null,
      skipMessage: null,
      severity: 'info',
    });
  });

  it('creates NOTHING when the per-event toggle is off', () => {
    const decision = decideNotification({
      type: 'session_completed',
      toggles: toggles({ sessionComplete: false }),
      telegram: configured,
      quietHours: QUIET_HOURS_INACTIVE,
    });

    expect(decision.create).toBe(false);
    expect(decision.dispatch).toBe(false);
  });

  it('is unaffected by an unrelated toggle', () => {
    const decision = decideNotification({
      type: 'session_failed',
      toggles: toggles({ sessionComplete: false }),
      telegram: configured,
      quietHours: QUIET_HOURS_INACTIVE,
    });

    expect(decision.create).toBe(true);
    expect(decision.severity).toBe('error');
  });

  it('keeps the in-app row but skips the channel when Telegram is disabled', () => {
    const decision = decideNotification({
      type: 'session_failed',
      toggles: toggles(),
      telegram: { ...configured, enabled: false },
      quietHours: QUIET_HOURS_INACTIVE,
    });

    expect(decision.create).toBe(true);
    expect(decision.telegramStatus).toBe('skipped');
    expect(decision.dispatch).toBe(false);
    expect(decision.skipReason).toBe('telegram_disabled');
    expect(decision.skipMessage).toContain('Settings');
  });

  it('reports a missing bot token as a terminal, actionable skip — never a retry', () => {
    const decision = decideNotification({
      type: 'session_failed',
      toggles: toggles(),
      telegram: { ...configured, botTokenIsSet: false },
      quietHours: QUIET_HOURS_INACTIVE,
    });

    expect(decision.telegramStatus).toBe('skipped');
    expect(decision.dispatch).toBe(false);
    expect(decision.skipReason).toBe('bot_token_missing');
  });

  it('reports a missing chat id separately from a missing token', () => {
    const decision = decideNotification({
      type: 'session_failed',
      toggles: toggles(),
      telegram: { ...configured, chatIdIsSet: false },
      quietHours: QUIET_HOURS_INACTIVE,
    });

    expect(decision.skipReason).toBe('chat_id_missing');
  });

  it('defers rather than suppresses inside quiet hours', () => {
    const resumeAt = new Date('2026-08-14T05:30:00.000Z');
    const decision = decideNotification({
      type: 'session_failed',
      toggles: toggles(),
      telegram: configured,
      quietHours: { active: true, resumeAt },
    });

    expect(decision.create).toBe(true);
    expect(decision.telegramStatus).toBe('pending');
    expect(decision.dispatch).toBe(true);
    expect(decision.deferUntil).toEqual(resumeAt);
  });

  it('does not let quiet hours resurrect a notification the toggle already declined', () => {
    const decision = decideNotification({
      type: 'sync_failed',
      toggles: toggles({ syncFailed: false }),
      telegram: configured,
      quietHours: { active: true, resumeAt: new Date() },
    });

    expect(decision.create).toBe(false);
  });
});

describe('deliveryBackoffSeconds', () => {
  it('grows exponentially from 5 s', () => {
    expect(deliveryBackoffSeconds(1)).toBe(5);
    expect(deliveryBackoffSeconds(2)).toBe(10);
    expect(deliveryBackoffSeconds(3)).toBe(20);
  });

  it("honours Telegram's own retry_after over our guess", () => {
    expect(deliveryBackoffSeconds(1, 42)).toBe(42);
    expect(deliveryBackoffSeconds(4, 7)).toBe(7);
  });

  it('caps every wait, including one Telegram asked for', () => {
    expect(deliveryBackoffSeconds(1, 86_400)).toBe(MAX_DELIVERY_BACKOFF_SECONDS);
    expect(deliveryBackoffSeconds(20)).toBe(MAX_DELIVERY_BACKOFF_SECONDS);
  });

  it('never returns a non-positive or non-finite delay', () => {
    expect(deliveryBackoffSeconds(1, 0)).toBe(1);
    expect(deliveryBackoffSeconds(1, -30)).toBe(1);
    expect(deliveryBackoffSeconds(1, Number.NaN)).toBe(5);
  });

  it('bounds the number of attempts', () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_DELIVERY_ATTEMPTS).toBeLessThanOrEqual(10);
  });
});
