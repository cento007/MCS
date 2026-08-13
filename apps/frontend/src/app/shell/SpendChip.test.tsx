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
import { ShellBoundary } from './ShellBoundary.js';
import { readSpendChip, SpendChip } from './SpendChip.js';

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

describe('a body this chip cannot read', () => {
  /**
   * `lib/api/types.ts` is hand-written against the prose contract — `openapi.yaml` declares no
   * response schemas — so nothing verifies that the shape arriving at runtime is the shape this
   * file compiled against. Before `readSpendChip`, `data.budget.alertsEnabled` on a body without
   * `budget` threw during render, and the nearest boundary was on `RequireAuth`, the *parent* of
   * `AppShell`: one renamed field replaced the whole authenticated area, navigation included.
   *
   * Hidden rather than an error marker is this chip's own documented rule for a body it cannot
   * use ("Not loaded / failed to load → hidden"); the Dashboard's Spend widget reports a failed
   * `GET /spend` properly, with room to do it in.
   */
  it.each([
    ['budget missing', { day: { totalCostUsd: 1 }, dayStatus: 'ok' }],
    ['day missing', { budget: { alertsEnabled: true, dailyUsd: 10 }, dayStatus: 'ok' }],
    [
      'dayStatus missing',
      { budget: { alertsEnabled: true, dailyUsd: 10 }, day: { totalCostUsd: 1 } },
    ],
    [
      'dayStatus not a known status',
      {
        budget: { alertsEnabled: true, dailyUsd: 10 },
        day: { totalCostUsd: 1 },
        dayStatus: 'sideways',
      },
    ],
    [
      'totalCostUsd is a string',
      {
        budget: { alertsEnabled: true, dailyUsd: 10 },
        day: { totalCostUsd: '1.00' },
        dayStatus: 'ok',
      },
    ],
    [
      'dailyUsd is a string',
      {
        budget: { alertsEnabled: true, dailyUsd: '10' },
        day: { totalCostUsd: 1 },
        dayStatus: 'ok',
      },
    ],
    ['null', null],
    ['a bare string', 'nope'],
  ])('renders nothing and does not throw when %s', (_label, body) => {
    expect(readSpendChip(body)).toBeNull();
  });

  it('still hides when alerts are off, which is the documented rule and not a defect', () => {
    expect(
      readSpendChip({
        budget: { alertsEnabled: false, dailyUsd: 10, alertThresholdPercent: 80 },
        day: { totalCostUsd: 1 },
        dayStatus: 'ok',
      }),
    ).toBeNull();
  });

  it('treats an absent `alertsEnabled` as off rather than as on', () => {
    // An install whose alert state cannot be read is not one to start announcing cost at.
    expect(
      readSpendChip({
        budget: { dailyUsd: 10 },
        day: { totalCostUsd: 1 },
        dayStatus: 'ok',
      }),
    ).toBeNull();
  });

  it('keeps `dailyUsd: null`, which is the real "no budget set" case', () => {
    // The one falsy-looking value that must survive: `no_budget` is a chip that renders.
    expect(
      readSpendChip({
        budget: { alertsEnabled: true, dailyUsd: null, alertThresholdPercent: 80 },
        day: { totalCostUsd: 4.12 },
        dayStatus: 'no_budget',
      }),
    ).toEqual({
      dayStatus: 'no_budget',
      totalCostUsd: 4.12,
      dailyUsd: null,
      alertThresholdPercent: 80,
    });
  });

  it('degrades the tooltip rather than the chip when only the threshold is unreadable', () => {
    const model = readSpendChip({
      budget: { alertsEnabled: true, dailyUsd: 10 },
      day: { totalCostUsd: 3.42 },
      dayStatus: 'ok',
    });

    // Amount and budget are both good; losing a tooltip detail is not worth hiding them.
    expect(model).toMatchObject({ totalCostUsd: 3.42, dailyUsd: 10, alertThresholdPercent: null });
  });

  it('never even reaches the boundary — a malformed body is handled, not caught', async () => {
    // Asserted through a real `ShellBoundary` rather than a bare render, so this fails
    // *cleanly* against the old unguarded read: there, the throw is caught and the ⚠ fallback
    // appears, which is a visible defect marker on a condition the chip is supposed to handle
    // silently. A bare render would instead blow up the test run with an unhandled error,
    // which is a much weaker signal to leave for whoever breaks this next.
    api.on('GET', '/spend', { body: dataBody({ nonsense: true }) });

    renderWithProviders(
      <div>
        <ShellBoundary label="Spend indicator">
          <SpendChip />
        </ShellBoundary>
        <span>the rest of the shell</span>
      </div>,
    );

    expect(await screen.findByText('the rest of the shell')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('spend-chip')).not.toBeInTheDocument());
    expect(screen.queryByTestId('shell-boundary-fallback')).not.toBeInTheDocument();
  });
});
