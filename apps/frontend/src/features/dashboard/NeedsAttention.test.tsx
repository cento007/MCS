import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeedsAttention } from './NeedsAttention.js';
import {
  type ApiMock,
  makeNotification,
  makeServiceRow,
  makeSession,
  makeSpend,
  mockApi,
  renderWithProviders,
  setSocketOffline,
  stubDashboard,
} from './test-support.js';

/**
 * Needs Attention, rendered (TDS 06 §5.2). The aggregation rules are covered without a DOM in
 * `attention.test.ts`; this suite covers what the operator actually sees — the four row kinds,
 * their deep links, the one-line "all clear", and the §3.3 degraded treatment.
 */

let api: ApiMock;

const FAILED = makeSession({
  id: '0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1',
  title: 'Fix nginx TLS renewal',
  state: 'failed',
  branch: 'main',
  completedAt: new Date(Date.now() - 120_000).toISOString(),
});

beforeEach(() => {
  api = mockApi();
});

afterEach(() => {
  api.restore();
});

describe('aggregation across all four sources', () => {
  it('renders a row per source, each deep-linked to the screen that owns it', async () => {
    stubDashboard(api, {
      sessions: [FAILED],
      services: [makeServiceRow({ name: 'sync-worker', label: 'Sync Worker', status: 'down' })],
      notifications: [
        makeNotification({
          id: 'n-sync',
          type: 'sync_failed',
          title: 'Obsidian sync failed',
          body: 'vault path unreadable',
        }),
      ],
      spend: makeSpend({ dayTotal: 8.4, dailyUsd: 10, dayStatus: 'alert' }),
    });

    renderWithProviders(<NeedsAttention />);

    const sessionRow = await screen.findByTestId('attention-session');
    expect(sessionRow).toHaveTextContent('Session failed — Fix nginx TLS renewal');
    expect(sessionRow).toHaveAttribute('href', '/sessions/0198a2f3-9c41-7bd2-a10e-3f7c8b1c4fa1');
    // §9.3: the row never leads with a UUIDv7 prefix.
    expect(sessionRow).not.toHaveTextContent('0198a2f3');

    expect(await screen.findByTestId('attention-service')).toHaveAttribute(
      'href',
      '/settings/services',
    );
    expect(await screen.findByTestId('attention-sync')).toHaveTextContent('Obsidian sync failed');
    const budget = await screen.findByTestId('attention-budget');
    expect(budget).toHaveTextContent('Daily spend $8.40 of $10.00 — 84%');
    expect(budget).toHaveAttribute('href', '/settings/integrations');

    expect(screen.getByRole('heading', { name: /Needs attention/i })).toHaveTextContent('(4)');
  });
});

describe('empty state', () => {
  it('collapses to a single "All clear" rule rather than an empty card', async () => {
    stubDashboard(api, {
      services: [makeServiceRow({ status: 'healthy' })],
      spend: makeSpend({ dayStatus: 'ok' }),
    });

    renderWithProviders(<NeedsAttention />);

    const allClear = await screen.findByTestId('needs-attention-all-clear');
    expect(allClear).toHaveTextContent('All clear · no failures in the last 24 h');
    // It never disappears — absence and "all clear" have to be distinguishable.
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('does not claim "all clear" when a source could not be read', async () => {
    stubDashboard(api, { spend: makeSpend({ dayStatus: 'ok' }) });
    api.on('GET', '/services/health', {
      status: 503,
      body: {
        error: { code: 'INTERNAL_ERROR', message: 'health probe failed', requestId: 'req-1' },
      },
    });

    renderWithProviders(<NeedsAttention />);

    await waitFor(() => expect(screen.getByText(/Could not check services/)).toBeInTheDocument());
    expect(screen.queryByTestId('needs-attention-all-clear')).toBeNull();
  });
});

describe('service exclusions', () => {
  it('ignores `disabled` services while reporting a `down` one', async () => {
    stubDashboard(api, {
      services: [
        makeServiceRow({ name: 'qdrant', label: 'Qdrant', status: 'disabled' }),
        makeServiceRow({ name: 'telegram-worker', label: 'Telegram Worker', status: 'disabled' }),
        makeServiceRow({ name: 'sync-worker', label: 'Sync Worker', status: 'down' }),
      ],
      spend: makeSpend({ dayStatus: 'ok' }),
    });

    renderWithProviders(<NeedsAttention />);

    const list = await screen.findByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('Sync Worker down');
    expect(list).not.toHaveTextContent('Qdrant');
    expect(list).not.toHaveTextContent('Telegram Worker');
  });
});

describe('degraded liveness (§3.3)', () => {
  it('discloses when the screen stopped being verifiable', async () => {
    stubDashboard(api, {
      sessions: [FAILED],
      spend: makeSpend({ dayStatus: 'ok' }),
    });

    renderWithProviders(<NeedsAttention />);
    await screen.findByTestId('attention-session');

    act(() => setSocketOffline());

    // The rule is implemented once, in `lib/liveness.ts`; the widget only consumes it.
    expect(screen.getByText(/last updated \d{2}:\d{2}/)).toBeInTheDocument();
  });
});
