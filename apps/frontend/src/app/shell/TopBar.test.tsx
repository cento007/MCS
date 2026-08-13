import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApiMock,
  dataBody,
  makeSpend,
  mockApi,
  renderWithProviders,
} from '../../features/dashboard/test-support.js';
import { TopBar } from './TopBar.js';

/**
 * The top bar as composed (TDS 06 §3.1).
 *
 * `SpendChip.test.tsx` covers the chip's own states; this covers the thing those tests
 * cannot — that the chip is actually mounted in the shell, in the specified order. A chip
 * with a perfect unit suite and no call site is exactly the gap this bar had.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/auth/me', {
    body: dataBody({
      user: { id: '0198a2f3-9c41-7bd2-a10e-00000000000b', username: 'mvb' },
      authMethod: 'cookie',
      session: { expiresAt: '2026-08-20T12:00:00.000Z' },
    }),
  });
  api.on('GET', '/spend', { body: dataBody(makeSpend({ dayTotal: 3.42, dailyUsd: 10 })) });
});

afterEach(() => {
  api.restore();
});

describe('<TopBar>', () => {
  it('mounts the spend chip, before the connection chip', async () => {
    renderWithProviders(<TopBar onOpenPalette={() => {}} />);

    const chip = await screen.findByTestId('spend-chip');
    expect(chip).toHaveTextContent('$3.42 / $10.00');

    // §3.1 order: search, spend chip, connection chip, account. `compareDocumentPosition`
    // rather than a snapshot, so re-styling the bar does not break the ordering claim.
    const connection = screen.getByRole('status');
    expect(chip.compareDocumentPosition(connection)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('still renders the bar when spend is unavailable', async () => {
    api.on('GET', '/spend', {
      status: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'boom', requestId: 'test-req' } },
    });

    renderWithProviders(<TopBar onOpenPalette={() => {}} />);

    // A failing cost aggregate must never take the shell's wordmark, search or sign-out with
    // it — the chip is the only thing that disappears.
    await waitFor(() => expect(screen.getByText('MISSION CONTROL')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByTestId('spend-chip')).toBeNull();
  });
});
