import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiMock,
  dataBody,
  makeSpend,
  mockApi,
  renderWithProviders,
} from '../../features/dashboard/test-support.js';

/**
 * The top bar survives a chip that throws.
 *
 * A separate file because `vi.mock` is hoisted and applies to the whole module graph for the
 * file it appears in — a throwing `SpendChip` in `TopBar.test.tsx` would break every other
 * assertion there.
 *
 * This is the test that pins the **wiring**, and it is the one that would catch the regression
 * that matters. `ShellBoundary.test.tsx` proves the boundary contains a throw; nothing there
 * proves the boundary is actually wrapped around the chips. Delete the `<ShellBoundary>` from
 * `TopBar` and every other suite in this directory still passes — a boundary with a perfect
 * unit suite and no call site is the same gap this bar's own header warns about for chips.
 *
 * Before this wiring, the nearest boundary was `RouteErrorBoundary` on the `RequireAuth`
 * element — the parent of `AppShell` — so this throw replaced the entire authenticated area,
 * navigation included, with "Something broke on this page".
 */

vi.mock('./SpendChip.js', () => ({
  SpendChip: () => {
    throw new Error('shape mismatch: budget is undefined');
  },
}));

const { TopBar } = await import('./TopBar.js');

let api: ApiMock;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs every caught error regardless of the boundary; silencing it here keeps the
  // expected noise from this one file out of the run without muting React warnings elsewhere.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  api = mockApi();
  api.on('GET', '/auth/me', {
    body: dataBody({
      user: { id: '0198a2f3-9c41-7bd2-a10e-00000000000b', username: 'mvb' },
      authMethod: 'cookie',
      session: { expiresAt: '2026-08-20T12:00:00.000Z' },
    }),
  });
  api.on('GET', '/spend', { body: dataBody(makeSpend()) });
});

afterEach(() => {
  api.restore();
  consoleError.mockRestore();
});

describe('a chip that throws costs the chip', () => {
  it('keeps the rest of the top bar mounted', async () => {
    renderWithProviders(<TopBar onOpenPalette={() => {}} />);

    // The wordmark, the account name and the escape hatch all survive. Sign out especially:
    // an operator whose shell is broken must still be able to leave it.
    expect(screen.getByText('MISSION CONTROL')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // Awaited: `GET /auth/me` resolves after the first paint, while Sign out renders
    // immediately. Proving the account name arrives *after* a sibling threw is the point —
    // the surviving widgets keep working, not merely keep their initial markup.
    expect(await screen.findByText('mvb')).toBeInTheDocument();
  });

  it('shows a marker where the chip was, rather than silently nothing', () => {
    renderWithProviders(<TopBar onOpenPalette={() => {}} />);

    // `SpendChip` has three legitimate reasons to render nothing. If a crash were a fourth,
    // the operator would read a defect as "cost alerts are switched off".
    expect(screen.getByTestId('shell-boundary-fallback')).toBeInTheDocument();
    expect(screen.getByText('Spend indicator could not be displayed.')).toBeInTheDocument();
  });

  it('leaves the connection indicator working, which is what says whether the server is up', () => {
    renderWithProviders(<TopBar onOpenPalette={() => {}} />);

    // Exactly one boundary fired. If the two chips shared a boundary this would be the
    // ConnectionChip's grave too — the widget that distinguishes "the backend is down" from
    // "this screen is wrong", which is the question a broken shell makes urgent.
    expect(screen.getAllByTestId('shell-boundary-fallback')).toHaveLength(1);
    // `role="status"` is the ConnectionChip's, and it is unambiguous precisely because the
    // fallback deliberately does not claim that role. See `ShellBoundary`.
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
