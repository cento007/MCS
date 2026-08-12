import { formatClockSeconds } from '../../lib/format/index.js';
import { useConnectionStatus } from '../../lib/liveness.js';
import { useOptionalSocketClient } from '../../lib/ws/context.js';
import { useSocketStore } from '../../stores/socket-store.js';

/**
 * The ConnectionChip (TDS 06 §3.3, TDS 05 §5.1) — the trust indicator for the whole
 * product, and the reason the rest of the shell is allowed to render live values at all.
 *
 * | state | render | meaning |
 * |---|---|---|
 * | `live` | `● live`, `--color-success` dot | socket open; subscribed channels current |
 * | `reconnecting` | `◌ reconnecting`, `--color-warning` dot, slow spin | connecting/backoff |
 * | `offline` | `✕ offline`, `--color-danger` label + `[Retry]` | backoff exhausted or browser offline |
 *
 * The `live` dot is `--color-success` (cyan) and **never the accent**: the accent marks
 * operator intent and position, never a system condition (TDS 06 §2.1.4). A green "live"
 * chip 200 px from an emerald primary button is exactly the ambiguity that rule exists to
 * prevent.
 */
const CHIP = {
  live: { glyph: '●', label: 'live', color: 'var(--color-success)' },
  reconnecting: { glyph: '◌', label: 'reconnecting', color: 'var(--color-warning)' },
  offline: { glyph: '✕', label: 'offline', color: 'var(--color-danger)' },
} as const;

export function ConnectionChip({ compact = false }: { compact?: boolean }) {
  const status = useConnectionStatus();
  const client = useOptionalSocketClient();
  const lastConnectedAt = useSocketStore((state) => state.lastConnectedAt);
  const nextAttemptAt = useSocketStore((state) => state.nextAttemptAt);

  const chip = CHIP[status];
  const lastUpdate =
    lastConnectedAt === null
      ? 'never connected'
      : `last update ${formatClockSeconds(lastConnectedAt)}`;
  const nextAttempt =
    status === 'reconnecting' && nextAttemptAt !== null
      ? ` · next attempt in ${Math.max(0, Math.round((nextAttemptAt - Date.now()) / 1000))}s`
      : '';

  return (
    <div className="flex items-center gap-2">
      <span
        // A live region: an operator who is not looking at the chip still needs to be told
        // the screen stopped being true.
        role="status"
        aria-live="polite"
        title={`${chip.label} · ${lastUpdate}${nextAttempt}`}
        className="inline-flex items-center gap-1 rounded-xs px-2 py-05 text-2xs"
        style={{
          color: status === 'offline' ? 'var(--color-danger)' : 'var(--color-text-secondary)',
        }}
      >
        <span
          aria-hidden="true"
          className={status === 'reconnecting' ? 'mc-spin-slow' : ''}
          style={{ color: chip.color }}
        >
          {chip.glyph}
        </span>
        {compact ? null : chip.label}
        <span className="sr-only">
          Connection {chip.label}. {lastUpdate}
        </span>
      </span>

      {status === 'offline' && client !== null ? (
        <button
          type="button"
          onClick={() => client.retryNow()}
          className="rounded-sm border border-border-control px-2 text-2xs text-text"
          style={{ height: 24, minWidth: 24 }}
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
