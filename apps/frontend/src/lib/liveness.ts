import { useEffect, useState } from 'react';
import {
  type ConnectionStatus,
  selectConnectionStatus,
  selectFrozenAt,
  useSocketStore,
} from '../stores/socket-store.js';
import { formatClock, formatDuration, formatFrozenDuration } from './format/index.js';

/**
 * The degraded-liveness rule (TDS 06 §3.3), implemented once.
 *
 * > "**All client-side ticking durations FREEZE at their last known value.** A duration
 * > counter that keeps incrementing while the socket is dead is actively lying to the
 * > operator: it renders as though the session were confirmed alive when the truth is
 * > unknown."
 *
 * The mechanism is a single hook — `useLiveClock` — which stops advancing when the
 * connection is not `live`. Everything downstream of it (durations, "n minutes ago",
 * countdowns) then freezes for free, because they are all functions of `now`. Freezing at
 * the leaf, one component at a time, would guarantee that some future component forgets.
 */

export function useConnectionStatus(): ConnectionStatus {
  return useSocketStore(selectConnectionStatus);
}

export function useIsLive(): boolean {
  return useSocketStore(selectConnectionStatus) === 'live';
}

export interface LiveClock {
  /** Epoch ms. Advances once a second while live; pinned to `frozenAt` when not. */
  readonly now: number;
  readonly frozen: boolean;
  /** When the screen stopped being verifiable. `null` while live. */
  readonly frozenAt: number | null;
}

/**
 * A clock that stops when the socket does.
 *
 * Note the interval is only *installed* while live — a frozen clock costs no timer, so a
 * dashboard left open on a dead connection stops doing work entirely rather than spinning
 * a second-resolution render loop over values that cannot change.
 */
export function useLiveClock(intervalMs = 1_000): LiveClock {
  const frozenAt = useSocketStore(selectFrozenAt);
  const [tick, setTick] = useState<number>(() => Date.now());

  useEffect(() => {
    if (frozenAt !== null) return;
    setTick(Date.now());
    const handle = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(handle);
  }, [frozenAt, intervalMs]);

  return frozenAt === null
    ? { now: tick, frozen: false, frozenAt: null }
    : { now: frozenAt, frozen: true, frozenAt };
}

export interface Elapsed {
  readonly seconds: number | null;
  /** True only for a duration that WOULD still be counting. See `elapsedSeconds`. */
  readonly frozen: boolean;
}

/**
 * Elapsed seconds between two instants, with the freeze rule applied.
 *
 * A **finished** duration (`endedAt` present) is server truth about the past and never
 * freezes — it is not a claim about the present, so marking it `~` would be noise. Only a
 * duration still counting against `now` can be wrong, and only that one freezes.
 */
export function elapsedSeconds(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
  clock: LiveClock,
): Elapsed {
  if (startedAt === null || startedAt === undefined) return { seconds: null, frozen: false };
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return { seconds: null, frozen: false };

  if (endedAt !== null && endedAt !== undefined) {
    const end = Date.parse(endedAt);
    if (!Number.isNaN(end)) return { seconds: Math.max(0, (end - start) / 1000), frozen: false };
  }

  return { seconds: Math.max(0, (clock.now - start) / 1000), frozen: clock.frozen };
}

export function useElapsed(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): Elapsed {
  const clock = useLiveClock();
  return elapsedSeconds(startedAt, endedAt, clock);
}

/** `00:42:10` while live, `~00:42:10` once the socket is not (TDS 06 §3.3). */
export function formatElapsed(elapsed: Elapsed): string {
  return elapsed.frozen ? formatFrozenDuration(elapsed.seconds) : formatDuration(elapsed.seconds);
}

export function useDurationLabel(
  startedAt: string | null | undefined,
  endedAt: string | null | undefined,
): string {
  return formatElapsed(useElapsed(startedAt, endedAt));
}

/**
 * The "last updated HH:MM" affordance every degraded live region appends (§3.3).
 * `null` while live — there is nothing stale to disclose.
 */
export function useLastUpdatedLabel(): string | null {
  const frozenAt = useSocketStore(selectFrozenAt);
  return frozenAt === null ? null : `last updated ${formatClock(frozenAt)}`;
}
