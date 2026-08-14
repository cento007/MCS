import { describe, expect, it } from 'vitest';
import { UNKNOWN_STATUS_NOTE } from '../../lib/service-health.js';
import type { AttentionSources } from './attention.js';
import { ATTENTION_WINDOW_MS, buildAttention, MAX_ATTENTION_ROWS } from './attention.js';
import {
  makeNotification,
  makeProject,
  makeServiceRow,
  makeSession,
  makeSpend,
  PROJECT_ID,
} from './test-support.js';

/**
 * Needs Attention aggregation (TDS 06 §5.2) — the four sources, their exclusions and their
 * ordering, tested without a DOM.
 */

const NOW = Date.parse('2026-08-13T12:00:00.000Z');

function sources(overrides: Partial<AttentionSources> = {}): AttentionSources {
  return {
    failedSessions: [],
    projectNames: new Map([[PROJECT_ID, makeProject().name]]),
    services: [],
    notifications: [],
    spend: null,
    now: NOW,
    ...overrides,
  };
}

describe('sources', () => {
  it('aggregates all four sources into one ordered list', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          makeSession({
            id: '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1',
            title: 'Fix nginx TLS renewal',
            state: 'failed',
            branch: 'main',
            completedAt: '2026-08-13T11:58:00.000Z',
          }),
        ],
        services: [makeServiceRow({ name: 'sync-worker', label: 'Sync Worker', status: 'down' })],
        notifications: [
          makeNotification({
            id: 'n-sync',
            type: 'sync_failed',
            severity: 'error',
            title: 'Obsidian sync failed',
            body: 'vault path unreadable',
            createdAt: '2026-08-13T11:41:00.000Z',
          }),
        ],
        spend: makeSpend({ dayTotal: 8.4, dayStatus: 'alert' }),
      }),
    );

    expect(digest.items.map((item) => item.source)).toEqual([
      'session',
      'service',
      'sync',
      'budget',
    ]);
    expect(digest.totalCount).toBe(4);
  });

  it('is empty when nothing is wrong — the widget collapses to one line', () => {
    const digest = buildAttention(
      sources({
        services: [makeServiceRow({ status: 'healthy' })],
        notifications: [makeNotification()],
        spend: makeSpend({ dayStatus: 'ok' }),
      }),
    );

    expect(digest.items).toHaveLength(0);
    expect(digest.totalCount).toBe(0);
  });
});

describe('failed sessions (24 h window)', () => {
  const failed = (id: string, completedAt: string) =>
    makeSession({ id, state: 'failed', completedAt, title: `Failure ${id}` });

  it('keeps failures inside the window and drops older ones', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          failed('0198a2f3-9c41-7bd2-a10e-00000000aaaa', new Date(NOW - 60_000).toISOString()),
          failed(
            '0198a2f3-9c41-7bd2-a10e-00000000bbbb',
            new Date(NOW - ATTENTION_WINDOW_MS - 60_000).toISOString(),
          ),
        ],
      }),
    );

    expect(digest.items).toHaveLength(1);
    expect(digest.items[0]?.id).toBe('session:0198a2f3-9c41-7bd2-a10e-00000000aaaa');
  });

  it('leads with the title and deep-links to the Session (§9.3)', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          makeSession({
            id: '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1',
            title: 'Fix nginx TLS renewal',
            state: 'failed',
            branch: 'main',
            completedAt: new Date(NOW - 120_000).toISOString(),
          }),
        ],
      }),
    );

    const item = digest.items[0];
    expect(item?.title).toBe('Session failed — Fix nginx TLS renewal');
    expect(item?.title).not.toMatch(/0198a2f3/);
    expect(item?.detail).toBe('mission-control · main');
    expect(item?.to).toBe('/sessions/0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1');
    expect(item?.severity).toBe('danger');
    expect(item?.glyph).toBe('✕');
  });

  it('carries the failure code on the second line — the only part that says why', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          makeSession({
            state: 'failed',
            branch: 'main',
            failureReason: 'spawn_error',
            completedAt: new Date(NOW - 120_000).toISOString(),
          }),
        ],
      }),
    );

    // Verbatim, never prettified: `spawn_error` is the Backend's own vocabulary and the
    // operator greps the Backend log with it.
    expect(digest.items[0]?.detail).toBe('mission-control · main · spawn_error');
  });

  it('degrades to `project · branch` when the failure carried no reason', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          makeSession({
            state: 'failed',
            branch: 'main',
            failureReason: null,
            completedAt: new Date(NOW - 120_000).toISOString(),
          }),
        ],
      }),
    );

    // No invented `unknown`: that would be indistinguishable from a real `unknown` code.
    expect(digest.items[0]?.detail).toBe('mission-control · main');
  });

  it('still renders a code when there is no project or branch to lead with', () => {
    const digest = buildAttention(
      sources({
        projectNames: new Map(),
        failedSessions: [
          makeSession({
            state: 'failed',
            branch: null,
            failureReason: 'process_crash',
            completedAt: new Date(NOW - 120_000).toISOString(),
          }),
        ],
      }),
    );

    expect(digest.items[0]?.detail).toBe('process_crash');
  });

  it('falls back to updatedAt when completedAt is absent', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          makeSession({
            state: 'failed',
            completedAt: null,
            updatedAt: new Date(NOW - 5_000).toISOString(),
          }),
        ],
      }),
    );

    expect(digest.items).toHaveLength(1);
  });

  it('excludes a session the operator cancelled — that is not a condition needing attention', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          makeSession({
            state: 'failed',
            failureReason: 'cancelled',
            completedAt: new Date(NOW - 60_000).toISOString(),
          }),
        ],
      }),
    );

    // `failed(cancelled)` is F7's only exit for a Session that never launched, so the state alone
    // cannot tell "it broke" from "you stopped it". Badging the operator's own Stop with
    // `✕ Session failed` is the widget crying wolf about its user.
    expect(digest.items).toHaveLength(0);
    expect(digest.totalCount).toBe(0);
  });

  it('ignores rows that are not in `failed` even if the endpoint returns them', () => {
    const digest = buildAttention(
      sources({
        failedSessions: [
          makeSession({ state: 'archived', completedAt: new Date(NOW).toISOString() }),
        ],
      }),
    );

    expect(digest.items).toHaveLength(0);
  });
});

