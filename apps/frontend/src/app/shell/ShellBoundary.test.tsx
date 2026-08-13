import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellBoundary } from './ShellBoundary.js';

/**
 * A shell widget that throws must cost the shell that widget, and nothing else.
 *
 * The defect these tests pin: the only boundary in the route table is on the `RequireAuth`
 * element (`app/router.tsx`), the **parent** of `AppShell`. So a render failure in any shell
 * widget replaced the entire authenticated area — navigation included — with "Something broke
 * on this page", leaving the operator to reload onto the same broken route.
 *
 * React logs a caught error to `console.error` regardless of the boundary, so the console is
 * silenced per-test rather than globally: a suite that permanently muted it would hide genuine
 * React warnings from every other test in this file.
 */

function Boom(): never {
  throw new Error('shape mismatch: budget is undefined');
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('containment', () => {
  it('renders the siblings of a widget that throws', () => {
    // The whole point, in one assertion: `Boom` is between two survivors, so a boundary that
    // wrapped the group instead of the widget would fail this.
    render(
      <div>
        <span>before</span>
        <ShellBoundary label="Spend indicator">
          <Boom />
        </ShellBoundary>
        <span>after</span>
      </div>,
    );

    expect(screen.getByText('before')).toBeInTheDocument();
    expect(screen.getByText('after')).toBeInTheDocument();
  });

  it('does not rethrow, so an outer boundary never sees it', () => {
    let outerSaw = false;

    render(
      <ShellBoundary label="The whole shell" onError={() => (outerSaw = true)}>
        <ShellBoundary label="Spend indicator">
          <Boom />
        </ShellBoundary>
      </ShellBoundary>,
    );

    // The outer boundary stands in for `RouteErrorBoundary`. If the inner one rethrew or failed
    // to catch, the outer would fire — which in the real tree blanks the authenticated area.
    expect(outerSaw).toBe(false);
    expect(screen.getByTestId('shell-boundary-fallback')).toBeInTheDocument();
  });

  it('passes children through untouched when nothing throws', () => {
    render(
      <ShellBoundary label="Spend indicator">
        <span>the real chip</span>
      </ShellBoundary>,
    );

    expect(screen.getByText('the real chip')).toBeInTheDocument();
    expect(screen.queryByTestId('shell-boundary-fallback')).not.toBeInTheDocument();
  });
});

describe('the fallback is visible, and says which widget it was', () => {
  it('renders a marker rather than nothing', () => {
    // Not cosmetic. `SpendChip` documents three deliberate reasons to render nothing (alerts
    // off, not loaded, mobile). A crashed widget that also rendered nothing would make a defect
    // indistinguishable from "the operator switched cost alerts off".
    render(
      <ShellBoundary label="Spend indicator">
        <Boom />
      </ShellBoundary>,
    );

    const fallback = screen.getByTestId('shell-boundary-fallback');
    expect(fallback).toBeInTheDocument();
    expect(fallback.textContent).not.toBe('');
  });

  it('names the widget for screen readers and on hover', () => {
    render(
      <ShellBoundary label="Open sessions">
        <Boom />
      </ShellBoundary>,
    );

    expect(screen.getByText('Open sessions could not be displayed.')).toBeInTheDocument();
    expect(screen.getByTestId('shell-boundary-fallback').title).toContain('Open sessions');
  });

  it('does not use `—`, which already means "no value" elsewhere in the shell', () => {
    // `RunningCount` renders `—` when `GET /sessions` errors and `TopBar` renders it for an
    // unknown username. Reusing it here would collapse "broken" into "no value".
    render(
      <ShellBoundary label="Spend indicator">
        <Boom />
      </ShellBoundary>,
    );

    expect(screen.getByTestId('shell-boundary-fallback').textContent).not.toContain('—');
  });

  it('logs the failure with the widget label, because the marker is too small to diagnose', () => {
    render(
      <ShellBoundary label="Spend indicator">
        <Boom />
      </ShellBoundary>,
    );

    const logged = consoleError.mock.calls.some((call: unknown[]) =>
      String(call[0]).includes('[shell] Spend indicator failed to render'),
    );
    expect(logged).toBe(true);
  });
});
