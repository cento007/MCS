import { act, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiMock,
  dataBody,
  makeSpend,
  mockApi,
  renderWithProviders,
  setSocketOffline,
} from '../../features/dashboard/test-support.js';
import { SpendChip } from './SpendChip.js';

/**
 * The top-bar spend chip (TDS 06 §3.1, UX finding WC1).
 *
 * The load-bearing assertion here is the same one the Spend widget carries: the threshold
 * colour comes from the server's `dayStatus` and is never re-derived. Both directions are
 * tested — a chip that stays neutral at 95 % because the server said `ok`, and a chip that
 * turns amber at 10 % because the server said `alert` — because only asserting one of them
 * would pass against a client that computed the ratio itself.
 *
 * Fixtures come from the Dashboard slice: the chip renders the same resource the Spend widget
 * does, and a second `makeSpend` would be a second definition of that resource.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
});

afterEach(() => {
  api.restore();
});

function stubSpend(spend = makeSpend()): void {
  api.on('GET', '/spend', { body: dataBody(spend) });
}

describe('the server owns the threshold (§7.8)', () => {
  it('renders `$x.xx / $y.yy` in neutral text when the day is `ok`', async () => {
    stubSpend(makeSpend({ dayTotal: 3.42, dailyUsd: 10, dayStatus: 'ok' }));

    renderWithProviders(<SpendChip />);

    const chip = await screen.findByTestId('spend-chip');
    expect(chip).toHaveTextContent('$3.42 / $10.00');
    expect(chip).toHaveAttribute('data-day-status', 'ok');
    expect(chip).toHaveStyle({ color: 'var(--color-text-secondary)' });
  });

  it('stays neutral at 95 % of budget when the server says `ok`', async () => {
    stubSpend(makeSpend({ dayTotal: 9.5, dailyUsd: 10, dayStatus: 'ok' }));

    renderWithProviders(<SpendChip />);

    const chip = await screen.findByTestId('spend-chip');
    expect(chip).toHaveStyle({ color: 'var(--color-text-secondary)' });
    // A client-side `spent/budget >= threshold` would have turned this amber and put the chip
    // at odds with the Dashboard meter, which is exactly what `dayStatus` exists to prevent.
    expect(chip.textContent).not.toContain('▲');
  });

  it('turns `--color-warning` at 10 % of budget when the server says `alert`', async () => {
    stubSpend(makeSpend({ dayTotal: 1, dailyUsd: 10, dayStatus: 'alert' }));

    renderWithProviders(<SpendChip />);

    const chip = await screen.findByTestId('spend-chip');
    expect(chip).toHaveStyle({ color: 'var(--color-warning)' });
    // Colour is never the only channel (§2.1.6).
    expect(chip).toHaveTextContent('▲');
  });

  it('turns `--color-danger` when the server says `over`', async () => {
    stubSpend(makeSpend({ dayTotal: 12.1, dailyUsd: 10, dayStatus: 'over' }));

    renderWithProviders(<SpendChip />);

    const chip = await screen.findByTestId('spend-chip');
    expect(chip).toHaveStyle({ color: 'var(--color-danger)' });
    expect(chip).toHaveTextContent('$12.10 / $10.00');
    // `▲`, not `✕`: an exceeded budget is a spending condition, not a failure.
    expect(chip).toHaveTextContent('▲');
  });
});

describe('`no_budget` — spend alone, never a fabricated denominator', () => {
  it('shows the amount with no denominator when no daily budget is set', async () => {
    stubSpend(makeSpend({ dayTotal: 4.12, dailyUsd: null, dayStatus: 'no_budget' }));

    renderWithProviders(<SpendChip />);

    const chip = await screen.findByTestId('spend-chip');
    expect(chip).toHaveTextContent('$4.12');
    // `$4.12 / $0.00` states a budget nobody set; `$4.12 / —` reads as a failed load.
    expect(chip.textContent).not.toContain('/');
    expect(chip.textContent).not.toContain('$0.00');
    expect(chip).toHaveStyle({ color: 'var(--color-text-secondary)' });
  });

  it('is NOT hidden — hiding it would recreate WC1 on a fresh install', async () => {
    stubSpend(makeSpend({ dayTotal: 4.12, dailyUsd: null, dayStatus: 'no_budget' }));

    renderWithProviders(<SpendChip />);

    // Every install has no budget on day one. WC1 was "budget configurable, spend invisible";
    // hiding the chip precisely when no budget exists is that finding, re-shipped.
    expect(await screen.findByTestId('spend-chip')).toBeInTheDocument();
  });
});

describe('when the chip is absent', () => {
  it('is hidden entirely when cost-budget alerts are disabled (§3.1)', async () => {
    stubSpend(makeSpend({ dayTotal: 3.42, dailyUsd: 10, alertsEnabled: false }));

    renderWithProviders(<SpendChip />);

    await waitFor(() => expect(api.callsTo('/spend').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('spend-chip')).toBeNull();
  });

  it('renders nothing while the request is in flight, rather than a confident $0.00', () => {
    stubSpend();

    renderWithProviders(<SpendChip />);

    expect(screen.queryByTestId('spend-chip')).toBeNull();
  });

  it('renders nothing when `GET /spend` fails — the Dashboard widget reports it', async () => {
    api.on('GET', '/spend', {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'test-req' } },
    });

    renderWithProviders(<SpendChip />);

    await waitFor(() => expect(api.callsTo('/spend').length).toBeGreaterThan(0));
    expect(screen.queryByTestId('spend-chip')).toBeNull();
  });
});

describe('shell behaviour', () => {
  it('links to the Dashboard, where the spend stat lives', async () => {
    stubSpend();

    renderWithProviders(<SpendChip />);

    expect(await screen.findByTestId('spend-chip')).toHaveAttribute('href', '/');
  });

  it('marks the amount `~` and mutes it once the socket is not live (§3.3)', async () => {
    stubSpend(makeSpend({ dayTotal: 3.42, dailyUsd: 10, dayStatus: 'alert' }));

    renderWithProviders(<SpendChip />);
    const chip = await screen.findByTestId('spend-chip');
    expect(chip.textContent).not.toContain('~');

    act(() => setSocketOffline());

    // A cost total on a dead socket is a claim about the past. The `~` says so, and the mute
    // stops an amber chip from reading as a live threshold breach it can no longer verify.
    expect(chip).toHaveTextContent('~$3.42 / $10.00');
    expect(chip).toHaveStyle({ color: 'var(--color-text-muted)' });
    // The glyph is retained while the pulse/colour drops — §3.3's rule for every live region.
    expect(chip).toHaveTextContent('▲');
  });
});
