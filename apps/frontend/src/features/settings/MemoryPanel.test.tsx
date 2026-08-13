import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiMock, dataBody, mockApi } from '../../test/api-mock.js';
import { makeMemorySettings, renderSettingsPage } from './test-support.js';

/**
 * Settings → Memory (PRD §4.4 item 4).
 *
 * Three properties, in order of what they cost when they are wrong:
 *
 *  1. **Nothing is drawn for a key the Backend did not serve.** This category's controls decide
 *     what gets deleted, and a switch nothing reads is indistinguishable on screen from one that
 *     works. Today's Backend serves `{}`, so this is not a hypothetical state.
 *  2. **A save is a full-category replace** (A14) — including the keys this screen never rendered,
 *     because an omitted field is a reset to default rather than a no-op.
 *  3. **Shortening a retention window confirms first.** Through the *form engine*, so `Ctrl+S` and
 *     the unsaved-changes guard's own `[Save]` cannot walk around it.
 *
 * Rendered through `renderSettingsPage`, which builds a **data router**: `useBlocker` — the
 * unsaved-changes guard — exists nowhere else, and it is the path an operator takes when they are
 * already leaving.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/settings/memory', { body: dataBody(makeMemorySettings()) });
  api.on('PUT', '/settings/memory', { body: dataBody(makeMemorySettings()) });
});

afterEach(() => {
  api.restore();
});

function putBodies(): readonly Record<string, unknown>[] {
  return api
    .callsTo('/settings/memory')
    .filter((call) => call.method === 'PUT')
    .map((call) => call.body as Record<string, unknown>);
}

// ------------------------------------------------------------------ 1. only what is served

describe('the panel renders the served document and nothing else', () => {
  it('draws one retention control per tier and one toggle per source', async () => {
    renderSettingsPage('/settings/memory');

    expect(await screen.findByLabelText('Session memory')).toHaveValue('90');
    expect(screen.getByLabelText('Project memory')).toHaveValue('never');
    expect(screen.getByRole('checkbox', { name: /Pull request/ })).toBeChecked();
    // The tier that nothing writes yet is absent from the document, so it is absent here.
    expect(screen.queryByLabelText('Agent memory')).toBeNull();
  });

  it('says the Backend serves no memory settings rather than showing plausible defaults', async () => {
    // This is today's Backend: the route exists, the key registry has no `memory` entries.
    api.on('GET', '/settings/memory', { body: dataBody({}) });
    renderSettingsPage('/settings/memory');

    const note = await screen.findByTestId('memory-settings-absent');
    expect(note).toHaveTextContent('serves no memory settings');
    expect(note).toHaveTextContent('/api/v1/settings/memory');
    expect(screen.queryByLabelText('Session memory')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    // Distinct from "no such route", which is a different fact with a different fix.
    expect(screen.queryByTestId('endpoint-unavailable')).toBeNull();
  });

  it('keeps "no such route" distinguishable from "an empty document"', async () => {
    api.on('GET', '/settings/memory', {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'not served', requestId: 'test-req' } },
    });
    renderSettingsPage('/settings/memory');

    expect(await screen.findByTestId('endpoint-unavailable')).toHaveTextContent(
      '/api/v1/settings/memory',
    );
    expect(screen.queryByTestId('memory-settings-absent')).toBeNull();
  });

  it('renders half a contract as half a panel and names the missing half', async () => {
    api.on('GET', '/settings/memory', {
      body: dataBody({ indexedSources: { session: true, commit: true } }),
    });
    renderSettingsPage('/settings/memory');

    expect(await screen.findByRole('checkbox', { name: /Session/ })).toBeInTheDocument();
    expect(screen.queryByLabelText('Session memory')).toBeNull();
    expect(screen.getByTestId('memory-settings-partial')).toHaveTextContent(
      'does not serve retention windows per memory tier',
    );
  });

  it('discloses a key it cannot render, because it writes that key back', async () => {
    api.on('GET', '/settings/memory', {
      body: dataBody({ ...makeMemorySettings(), pruneOnDisable: true }),
    });
    renderSettingsPage('/settings/memory');

    expect(await screen.findByTestId('memory-settings-carried')).toHaveTextContent(
      'pruneOnDisable',
    );
  });
});

// ------------------------------------------------------------------ 2. full-category replace

describe('saving', () => {
  /** Every source on except one, so switching it back on is a save with no consequences. */
  function withCommitOff(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return makeMemorySettings({
      indexedSources: {
        session: true,
        commit: false,
        adr: true,
        obsidianNote: true,
        pullRequest: true,
        document: true,
      },
      ...extra,
    });
  }

  it('sends the whole category, not the one field that changed', async () => {
    const user = userEvent.setup();
    api.on('GET', '/settings/memory', { body: dataBody(withCommitOff()) });
    renderSettingsPage('/settings/memory');

    await user.click(await screen.findByRole('checkbox', { name: /Commit/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    // An omitted non-secret field is a reset to default (A14), so a partial body here would
    // silently re-enable every other source and wipe the retention windows.
    expect(putBodies()[0]).toEqual({
      retentionDays: { session: 90, project: 0, global: 0 },
      indexedSources: {
        session: true,
        commit: true,
        adr: true,
        obsidianNote: true,
        pullRequest: true,
        document: true,
      },
    });
  });

  it('writes back a field it never rendered', async () => {
    const user = userEvent.setup();
    api.on('GET', '/settings/memory', {
      body: dataBody({ ...withCommitOff(), pruneOnDisable: true }),
    });
    renderSettingsPage('/settings/memory');

    await user.click(await screen.findByRole('checkbox', { name: /Commit/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]?.['pruneOnDisable']).toBe(true);
  });

  it('widening a window needs no confirmation — nothing is lost by keeping more', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/memory');

    await user.selectOptions(await screen.findByLabelText('Session memory'), '365');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]?.['retentionDays']).toEqual({ session: 365, project: 0, global: 0 });
  });
});

