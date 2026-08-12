import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SocketSnapshot } from '../../lib/ws/socket-client.js';
import {
  OFFLINE_AFTER_ATTEMPTS,
  selectConnectionStatus,
  useSocketStore,
} from '../../stores/socket-store.js';
import { ConnectionChip } from './ConnectionChip.js';

/**
 * The ConnectionChip (TDS 06 §3.3) — the trust indicator the whole shell hangs on.
 */

function snapshot(overrides: Partial<SocketSnapshot> = {}): SocketSnapshot {
  return {
    state: 'idle',
    attempt: 0,
    connectionId: null,
    lastConnectedAt: null,
    lastFrameAt: null,
    nextAttemptAt: null,
    authFailed: false,
    channels: [],
    ...overrides,
  };
}

function apply(overrides: Partial<SocketSnapshot>): void {
  act(() => {
    useSocketStore.getState().applySnapshot(snapshot(overrides));
  });
}

describe('selectConnectionStatus', () => {
  it('maps the state machine onto the three chip states', () => {
    apply({ state: 'open', connectionId: 'c1', lastConnectedAt: 1 });
    expect(selectConnectionStatus(useSocketStore.getState())).toBe('live');

    apply({ state: 'connecting' });
    expect(selectConnectionStatus(useSocketStore.getState())).toBe('reconnecting');

    apply({ state: 'backoff', attempt: 2 });
    expect(selectConnectionStatus(useSocketStore.getState())).toBe('reconnecting');

    apply({ state: 'idle' });
    expect(selectConnectionStatus(useSocketStore.getState())).toBe('offline');
  });

  it('stops claiming "reconnecting" once backoff has clearly failed', () => {
    apply({ state: 'backoff', attempt: OFFLINE_AFTER_ATTEMPTS + 1 });
    expect(selectConnectionStatus(useSocketStore.getState())).toBe('offline');
  });

  it('reports offline whenever the browser itself has no network', () => {
    apply({ state: 'open', connectionId: 'c1' });
    act(() => useSocketStore.getState().setBrowserOnline(false));
    expect(selectConnectionStatus(useSocketStore.getState())).toBe('offline');
  });
});

describe('rendering', () => {
  it('renders the live label with a status role so a change is announced', () => {
    apply({ state: 'open', connectionId: 'c1', lastConnectedAt: Date.now() });
    render(<ConnectionChip />);
    expect(screen.getByRole('status')).toHaveTextContent('live');
  });

  it('renders reconnecting while the client is backing off', () => {
    apply({ state: 'backoff', attempt: 1, nextAttemptAt: Date.now() + 750 });
    render(<ConnectionChip />);
    expect(screen.getByRole('status')).toHaveTextContent('reconnecting');
  });

  it('renders offline and discloses that it has never connected', () => {
    apply({ state: 'idle' });
    render(<ConnectionChip />);
    const chip = screen.getByRole('status');
    expect(chip).toHaveTextContent('offline');
    expect(chip.getAttribute('title')).toContain('never connected');
  });

  it('offers no Retry button outside a socket provider, rather than a dead control', () => {
    apply({ state: 'idle' });
    render(<ConnectionChip />);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});
