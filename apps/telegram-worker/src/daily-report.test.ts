import { describe, expect, it } from 'vitest';
import {
  type DailyReportCounts,
  isDailyReportDue,
  nextTickSeconds,
  renderDailyReport,
  TICK_CEILING_SECONDS,
  tickJobId,
} from './daily-report.js';

/**
 * The scheduling rule, without a database and without a clock. The timezone arithmetic itself
 * is PostgreSQL's (`readLocalDayWindow`) and is covered by the integration tier — what is pure,
 * and what is easy to get subtly wrong, is *"has today's report already gone out"*.
 */

const dayStart = new Date('2026-08-13T00:00:00.000Z');
const dueAt = new Date('2026-08-13T18:00:00.000Z');

describe('isDailyReportDue', () => {
  it('is not due before the configured local time', () => {
    expect(
      isDailyReportDue({
        enabled: true,
        now: new Date('2026-08-13T17:59:59.000Z'),
        dueAt,
        dayStart,
        lastReportAt: null,
      }),
    ).toBe(false);
  });

  it('is due at the configured local time', () => {
    expect(
      isDailyReportDue({ enabled: true, now: dueAt, dueAt, dayStart, lastReportAt: null }),
    ).toBe(true);
  });

  it('is still due when the worker was down at the moment it came round', () => {
    // The whole reason the tick asks the ledger instead of trusting a fired timer.
    expect(
      isDailyReportDue({
        enabled: true,
        now: new Date('2026-08-13T21:14:00.000Z'),
        dueAt,
        dayStart,
        lastReportAt: null,
      }),
    ).toBe(true);
  });

  it('is not due again once today’s report exists', () => {
    expect(
      isDailyReportDue({
        enabled: true,
        now: new Date('2026-08-13T18:01:00.000Z'),
        dueAt,
        dayStart,
        lastReportAt: new Date('2026-08-13T18:00:02.000Z'),
      }),
    ).toBe(false);
  });

  it('is due again the next day even though yesterday’s report exists', () => {
    expect(
      isDailyReportDue({
        enabled: true,
        now: new Date('2026-08-14T18:00:00.000Z'),
        dueAt: new Date('2026-08-14T18:00:00.000Z'),
        dayStart: new Date('2026-08-14T00:00:00.000Z'),
        lastReportAt: new Date('2026-08-13T18:00:02.000Z'),
      }),
    ).toBe(true);
  });

  it('is never due while disabled', () => {
    expect(
      isDailyReportDue({
        enabled: false,
        now: new Date('2026-08-13T23:00:00.000Z'),
        dueAt,
        dayStart,
        lastReportAt: null,
      }),
    ).toBe(false);
  });
});

describe('nextTickSeconds', () => {
  it('sleeps until the due moment when that is sooner than the ceiling', () => {
    expect(nextTickSeconds(new Date('2026-08-13T17:59:50.000Z'), dueAt)).toBe(10);
  });

  it('never sleeps past the ceiling, so a settings change is noticed within a minute', () => {
    expect(nextTickSeconds(new Date('2026-08-13T06:00:00.000Z'), dueAt)).toBe(TICK_CEILING_SECONDS);
  });

  it('falls back to the ceiling when there is nothing due (disabled, or already sent)', () => {
    expect(nextTickSeconds(new Date(), null)).toBe(TICK_CEILING_SECONDS);
    expect(nextTickSeconds(new Date('2026-08-13T19:00:00.000Z'), dueAt)).toBe(TICK_CEILING_SECONDS);
  });

  it('never returns zero — a zero delay is a hot loop', () => {
    expect(nextTickSeconds(new Date('2026-08-13T17:59:59.900Z'), dueAt)).toBeGreaterThanOrEqual(1);
  });
});

describe('tickJobId', () => {
  it('is deterministic per target second, so a restart cannot start a second chain', () => {
    const target = new Date('2026-08-13T18:00:00.000Z');

    expect(tickJobId(target)).toBe(tickJobId(new Date('2026-08-13T18:00:00.500Z')));
    expect(tickJobId(target)).not.toBe(tickJobId(new Date('2026-08-13T18:00:01.000Z')));
  });

  it('is a well-formed UUID, because pg-boss’s job id column is `uuid`', () => {
    expect(tickJobId(new Date())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

describe('renderDailyReport (PRD §9: Projects, Sessions, PRs, ADRs)', () => {
  const counts: DailyReportCounts = {
    projects: 2,
    sessionsStarted: 5,
    sessionsCompleted: 4,
    sessionsFailed: 1,
    pullRequestsOpened: 3,
    pullRequestsMerged: 2,
    adrs: 1,
    commits: 17,
    spendUsd: 4.2,
  };

  const day = {
    dayStart,
    dayEnd: new Date('2026-08-14T00:00:00.000Z'),
    localDate: '2026-08-13',
  };

  it('carries all four PRD figures', () => {
    const rendered = renderDailyReport(counts, day, 'Europe/Amsterdam');

    expect(rendered.title).toBe('Daily report — 2026-08-13');
    expect(rendered.body).toContain('Projects active: 2');
    expect(rendered.body).toContain('Sessions: 5 started · 4 completed · 1 failed');
    expect(rendered.body).toContain('Pull requests: 3 opened · 2 merged');
    expect(rendered.body).toContain('ADRs: 1');
    expect(rendered.body).toContain('2026-08-13 (Europe/Amsterdam)');
  });

  it('says so explicitly on a quiet day rather than looking broken', () => {
    const quiet = renderDailyReport(
      {
        projects: 0,
        sessionsStarted: 0,
        sessionsCompleted: 0,
        sessionsFailed: 0,
        pullRequestsOpened: 0,
        pullRequestsMerged: 0,
        adrs: 0,
        commits: 0,
        spendUsd: 0,
      },
      day,
      'UTC',
    );

    expect(quiet.body).toContain('No activity recorded for this day.');
  });
});