// --------------------------------------------------------------- 3. the destructive confirm

describe('shortening a retention window', () => {
  it('confirms before anything is sent, with both numbers and the cost of undoing it', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/memory');

    await user.selectOptions(await screen.findByLabelText('Session memory'), '30');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('dialog', {
      name: 'Shorten retention and delete stored memory?',
    });
    expect(within(dialog).getByText(/90 days → 30 days/)).toBeInTheDocument();
    expect(within(dialog).getByText(/re-embedding the sources/)).toBeInTheDocument();
    // The confirm is the gate, not a formality after the fact.
    expect(putBodies()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Shorten and delete' }));

    await waitFor(() => expect(putBodies()).toHaveLength(1));
    expect(putBodies()[0]?.['retentionDays']).toEqual({ session: 30, project: 0, global: 0 });
  });

  it('cancelling sends nothing and leaves the edit intact', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/memory');

    await user.selectOptions(await screen.findByLabelText('Session memory'), '30');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('dialog', { name: /Shorten retention/ });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(putBodies()).toHaveLength(0);
    // Still dirty, still 30 — a cancelled save is not a discard.
    expect(screen.getByLabelText('Session memory')).toHaveValue('30');
    expect(screen.getByTestId('save-bar')).toBeInTheDocument();
  });

  it('confirms a source being switched off too, without calling it a deletion', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/memory');

    await user.click(await screen.findByRole('checkbox', { name: /Obsidian note/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('dialog', { name: 'Stop indexing these sources?' });
    expect(within(dialog).getByText(/Nothing already indexed is deleted/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/deletes stored chunks/)).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Stop indexing' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
  });

  it('cannot be walked around by Ctrl+S', async () => {
    const user = userEvent.setup();
    renderSettingsPage('/settings/memory');

    const select = await screen.findByLabelText('Session memory');
    await user.selectOptions(select, '30');
    select.focus();
    await user.keyboard('{Control>}s{/Control}');

    expect(await screen.findByRole('dialog', { name: /Shorten retention/ })).toBeInTheDocument();
    expect(putBodies()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ the unsaved-changes guard

describe('the unsaved-changes guard', () => {
  it('blocks a route change and names this panel', async () => {
    const user = userEvent.setup();
    const { router } = renderSettingsPage('/settings/memory');

    await user.click(await screen.findByRole('checkbox', { name: /Commit/ }));
    await act(async () => {
      await router.navigate('/sessions');
    });

    expect(await screen.findByTestId('unsaved-message')).toHaveTextContent(
      'You have 1 unsaved change in Memory.',
    );
    expect(screen.queryByText('Sessions screen')).toBeNull();
  });

  it('routes the guard’s own [Save] through the confirmation as well', async () => {
    // The path this whole seam exists for: an operator who is already leaving is the last person
    // who should be able to shorten retention without being told what it costs.
    const user = userEvent.setup();
    const { router } = renderSettingsPage('/settings/memory');

    await user.selectOptions(await screen.findByLabelText('Session memory'), '30');
    await act(async () => {
      await router.navigate('/sessions');
    });
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: /Shorten retention/ });
    expect(putBodies()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: 'Shorten and delete' }));
    await waitFor(() => expect(putBodies()).toHaveLength(1));
    // The save landed, so the navigation it was blocking proceeds.
    expect(await screen.findByText('Sessions screen')).toBeInTheDocument();
  });

  it('a cancelled confirmation does not navigate away either', async () => {
    const user = userEvent.setup();
    const { router } = renderSettingsPage('/settings/memory');

    await user.selectOptions(await screen.findByLabelText('Session memory'), '30');
    await act(async () => {
      await router.navigate('/sessions');
    });
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: /Shorten retention/ })).getByRole('button', {
        name: 'Cancel',
      }),
    );

    await waitFor(() => expect(screen.queryByTestId('unsaved-message')).toBeNull());
    expect(putBodies()).toHaveLength(0);
    expect(screen.queryByText('Sessions screen')).toBeNull();
    expect(screen.getByLabelText('Session memory')).toHaveValue('30');
  });
});
