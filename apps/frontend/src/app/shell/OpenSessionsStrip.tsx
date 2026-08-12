import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { StatusDot } from '../../components/StatusDot.js';
import { useOpenSessions } from '../../features/sessions/queries.js';
import { sessionLabel } from '../../lib/format/index.js';
import { useIsLive, useLastUpdatedLabel } from '../../lib/liveness.js';
import {
  formatActivityCount,
  selectLiveSession,
  useLiveSessionStore,
} from '../../stores/live-session-store.js';
import { useUiStore } from '../../stores/ui-store.js';

/**
 * The shell-level session switcher (TDS 06 §3.4, TDS 05 §6.5).
 *
 * > "Multi-session work is the product's headline capability, so the switcher belongs to
 * > the **shell**, not to one screen."
 *
 * It renders the operator's open session set — one ordered list in `uiStore`, of which this
 * strip and the Live Session tab bar are two projections. They cannot diverge because there
 * is only one list. Closing an entry removes it from the set (releasing its `session:{id}`
 * subscription) and **never** touches Session state: no F7 transition is implied.
 *
 * Degraded rendering (§3.3) when the socket is not `live`: muted titles, static dots,
 * counts marked stale, and a `last updated HH:MM` line — because every dot on this strip is
 * a claim about the present that the client can no longer verify.
 */
export function OpenSessionsStrip({
  orientation = 'vertical',
}: {
  orientation?: 'vertical' | 'horizontal';
}) {
  const navigate = useNavigate();
  const openSessionIds = useUiStore((state) => state.openSessionIds);
  const focusedSessionId = useUiStore((state) => state.focusedSessionId);
  const closeSession = useUiStore((state) => state.closeSession);
  const retainSessions = useUiStore((state) => state.retainSessions);
  const isLive = useIsLive();
  const lastUpdated = useLastUpdatedLabel();

  const rows = useOpenSessions(openSessionIds);

  // §6.5 — persisted ids are validated on reload and silently dropped when the Session is
  // gone. Silently, because an operator does not need a toast about a tab they closed last
  // week pointing at a Session they archived last week.
  const missingIds = rows.filter((row) => row.missing).map((row) => row.id);
  const missingSignature = missingIds.join(',');
  useEffect(() => {
    if (missingSignature.length === 0) return;
    const gone = new Set(missingSignature.split(','));
    retainSessions(openSessionIds.filter((id) => !gone.has(id)));
  }, [missingSignature, openSessionIds, retainSessions]);

  // §3.4: "when the set is empty the whole block is omitted (no empty-state noise in the nav)".
  if (openSessionIds.length === 0) return null;

  const horizontal = orientation === 'horizontal';

  return (
    <nav
      aria-label="Open sessions"
      className={
        horizontal ? 'flex gap-2 overflow-x-auto px-4 py-2' : 'flex flex-col gap-05 px-2 py-2'
      }
    >
      {horizontal ? null : (
        <p className="px-2 pb-1 text-2xs text-text-muted uppercase tracking-0">Open sessions</p>
      )}

      {rows.map((row) => (
        <OpenSessionEntry
          key={row.id}
          sessionId={row.id}
          title={
            row.session === null
              ? 'Loading…'
              : sessionLabel({ id: row.session.id, title: row.session.title })
          }
          state={row.session?.state ?? null}
          focused={focusedSessionId === row.id}
          muted={!isLive}
          horizontal={horizontal}
          onOpen={() => void navigate(`/sessions/${row.id}`)}
          onClose={() => closeSession(row.id)}
        />
      ))}

      {lastUpdated === null ? null : (
        <p className={`text-2xs text-text-muted ${horizontal ? 'self-center px-2' : 'px-2 pt-1'}`}>
          {lastUpdated}
        </p>
      )}
    </nav>
  );
}

function OpenSessionEntry({
  sessionId,
  title,
  state,
  focused,
  muted,
  horizontal,
  onOpen,
  onClose,
}: {
  sessionId: string;
  title: string;
  state: import('@mc/shared/types').SessionState | null;
  focused: boolean;
  muted: boolean;
  horizontal: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const entry = useLiveSessionStore((store) => selectLiveSession(store, sessionId));
  const count = formatActivityCount(entry.activityCount);

  return (
    <span
      className={`group flex items-center gap-2 rounded-xs px-2 py-1 ${
        horizontal ? 'shrink-0' : ''
      }`}
      style={focused ? { backgroundColor: 'var(--color-selected)' } : undefined}
    >
      <button
        type="button"
        onClick={onOpen}
        title={title}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        style={{ minHeight: 24 }}
      >
        {state === null ? (
          <span aria-hidden="true" className="inline-block size-[10px] rounded-full bg-hover" />
        ) : (
          <StatusDot state={state} muted={muted} />
        )}
        <span
          className={`truncate text-xs ${muted ? 'text-text-muted' : 'text-text-secondary'}`}
          style={horizontal ? { maxWidth: 160 } : undefined}
        >
          {title}
        </span>
        {count === '' ? null : (
          <span
            // §3.4: the unread dot is `--color-accent` — navigational attention, not state.
            className="ml-auto rounded-full px-1 font-medium text-2xs"
            style={{ backgroundColor: 'var(--color-accent-subtle)', color: 'var(--color-accent)' }}
            title={`${entry.activityCount} new since last viewed`}
          >
            {count}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title}`}
        title="Close (does not stop the session)"
        className="rounded-xs text-text-muted text-xs opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        style={{ minWidth: 24, minHeight: 24 }}
      >
        ✕
      </button>
    </span>
  );
}