describe('services', () => {
  it('excludes `disabled` — specified but not deployed is not a failure', () => {
    const digest = buildAttention(
      sources({
        services: [
          makeServiceRow({ name: 'qdrant', label: 'Qdrant', status: 'disabled' }),
          makeServiceRow({ name: 'ollama', label: 'Ollama', status: 'disabled' }),
          makeServiceRow({
            name: 'telegram-worker',
            label: 'Telegram Worker',
            status: 'disabled',
            detail: 'Has never reported. Start it with `pnpm dev:workers`.',
          }),
        ],
      }),
    );

    expect(digest.items).toHaveLength(0);
  });

  it('includes `down`, `degraded` and `unknown`, and excludes `healthy`', () => {
    const digest = buildAttention(
      sources({
        services: [
          makeServiceRow({ name: 'postgresql', label: 'PostgreSQL', status: 'healthy' }),
          makeServiceRow({ name: 'queue', label: 'Queue (PostgreSQL)', status: 'degraded' }),
          makeServiceRow({ name: 'sync-worker', label: 'Sync Worker', status: 'down' }),
          makeServiceRow({ name: 'telegram-worker', label: 'Telegram Worker', status: 'unknown' }),
        ],
      }),
    );

    expect(digest.items.map((item) => item.title)).toEqual([
      // `down` outranks the warnings (§5.2 severity ordering).
      'Sync Worker down',
      'Queue (PostgreSQL) degraded',
      'Telegram Worker unknown',
    ]);
    expect(digest.items[0]?.severity).toBe('danger');
    expect(digest.items[1]?.severity).toBe('warning');
    expect(digest.items.every((item) => item.to === '/settings/services')).toBe(true);
  });

  it('does not blame a worker for an `unknown` its own heartbeat read caused', () => {
    const digest = buildAttention(
      sources({
        services: [
          makeServiceRow({
            name: 'telegram-worker',
            label: 'Telegram Worker',
            status: 'unknown',
            // What WS1's probe actually returns when the heartbeat SELECT throws: the broken
            // dependency is PostgreSQL, on a row that carries the worker's name.
            detail: 'Heartbeat unreadable: connection terminated',
          }),
        ],
      }),
    );

    expect(digest.items[0]?.detail).toContain(UNKNOWN_STATUS_NOTE);
  });
});

describe('sync failure', () => {
  it('takes only the newest sync_failed notification and ignores other types', () => {
    const digest = buildAttention(
      sources({
        notifications: [
          makeNotification({
            id: 'n-old',
            type: 'sync_failed',
            createdAt: '2026-08-13T09:00:00.000Z',
          }),
          makeNotification({
            id: 'n-new',
            type: 'sync_failed',
            title: 'Obsidian sync failed',
            body: 'vault path unreadable',
            createdAt: '2026-08-13T11:41:00.000Z',
          }),
          makeNotification({ id: 'n-other', type: 'session_completed' }),
        ],
      }),
    );

    expect(digest.items).toHaveLength(1);
    expect(digest.items[0]?.id).toBe('sync:n-new');
    expect(digest.items[0]?.detail).toBe('vault path unreadable');
    expect(digest.items[0]?.to).toBe('/settings/integrations');
  });
});

describe('budget', () => {
  it('uses the server dayStatus, never a client-side threshold', () => {
    // 95 % of budget, but the server says `ok`. The widget must believe the server: it is the
    // one place the threshold is evaluated (§7.8), so a client that re-derived it could
    // disagree with the top-bar chip and with Settings.
    const digest = buildAttention(
      sources({ spend: makeSpend({ dayTotal: 9.5, dailyUsd: 10, dayStatus: 'ok' }) }),
    );
    expect(digest.items).toHaveLength(0);

    // And the mirror image: 10 % of budget, but the server says `alert`.
    const alerted = buildAttention(
      sources({ spend: makeSpend({ dayTotal: 1, dailyUsd: 10, dayStatus: 'alert' }) }),
    );
    expect(alerted.items).toHaveLength(1);
    expect(alerted.items[0]?.severity).toBe('warning');
  });

  it('escalates `over` to danger and states the amounts', () => {
    const digest = buildAttention(
      sources({ spend: makeSpend({ dayTotal: 12.1, dailyUsd: 10, dayStatus: 'over' }) }),
    );

    expect(digest.items[0]?.severity).toBe('danger');
    expect(digest.items[0]?.title).toBe('Daily spend $12.10 of $10.00 — 121%');
    expect(digest.items[0]?.to).toBe('/settings/integrations');
  });

  it('says nothing when no budget is configured', () => {
    const digest = buildAttention(
      sources({ spend: makeSpend({ dailyUsd: null, dayStatus: 'no_budget' }) }),
    );
    expect(digest.items).toHaveLength(0);
  });
});

describe('bounds', () => {
  it('caps the rendered rows at 8 but reports the true total', () => {
    const services = Array.from({ length: 12 }, (_, index) =>
      makeServiceRow({ name: `svc-${index}`, label: `Service ${index}`, status: 'degraded' }),
    );

    const digest = buildAttention(sources({ services }));

    expect(digest.items).toHaveLength(MAX_ATTENTION_ROWS);
    expect(digest.totalCount).toBe(12);
  });
});
