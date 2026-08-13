import { useNavigate } from 'react-router';
import { useCurrentUser, useLogout } from '../../features/auth/queries.js';
import { ConnectionChip } from './ConnectionChip.js';
import { ShellBoundary } from './ShellBoundary.js';
import { SpendChip } from './SpendChip.js';

/**
 * The slim top bar (TDS 06 §3.1).
 *
 * Left→right: wordmark, global search entry, the **SpendChip** (§3.1 / WC1), the
 * **ConnectionChip** (§3.3), and the account menu.
 *
 * The notification bell is still deliberately absent: the Notification entity has no producer
 * for most types in Phase 1 and §4.5 is explicit that the bell "lights up in Phase 2", so an
 * always-zero unread count would be furniture. The spend chip's own absence — "`GET /spend`
 * is a WS2 surface the Backend does not serve yet" — no longer holds: the endpoint exists,
 * and the chip renders only once it has answered (see `SpendChip`).
 */
export function TopBar({ onOpenPalette }: { onOpenPalette: () => void }) {
  const navigate = useNavigate();
  const { data } = useCurrentUser();
  const logout = useLogout();

  return (
    <header className="flex shrink-0 items-center gap-4 border-border border-b bg-surface px-4 py-2">
      <span className="font-medium text-sm text-text tracking-0">
        <span aria-hidden="true" className="mr-2">
          ◆
        </span>
        MISSION CONTROL
      </span>

      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden min-w-64 items-center gap-2 rounded-sm border border-border-control px-3 text-sm text-text-muted md:flex"
        style={{ height: 'var(--mc-control-md)' }}
      >
        <span aria-hidden="true">/</span>
        <span className="flex-1 text-left">Search…</span>
        <kbd className="font-mono text-2xs">Ctrl K</kbd>
      </button>

      <div className="ml-auto flex items-center gap-3">
        {/* One boundary each, not one around the pair. The ConnectionChip is the widget an
            operator needs most while something is broken — it is how they tell "the server is
            down" from "this screen is wrong" — so a failing SpendChip must not take it out. */}
        <ShellBoundary label="Spend indicator">
          <SpendChip />
        </ShellBoundary>
        <ShellBoundary label="Connection indicator">
          <ConnectionChip />
        </ShellBoundary>

        <span className="hidden text-text-secondary text-xs sm:inline">
          {data?.user.username ?? '—'}
        </span>

        <button
          type="button"
          onClick={() => {
            logout.mutate(undefined, {
              // `onSettled` in the mutation already cleared client state; navigation is the
              // view's job, so it lives with the view.
              onSettled: () => void navigate('/login', { replace: true }),
            });
          }}
          disabled={logout.isPending}
          className="rounded-sm border border-border-control px-3 text-sm text-text"
          style={{ height: 'var(--mc-control-sm)' }}
        >
          {logout.isPending ? 'Signing out…' : 'Sign out'}
        </button>
      </div>
    </header>
  );
}
