import { useEffect, useRef, useState } from 'react';
import { StatusBadge } from '../../components/StatusBadge.js';
import type { Session } from '../../lib/api/index.js';
import { formatCostUsd, formatTokenCount, sessionLabel } from '../../lib/format/index.js';
import { useDurationLabel, useIsLive, useLastUpdatedLabel } from '../../lib/liveness.js';
import { toast } from '../../stores/toast-store.js';
import { headerActions, overflowActions, type SessionActionDescriptor } from './actions.js';

/**
 * The Session detail header (TDS 06 §5.5 "Header, three lines").
 *
 * Identity follows §9.3 without exception: **title first**, `project · branch` second, and the
 * raw UUID only on the third line, mono and click-to-copy. That is the one place in the
 * product where the full id appears, because correlating with a Backend log is exactly the job
 * a full id is good at and a truncated prefix is not — while a *leading* prefix is the least
 * discriminating substring a UUIDv7 has, since it encodes the millisecond the Session started.
 */

export interface SessionHeaderProps {
  readonly session: Session;
  readonly turnInFlight: boolean;
  readonly onAction: (action: SessionActionDescriptor) => void;
  readonly pendingActionId: string | null;
  readonly onRename: (title: string) => void;
}

export function SessionHeader({
  session,
  turnInFlight,
  onAction,
  pendingActionId,
  onRename,
}: SessionHeaderProps) {
  const isLive = useIsLive();
  const lastUpdated = useLastUpdatedLabel();
  const duration = useDurationLabel(session.startedAt, session.completedAt);
  const [menuOpen, setMenuOpen] = useState(false);

  const primary = headerActions(session, turnInFlight);
  const overflow = overflowActions(session);

  return (
    <header className="border-border border-b px-4 py-3">
      <TitleLine session={session} onRename={onRename} />

      {/* §9.3's secondary line is `project · branch`. The **project name** is deliberately
          absent: it lives on `GET /projects`, which this Backend does not serve yet, and a
          literal placeholder in the slot where a name belongs is worse than one fewer field —
          it reads as data. The line grows a project name the day the endpoint exists. */}
      <p className="mt-1 text-text-secondary text-xs">
        <span className="font-mono">{session.branch ?? 'no branch'}</span> · {session.sessionType}
        {session.runtime.claudeVersion === null ? null : (
          <> · Claude {session.runtime.claudeVersion}</>
        )}
        {session.runtime.machine === null ? null : <> on {session.runtime.machine}</>}
        {session.runtime.model === null ? null : <> · {session.runtime.model}</>}
      </p>

      <CopyableId id={session.id} />

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <StatusBadge state={session.state} muted={!isLive} />
        <span className="font-mono text-text-secondary text-xs">{duration}</span>
        <span className="font-mono text-text-secondary text-xs">
          {formatCostUsd(session.costUsd)}
        </span>
        {session.tokenUsage === null ? null : (
          <span className="font-mono text-text-muted text-xs">
            {formatTokenCount(session.tokenUsage.input + session.tokenUsage.output)} tok
          </span>
        )}
        {lastUpdated === null ? null : (
          <span className="text-2xs text-text-muted">{lastUpdated}</span>
        )}
        {session.observation?.degraded === true ? (
          <DegradedChip reason={session.observation.reason} />
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          {primary.map((action) => (
            <button
              key={action.id}
              type="button"
              onClick={() => onAction(action)}
              title={action.hint}
              disabled={pendingActionId !== null}
              data-action={action.id}
              className="rounded-sm border px-3 font-medium text-sm disabled:opacity-50"
              style={{
                height: 'var(--mc-control-md)',
                borderColor:
                  action.emphasis === 'primary'
                    ? 'var(--color-accent)'
                    : 'var(--color-border-control)',
                backgroundColor:
                  action.emphasis === 'primary' ? 'var(--color-accent)' : 'transparent',
                color:
                  action.emphasis === 'primary'
                    ? 'var(--color-on-accent)'
                    : action.emphasis === 'warning'
                      ? 'var(--color-warning)'
                      : 'var(--color-text)',
              }}
            >
              {pendingActionId === action.id ? '…' : action.label}
            </button>
          ))}

          {overflow.length === 0 ? null : (
            <span className="relative">
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label="More session actions"
                onClick={() => setMenuOpen((open) => !open)}
                className="rounded-sm border border-border-control px-3 text-sm text-text"
                style={{ height: 'var(--mc-control-md)' }}
              >
                ⋯
              </button>
              {menuOpen ? (
                <span
                  role="menu"
                  className="absolute right-0 z-20 mt-1 flex min-w-56 flex-col rounded-md border border-border p-1"
                  style={{
                    backgroundColor: 'var(--color-surface-raised)',
                    boxShadow: 'var(--shadow-overlay)',
                  }}
                >
                  {overflow.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      title={action.hint}
                      onClick={() => {
                        setMenuOpen(false);
                        onAction(action);
                      }}
                      className="rounded-xs px-3 py-2 text-left text-sm text-text"
                    >
                      {action.label}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
          )}
        </span>
      </div>
    </header>
  );
}

function TitleLine({ session, onRename }: { session: Session; onRename: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!editing) {
    return (
      <div className="flex items-center gap-2">
        <h1 className="font-medium text-text text-xl">
          {sessionLabel({ id: session.id, title: session.title })}
        </h1>
        <button
          type="button"
          aria-label="Rename session"
          onClick={() => {
            setDraft(session.title);
            setEditing(true);
          }}
          className="rounded-xs text-text-muted text-xs"
          style={{ minWidth: 24, minHeight: 24 }}
        >
          ✎
        </button>
      </div>
    );
  }

  const commit = (): void => {
    setEditing(false);
    // An empty title reverts to the derived one (§6.11.4: `''` clears the override), so the
    // operator can undo a rename by clearing the field rather than remembering the original.
    if (draft !== session.title) onRename(draft);
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      aria-label="Session title"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          commit();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          setDraft(session.title);
          setEditing(false);
        }
      }}
      className="w-full rounded-sm border bg-transparent px-2 py-1 font-medium text-text text-xl"
      style={{ borderColor: 'var(--color-border-control)' }}
    />
  );
}

function CopyableId({ id }: { id: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(id)
          .then(() => toast({ kind: 'success', message: 'Session ID copied' }))
          .catch(() => toast({ kind: 'warning', message: 'Clipboard is not available' }));
      }}
      title="Copy the full session ID"
      className="mt-1 block rounded-xs font-mono text-2xs text-text-muted"
      style={{ minHeight: 24 }}
    >
      {id}
    </button>
  );
}

/**
 * §5.5: the chip renders from `Session.observation.degraded` on load — not only for a client
 * that happened to be connected when the event fired — and **never clears for the life of the
 * Session** (arbitration A11). Re-attaching the tailer cannot recover the lines already
 * skipped, so a "recovered" state would overstate what the operator is looking at.
 */
function DegradedChip({ reason }: { reason: string | null }) {
  return (
    <span
      data-testid="degraded-chip"
      title={`Live transcript unavailable — showing tool and lifecycle events only. Message text may be incomplete.${
        reason === null ? '' : ` (${reason})`
      }`}
      className="inline-flex items-center gap-1 rounded-xs px-2 py-05 text-2xs"
      style={{
        backgroundColor: 'var(--color-warning-subtle)',
        color: 'var(--color-warning)',
      }}
    >
      <span aria-hidden="true">⚠</span> Degraded fidelity
    </span>
  );
}
