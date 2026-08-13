import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { useUiStore } from '../../../stores/ui-store.js';
import { makeSession, renderWithProviders } from '../test-support.js';
import { SessionPanel } from './SessionPanel.js';

/**
 * Regression cover for the session panel's tablist keyboard model.
 *
 * The defect these tests pin: `tabIndex` is derived from the selected tab, so changing the
 * selection without moving DOM focus leaves focus on a button that has just become
 * `tabIndex={-1}`. The roving tabindex is then broken in the way that actually costs a
 * keyboard operator something — focus is on an element that is no longer the tablist's tab
 * stop, so the next `Tab` leaves the widget and the newly selected tab is unreachable. It is
 * also how a phase-gated tab becomes unreachable without ever being marked `disabled`, which
 * is precisely the affordance lie WS5's WC9 rule exists to prevent.
 */

/**
 * jsdom implements no `matchMedia`, so `useMediaQuery` reports `false` for every query — and
 * `SessionPanel` reads that as "not a wide viewport" and collapses itself to the icon rail,
 * which renders plain buttons rather than a tablist. Stub a desktop viewport so the component
 * under test is the expanded panel.
 */
function stubWideViewport() {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('min-width: 1440px'),
        media: query,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

function renderPanel() {
  stubWideViewport();
  // Set inside the helper, not in `beforeEach`: the shared test setup resets store singletons
  // between tests, and its hook order relative to this file's is not something to rely on.
  useUiStore.setState({ panelTab: 'commits', panelCollapsed: false });

  return renderWithProviders(
    <SessionPanel
      session={makeSession({ state: 'running' })}
      scrollToTime={vi.fn()}
      onSaveNotes={vi.fn()}
      savingNotes={false}
    />,
  );
}

describe('the session panel tablist moves focus, not just selection', () => {
  it('ArrowRight selects the next tab AND focuses it', async () => {
    const user = userEvent.setup();
    renderPanel();

    const commits = screen.getByRole('tab', { name: /commits/i });
    commits.focus();
    await user.keyboard('{ArrowRight}');

    const files = screen.getByRole('tab', { name: /files/i });
    expect(files).toHaveAttribute('aria-selected', 'true');
    expect(files).toHaveFocus();
    // The exclusive tab stop must follow the focus, or Tab escapes the widget.
    expect(files).toHaveAttribute('tabindex', '0');
    expect(commits).toHaveAttribute('tabindex', '-1');
  });

  it('ArrowLeft wraps to the last tab and focuses it', async () => {
    const user = userEvent.setup();
    renderPanel();

    screen.getByRole('tab', { name: /commits/i }).focus();
    await user.keyboard('{ArrowLeft}');

    const notes = screen.getByRole('tab', { name: /notes/i });
    expect(notes).toHaveAttribute('aria-selected', 'true');
    expect(notes).toHaveFocus();
  });

  it('Home and End jump to the first and last tab', async () => {
    const user = userEvent.setup();
    renderPanel();

    screen.getByRole('tab', { name: /commits/i }).focus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /notes/i })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: /commits/i })).toHaveFocus();
  });

  it('keeps exactly one tab stop no matter how far the arrows travel', async () => {
    const user = userEvent.setup();
    renderPanel();

    screen.getByRole('tab', { name: /commits/i }).focus();
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}');

    const stops = screen.getAllByRole('tab').filter((tab) => tab.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveFocus();
  });
});
