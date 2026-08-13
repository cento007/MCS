import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SpendWidget } from './SpendWidget.js';
import {
  type ApiMock,
  makeSpend,
  mockApi,
  renderWithProviders,
  setSocketOffline,
  stubDashboard,
} from './test-support.js';

/**
 * The Spend widget (TDS 06 §5.2 / TDS 04 §7.8).
 *
 * The load-bearing assertion in this file is that the threshold decision comes from the
 * server's `dayStatus` and is never re-derived here — that is what stops the widget, the
 * top-bar chip and Settings from disagreeing about when the bar turns amber.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
});

afterEach(() => {
  api.restore();
});

describe('server-computed dayStatus drives the rule', () => {
  it('stays `--color-success` at 95 % of budget when the server says `ok`', async () => {
    stubDashboard(api, { spend: makeSpend({ dayTotal: 9.5, dailyUsd: 10, dayStatus: 'ok' }) });

    renderWithProviders(<SpendWidget />);

    const rule = await screen.findByTestId('spend-rule');
    expect(rule).toHaveAttribute('data-day-status', 'ok');
    expect(rule.firstElementChild).toHaveStyle({
      backgroundColor: 'var(--color-success)',
    });
    // The percentage IS computed client-side — it is a display rounding, not a decision.
    expect(rule).toHaveAttribute('aria-valuenow', '95');
  });

  it('turns `--color-warning` when the server says `alert`, whatever the ratio', async () => {
    stubDashboard(api, { spend: makeSpend({ dayTotal: 1, dailyUsd: 10, dayStatus: 'alert' }) });

    renderWithProviders(<SpendWidget />);

    const rule = await screen.findByTestId('spend-rule');
    expect(rule).toHaveAttribute('data-day-status', 'alert');
    expect(rule.firstElementChild).toHaveStyle({ backgroundColor: 'var(--color-warning)' });
  });

  it('turns `--color-danger` over budget and clamps the fill at 100 %', async () => {
    stubDashboard(api, { spend: makeSpend({ dayTotal: 12.1, dailyUsd: 10, dayStatus: 'over' }) });

    renderWithProviders(<SpendWidget />);

    const rule = await screen.findByTestId('spend-rule');
    expect(rule).toHaveAttribute('data-day-status', 'over');
    expect(rule.firstElementChild).toHaveStyle({
      backgroundColor: 'var(--color-danger)',
      width: '100%',
    });
  });
});

describe('spend is never invisible', () => {
  it('shows the amount with `no budget set` when no daily budget is configured', async () => {
    stubDashboard(api, {
      spend: makeSpend({ dayTotal: 3.42, dailyUsd: null, dayStatus: 'no_budget' }),
    });

    renderWithProviders(<SpendWidget />);

    expect(await screen.findByTestId('spend-today')).toHaveTextContent('$3.42');
    expect(screen.getByText('no budget set')).toBeInTheDocument();
    expect(screen.queryByTestId('spend-rule')).toBeNull();
    expect(screen.getByRole('link', { name: 'Set a daily budget' })).toBeInTheDocument();
  });

  it('renders budget-scale money, not per-Session four-decimal money', async () => {
    stubDashboard(api, { spend: makeSpend({ dayTotal: 3.4200001, dailyUsd: 10 }) });

    renderWithProviders(<SpendWidget />);

    expect(await screen.findByTestId('spend-today')).toHaveTextContent('$3.42');
    expect(screen.getByText('of $10.00')).toBeInTheDocument();
  });
});

describe('degraded liveness (§3.3)', () => {
  it('marks the amount `~` once the socket is no longer live', async () => {
    stubDashboard(api, { spend: makeSpend({ dayTotal: 3.42 }) });

    renderWithProviders(<SpendWidget />);
    await screen.findByTestId('spend-today');

    act(() => setSocketOffline());

    expect(screen.getByTestId('spend-today')).toHaveTextContent('~$3.42');
  });
});
