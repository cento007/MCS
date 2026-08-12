import { NavLink } from 'react-router';
import { PhaseBadge } from '../../components/PhasePlaceholder.js';
import { StatusDot } from '../../components/StatusDot.js';
import { useRunningSessions } from '../../features/sessions/queries.js';
import { useIsLive, useLastUpdatedLabel } from '../../lib/liveness.js';
import { NAV_ITEMS } from './navigation.js';
import { OpenSessionsStrip } from './OpenSessionsStrip.js';

/**
 * Desktop nav rail (TDS 06 §3.1), `--mc-sidebar-w` wide.
 *
 * Phase 3/4 destinations carry a **full-contrast label** plus a muted `P3`/`P4` badge and
 * route to a placeholder shell. They are never `disabled` and never dimmed to
 * `--color-text-disabled` — see `PhasePlaceholder` for why that distinction is load-bearing
 * rather than pedantic.
 *
 * The footer has two parts: the live `▶ n running` count and the open-sessions strip.
 */
export function NavRail() {
  return (
    <nav
      aria-label="Main"
      className="hidden shrink-0 flex-col border-border border-r bg-surface md:flex"
      style={{ width: 'var(--mc-sidebar-w)' }}
    >
      <ul className="flex flex-col gap-05 p-2">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === '/'}
              className="flex items-center gap-2 rounded-xs px-2 py-2 text-sm text-text-secondary"
              style={({ isActive }) =>
                isActive
                  ? {
                      backgroundColor: 'var(--color-selected)',
                      boxShadow: 'inset 2px 0 0 0 var(--color-accent)',
                      color: 'var(--color-text)',
                    }
                  : undefined
              }
            >
              <span aria-hidden="true" className="w-4 text-center">
                {item.glyph}
              </span>
              <span className="flex-1">{item.label}</span>
              {item.phase === undefined ? null : <PhaseBadge phase={item.phase} />}
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="mt-auto border-border border-t">
        <RunningCount />
        <OpenSessionsStrip />
      </div>
    </nav>
  );
}

/**
 * `▶ n running` — a live region (§3.3): muted with a `last updated HH:MM` title when the
 * socket is not `live`, because the count is a claim about right now.
 */
function RunningCount() {
  const isLive = useIsLive();
  const lastUpdated = useLastUpdatedLabel();
  const { data, isPending, isError } = useRunningSessions();
  const count = data?.length ?? 0;

  return (
    <NavLink
      to="/sessions?state=running"
      className="flex items-center gap-2 px-4 py-2 text-xs"
      style={{ color: isLive ? 'var(--color-text-secondary)' : 'var(--color-text-muted)' }}
      title={lastUpdated ?? undefined}
    >
      <StatusDot state="running" muted={!isLive || count === 0} />
      <span>{isPending ? '…' : isError ? '—' : count} running</span>
    </NavLink>
  );
}

/** Mobile bottom tab bar (TDS 06 §3.2). Touch targets are `--mc-control-lg`. */
export function MobileNav() {
  const primary = NAV_ITEMS.filter((item) => item.mobilePrimary === true);

  return (
    <nav aria-label="Main" className="flex shrink-0 border-border border-t bg-surface md:hidden">
      {primary.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className="flex flex-1 flex-col items-center justify-center gap-05 py-1 text-2xs text-text-secondary"
          style={({ isActive }) => (isActive ? { color: 'var(--color-accent)' } : undefined)}
        >
          <span aria-hidden="true">{item.glyph}</span>
          {item.label}
        </NavLink>
      ))}
      <NavLink
        to="/settings/general"
        className="flex flex-1 flex-col items-center justify-center gap-05 py-1 text-2xs text-text-secondary"
        style={{ minHeight: 'var(--mc-control-lg)' }}
      >
        <span aria-hidden="true">≡</span>
        More
      </NavLink>
    </nav>
  );
}
