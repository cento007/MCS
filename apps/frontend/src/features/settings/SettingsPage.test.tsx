import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiMock, dataBody, listBody, mockApi } from '../../test/api-mock.js';
import {
  makeGeneral,
  makeHealth,
  makeIntegrations,
  makeMemorySettings,
  makeNotifications,
  makeSecurity,
  renderSettingsPage,
} from './test-support.js';

/**
 * The Settings screen as a whole (TDS 06 §5.7): the category rail, phase gating, and the
 * unsaved-changes guard on category change, route change and `beforeunload`.
 *
 * The guard is the reason this suite renders a **data router**: `useBlocker` only exists there,
 * and it is what covers the rail, the main nav, the command palette and browser back/forward
 * with a single rule.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/settings/general', { body: dataBody(makeGeneral()) });
  api.on('GET', '/settings/integrations', { body: dataBody(makeIntegrations()) });
  api.on('GET', '/settings/notifications', { body: dataBody(makeNotifications()) });
  api.on('GET', '/settings/memory', { body: dataBody(makeMemorySettings()) });
  api.on('GET', '/settings/security', { body: dataBody(makeSecurity()) });
  api.on('GET', '/services/health', { body: dataBody(makeHealth()) });
  api.on('GET', '/auth/tokens', { body: listBody([]) });
  api.on('GET', '/spend', { status: 404, body: notFound() });
});

afterEach(() => {
  api.restore();
});

function notFound(): unknown {
  return { error: { code: 'NOT_FOUND', message: 'not served', requestId: 'test-req' } };
}

describe('category rail', () => {
  it('lists the seven PRD §4.4 categories in order', async () => {
    renderSettingsPage();
    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    expect(
      within(rail)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual([
      'General',
      'Integrations',
      'Notifications',
      'MemoryP3',
      'AgentsP4',
      'Security',
      'Services',
    ]);
    await screen.findByLabelText('Instance name');
  });

  it('says so plainly for an unknown category rather than rendering nothing', async () => {
    renderSettingsPage('/settings/nonsense');
    expect(await screen.findByText('Unknown settings category')).toBeInTheDocument();
  });
});

describe('phase-gated categories (§2.5)', () => {
  it('are reachable by keyboard and are never disabled', async () => {
    const user = userEvent.setup();
    renderSettingsPage();

    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    const memory = within(rail).getByRole('link', { name: /Memory/ });

    // Focusable, focus-visible, and NOT aria-disabled: the target does something (it routes),
    // so `disabled` would be a lie to both pointer and screen-reader users, and
    // `--color-text-disabled` is exempt from the AA contrast floor.
    expect(memory).not.toHaveAttribute('aria-disabled');
    expect(memory).not.toHaveAttribute('disabled');
    memory.focus();
    expect(memory).toHaveFocus();

    await user.keyboard('{Enter}');
    // Memory is Phase 3 and Phase 3 has landed: the category routes to its real panel, which
    // renders whatever `GET /settings/memory` served — see `MemoryPanel.test.tsx`.
    expect(await screen.findByLabelText('Session memory')).toBeInTheDocument();
    // The rail keeps the muted P3 tag rather than dimmed label text; it marks the phase the
    // category belongs to, exactly as the main nav's Memory entry does.
    expect(within(rail).getAllByTitle('Available in Phase 3').length).toBeGreaterThan(0);
  });

  it('routes Agents to its real panel, and draws only the key that has a reader', async () => {
    // Phase 4 has landed. The placeholder this replaced promised "default runtime and default
    // permission template"; only the second was ever declared in the shared key registry, and the
    // first was withdrawn deliberately — `AGENT_RUNTIMES` has one member, so a picker over it
    // chooses nothing. Advertising it would be the `integrations.ollama.enabled` mistake again.
    renderSettingsPage('/settings/agents');

    expect(await screen.findByLabelText('Default permission template')).toBeInTheDocument();
    expect(screen.queryByLabelText(/default runtime/i)).toBeNull();
    expect(
      screen.getByText(/There is no control for it and that is deliberate/),
    ).toBeInTheDocument();
  });
});

describe('unsaved-changes guard (§5.7)', () => {
  async function dirtyTheGeneralPanel(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup();
    await screen.findByLabelText('Instance name');
    await user.type(screen.getByLabelText('Instance name'), '!');
    expect(screen.getByTestId('save-bar')).toBeInTheDocument();
    return user;
  }

  it('blocks a CATEGORY change and names the panel and the count', async () => {
    renderSettingsPage();
    const user = await dirtyTheGeneralPanel();

    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    await user.click(within(rail).getByRole('link', { name: 'Notifications' }));

    expect(await screen.findByTestId('unsaved-message')).toHaveTextContent(
      'You have 1 unsaved change in General.',
    );
    // Still on General — the navigation did not happen.
    expect(screen.getByLabelText('Instance name')).toBeInTheDocument();
  });

  it('blocks a ROUTE change out of Settings', async () => {
    const { router } = renderSettingsPage();
    await dirtyTheGeneralPanel();

    await act(async () => {
      await router.navigate('/sessions');
    });

    expect(await screen.findByTestId('unsaved-message')).toBeInTheDocument();
    expect(screen.queryByText('Sessions screen')).toBeNull();
  });

  it('[Keep editing] stays put and preserves the edit', async () => {
    renderSettingsPage();
    const user = await dirtyTheGeneralPanel();

    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    await user.click(within(rail).getByRole('link', { name: 'Notifications' }));
    await user.click(await screen.findByRole('button', { name: 'Keep editing' }));

    await waitFor(() => expect(screen.queryByTestId('unsaved-message')).toBeNull());
    expect(screen.getByLabelText('Instance name')).toHaveValue('Mission Control — Home!');
    expect(screen.getByTestId('save-bar')).toBeInTheDocument();
  });

  it('[Discard] drops the edit and proceeds', async () => {
    renderSettingsPage();
    const user = await dirtyTheGeneralPanel();

    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    await user.click(within(rail).getByRole('link', { name: 'Notifications' }));
    // Scoped to the guard modal: the panel's own Save bar also carries a [Discard].
    const dialog = await screen.findByRole('dialog', { name: 'Unsaved changes' });
    await user.click(within(dialog).getByRole('button', { name: 'Discard' }));

    expect(await screen.findByText('Quiet hours')).toBeInTheDocument();
  });

  it('[Save] commits and then proceeds', async () => {
    api.on('PUT', '/settings/general', {
      body: dataBody(makeGeneral({ instanceName: 'Mission Control — Home!' })),
    });
    renderSettingsPage();
    const user = await dirtyTheGeneralPanel();

    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    await user.click(within(rail).getByRole('link', { name: 'Notifications' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Quiet hours')).toBeInTheDocument();
    const put = api.callsTo('/settings/general').find((call) => call.method === 'PUT');
    expect(put).toBeDefined();
    expect((put?.body as Record<string, unknown> | undefined)?.['instanceName']).toBe(
      'Mission Control — Home!',
    );
  });

  it('a FAILED save does not navigate away — the edits it was protecting survive', async () => {
    api.on('PUT', '/settings/general', {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom', requestId: 'test-req' } },
    });
    renderSettingsPage();
    const user = await dirtyTheGeneralPanel();

    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    await user.click(within(rail).getByRole('link', { name: 'Notifications' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByTestId('unsaved-message')).toBeNull());
    expect(screen.getByLabelText('Instance name')).toHaveValue('Mission Control — Home!');
    expect(screen.getByTestId('save-bar')).toBeInTheDocument();
  });

  it('registers beforeunload only while dirty', async () => {
    renderSettingsPage();
    await screen.findByLabelText('Instance name');

    expect(dispatchBeforeUnload().defaultPrevented).toBe(false);

    await dirtyTheGeneralPanel();
    // `beforeunload` covers leaving the app, where the router blocker never fires.
    await waitFor(() => expect(dispatchBeforeUnload().defaultPrevented).toBe(true));
  });

  it('lets a clean panel navigate freely', async () => {
    const user = userEvent.setup();
    renderSettingsPage();
    await screen.findByLabelText('Instance name');

    const rail = screen.getByRole('navigation', { name: 'Settings categories' });
    await user.click(within(rail).getByRole('link', { name: 'Services' }));

    expect(await screen.findByText('Queue (PostgreSQL)')).toBeInTheDocument();
    expect(screen.queryByTestId('unsaved-message')).toBeNull();
  });
});

describe('when a settings route is missing, nothing is invented', () => {
  it('shows no value in any control and names the route', async () => {
    api.on('GET', '/settings/general', { status: 404, body: notFound() });
    renderSettingsPage();

    expect(await screen.findByTestId('endpoint-unavailable')).toHaveTextContent(
      '/api/v1/settings/general',
    );

    // A disabled `<select>` otherwise silently selects its first option — Timezone would read
    // `Africa/Abidjan` and Theme `Dark (default)`, which are indistinguishable from settings an
    // operator had saved. Every control must read as empty instead.
    expect(screen.getByLabelText('Instance name')).toHaveValue('');
    for (const label of [
      'Timezone',
      'Date format',
      'Time format',
      'Theme',
      'Default landing page',
    ]) {
      const control = screen.getByLabelText(label);
      expect(control).toBeDisabled();
      expect(control).toHaveValue('');
      expect(within(control).getByRole('option', { name: '— not loaded' })).toBeInTheDocument();
    }
  });

  it('does not preselect a radio group either', async () => {
    api.on('GET', '/settings/integrations', { status: 404, body: notFound() });
    renderSettingsPage('/settings/integrations');

    await screen.findAllByTestId('endpoint-unavailable');
    // "Manual" is the API default, but showing it selected would claim a stored value.
    expect(screen.getByRole('radio', { name: 'Manual' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Assisted' })).not.toBeChecked();
  });
});

describe('Ctrl+S (§5.7)', () => {
  it('saves the dirty panel from inside one of its own text fields', async () => {
    const user = userEvent.setup();
    api.on('PUT', '/settings/general', {
      body: dataBody(makeGeneral({ instanceName: 'Mission Control — Home!' })),
    });
    renderSettingsPage();

    const input = await screen.findByLabelText('Instance name');
    await user.type(input, '!');
    // Focus is inside a text field, which is exactly where the global shortcut registry
    // suppresses every chord — hence the panel-local handler.
    await user.keyboard('{Control>}s{/Control}');

    await waitFor(() =>
      expect(api.callsTo('/settings/general').some((call) => call.method === 'PUT')).toBe(true),
    );
  });
});

function dispatchBeforeUnload(): Event {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event;
}
