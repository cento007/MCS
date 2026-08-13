import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ApiMock, dataBody, mockApi } from '../../test/api-mock.js';
import { ServicesSettingsPanel } from './panels/ServicesSettingsPanel.js';
import { makeHealth, renderPanel } from './test-support.js';

/**
 * Settings → Services (PRD §4.4.7, TDS 06 §5.7.12).
 *
 * Two claims are worth a test more than the table itself is:
 *
 *  1. **`disabled` is not styled as a failure.** On a correct Phase 1 install four rows report
 *     `disabled` — Qdrant, Ollama and the two Phase 2 workers — and a panel that paints those
 *     red is one operators learn to ignore, taking the real failures with it.
 *  2. **The queue row reads "Queue (PostgreSQL)".** There is no Redis in this topology (F2.1/F3)
 *     and the label comes from the server, so the UI cannot invent a service.
 */

let api: ApiMock;

beforeEach(() => {
  api = mockApi();
  api.on('GET', '/services/health', { body: dataBody(makeHealth()) });
});

afterEach(() => {
  api.restore();
});

describe('<ServicesSettingsPanel>', () => {
  it('renders every service with its server-supplied label', async () => {
    renderPanel(<ServicesSettingsPanel />);
    expect(await screen.findByText('Queue (PostgreSQL)')).toBeInTheDocument();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('Telegram Worker')).toBeInTheDocument();
    expect(screen.getByText('Sync Worker')).toBeInTheDocument();
    expect(screen.getByText('Qdrant')).toBeInTheDocument();
    expect(screen.getByText('Ollama')).toBeInTheDocument();
    // Redis does not exist in this system and must never appear in this UI.
    expect(screen.queryByText(/redis/i)).toBeNull();
  });

  it('renders all five ServiceStatus values with their own word and glyph', async () => {
    renderPanel(<ServicesSettingsPanel />);
    await screen.findByText('Queue (PostgreSQL)');

    // Glyph and word are separate elements, so the assertion normalises whitespace away —
    // what matters is that both channels are present, never colour alone (§7.1.9).
    const statusOf = (name: string) => screen.getByTestId(`service-status-${name}`).textContent;
    expect(statusOf('postgresql')).toBe('●healthy');
    expect(statusOf('queue')).toBe('▲degraded');
    expect(statusOf('sync-worker')).toBe('✕down');
    expect(statusOf('telegram-worker')).toBe('◌disabled');
    expect(statusOf('ollama')).toBe('?unknown');
  });

  it('does not style `disabled` as a failure', async () => {
    renderPanel(<ServicesSettingsPanel />);
    await screen.findByText('Queue (PostgreSQL)');

    for (const name of ['telegram-worker', 'qdrant']) {
      const status = screen.getByTestId(`service-status-${name}`);
      expect(status).toHaveAttribute('data-status', 'disabled');
      expect(status).toHaveAttribute('data-attention', 'false');
      expect(status).not.toHaveTextContent('down');
      // No `[view error]` either: a not-deployed service has no error, and offering the
      // affordance would imply a fault the contract explicitly denies.
      expect(
        within(screen.getByTestId(`service-row-${name}`)).queryByRole('button', {
          name: 'view error',
        }),
      ).toBeNull();
    }

    expect(screen.getByTestId('service-status-sync-worker')).toHaveAttribute(
      'data-attention',
      'true',
    );
  });

  it('explains a degraded row on demand', async () => {
    const user = userEvent.setup();
    renderPanel(<ServicesSettingsPanel />);
    await screen.findByText('Queue (PostgreSQL)');

    const row = screen.getByTestId('service-row-queue');
    await user.click(within(row).getByRole('button', { name: 'view error' }));

    // The probe's own `meta` is shown verbatim — it is the only machine-readable evidence the
    // panel receives, and paraphrasing it would lose it.
    expect(screen.getByTestId('service-error-queue')).toHaveTextContent('"failed": 1');
  });

  it('states the Backend build and uptime on its own line', async () => {
    renderPanel(<ServicesSettingsPanel />);
    const line = await screen.findByTestId('backend-line');
    expect(line).toHaveTextContent('Backend · uptime 3d 4h · v0.1.0 · 1/3 session slots');
  });

  it('says the panel is polled, and why', async () => {
    renderPanel(<ServicesSettingsPanel />);
    await screen.findByText('Queue (PostgreSQL)');
    expect(screen.getByText('auto-refresh 10s')).toBeInTheDocument();
    expect(
      screen.getByText(/has to stay observable when the socket itself is the failing component/),
    ).toBeInTheDocument();
  });

  it('reports a health endpoint failure instead of an empty table', async () => {
    api.on('GET', '/services/health', {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom', requestId: 'test-req' } },
    });
    renderPanel(<ServicesSettingsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('INTERNAL');
  });
});
