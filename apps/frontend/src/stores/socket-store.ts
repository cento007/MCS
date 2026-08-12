import { create } from 'zustand';
import type { ConnectionState, SocketSnapshot } from '../lib/ws/socket-client.js';

/**
 * `socketStore` — connection status, active subscriptions, last-connected timestamp
 * (TDS 05 §3). This is the trust indicator for the whole product: TDS 06 §3.3 makes the
 * point plainly — "everything on a monitoring dashboard is a claim about the present. If
 * the WebSocket is down, every dot, duration and count on screen is a claim about the past,
 * and nothing on screen says so."
 *
 * The store is a projection of `SocketClient.snapshot` plus one thing the client cannot
 * know: whether the browser itself thinks it has a network. It holds no socket and starts
 * no connection.
 */

/** The three states TDS 06 §3.3 renders on the ConnectionChip. */
export type ConnectionStatus = 'live' | 'reconnecting' | 'offline';

/**
 * How many consecutive failed attempts before the chip stops saying "reconnecting" and
 * says "offline" with a `[Retry]`.
 *
 * §5.1's backoff has no terminal state — it caps at 30 s and keeps trying forever, which is
 * right. But §3.3 defines `offline` as "backoff exhausted or the browser is offline", and a
 * chip that reads `reconnecting` after ten minutes of failure is telling the operator to
 * keep waiting for something that is not coming back on its own. So: after this many
 * attempts (~1 minute of doubling from 1 s) the *label* becomes `offline` while the retry
 * loop continues underneath. Nothing is given up; only the claim changes.
 */
export const OFFLINE_AFTER_ATTEMPTS = 6;

export interface SocketStoreState {
  readonly state: ConnectionState;
  readonly attempt: number;
  readonly connectionId: string | null;
  readonly lastConnectedAt: number | null;
  readonly lastFrameAt: number | null;
  readonly nextAttemptAt: number | null;
  readonly authFailed: boolean;
  readonly channels: readonly string[];
  /** `navigator.onLine`, mirrored by the socket provider. */
  readonly browserOnline: boolean;
  /**
   * Epoch ms at which liveness was lost — the instant the socket last left `open`, or the
   * page load if it never reached it. Every ticking value in the UI freezes at this mark
   * (§3.3), so it is the single source for "as of when is this screen true?".
   */
  readonly frozenAt: number | null;

  applySnapshot(snapshot: SocketSnapshot, now?: number): void;
  setBrowserOnline(online: boolean): void;
  reset(): void;
}

const INITIAL = {
  state: 'idle' as ConnectionState,
  attempt: 0,
  connectionId: null,
  lastConnectedAt: null,
  lastFrameAt: null,
  nextAttemptAt: null,
  authFailed: false,
  channels: [] as readonly string[],
  browserOnline: true,
  frozenAt: null,
} satisfies Omit<SocketStoreState, 'applySnapshot' | 'setBrowserOnline' | 'reset'>;

export const useSocketStore = create<SocketStoreState>((set) => ({
  ...INITIAL,

  applySnapshot: (snapshot, now = Date.now()) =>
    set((previous) => {
      const wasLive = previous.state === 'open';
      const isLive = snapshot.state === 'open';
      return {
        state: snapshot.state,
        attempt: snapshot.attempt,
        connectionId: snapshot.connectionId,
        lastConnectedAt: snapshot.lastConnectedAt,
        lastFrameAt: snapshot.lastFrameAt,
        nextAttemptAt: snapshot.nextAttemptAt,
        authFailed: snapshot.authFailed,
        channels: snapshot.channels,
        // Freeze on the falling edge only. Re-freezing on every backoff tick would drag the
        // "last updated" mark forward while nothing was actually updating — the exact class
        // of confidently-wrong data §3.3 forbids.
        frozenAt: isLive ? null : wasLive ? now : (previous.frozenAt ?? now),
      };
    }),

  setBrowserOnline: (online) =>
    set((previous) => ({
      browserOnline: online,
      frozenAt: online ? previous.frozenAt : (previous.frozenAt ?? Date.now()),
    })),

  reset: () => set({ ...INITIAL }),
}));

/** The chip state (TDS 06 §3.3). Pure so it can be unit-tested without a store instance. */
export function selectConnectionStatus(state: SocketStoreState): ConnectionStatus {
  if (!state.browserOnline) return 'offline';
  if (state.state === 'open') return 'live';
  if (state.state === 'idle') return 'offline';
  return state.attempt > OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'reconnecting';
}

/**
 * The instant every live region on screen is true "as of". `null` while live — nothing is
 * frozen, so nothing needs a "last updated" line.
 */
export function selectFrozenAt(state: SocketStoreState): number | null {
  return state.state === 'open' && state.browserOnline
    ? null
    : (state.frozenAt ?? state.lastConnectedAt);
}

export function selectIsLive(state: SocketStoreState): boolean {
  return selectConnectionStatus(state) === 'live';
}
