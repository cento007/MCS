import { describe, expect, it } from 'vitest';
import { DEFAULT_DAILY_REPORT_TIME, parseNotificationsSettings } from './notifications.js';

describe('parseNotificationsSettings (§7.2)', () => {
  it('reads the stored toggles and daily-report window', () => {
    const settings = parseNotificationsSettings(
      new Map<string, unknown>([
        ['events', { costBudgetAlert: false, sessionComplete: true }],
        ['daily_report', { enabled: true, time: '07:30' }],
      ]),
    );

    expect(settings.events.costBudgetAlert).toBe(false);
    expect(settings.events.sessionComplete).toBe(true);
    expect(settings.dailyReport).toEqual({ enabled: true, time: '07:30' });
  });

  it('defaults to the WS5 §5.7.8 form: every event on, daily report at 18:00', () => {
    const settings = parseNotificationsSettings(new Map());

    expect(settings.events).toEqual({
      sessionComplete: true,
      sessionFailed: true,
      syncFailed: true,
      repositoryProblem: true,
      costBudgetAlert: true,
      workflowStepWaiting: true,
    });
    expect(settings.dailyReport).toEqual({ enabled: true, time: DEFAULT_DAILY_REPORT_TIME });
  });

  it('falls back to a deliverable time when the stored one is not one', () => {
    const settings = parseNotificationsSettings(
      new Map<string, unknown>([['daily_report', { enabled: true, time: 'sixish' }]]),
    );

    expect(settings.dailyReport.time).toBe(DEFAULT_DAILY_REPORT_TIME);
  });

  it('survives a corrupt category without throwing', () => {
    const settings = parseNotificationsSettings(
      new Map<string, unknown>([
        ['events', 'not-an-object'],
        ['daily_report', ['nope']],
      ]),
    );

    expect(settings.events.costBudgetAlert).toBe(true);
    expect(settings.dailyReport.enabled).toBe(true);
  });
});
