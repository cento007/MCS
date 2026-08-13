import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '../../components/Modal.js';
import { StatusBadge } from '../../components/StatusBadge.js';
import type { Session } from '../../lib/api/index.js';
import {
  formatCostUsd,
  formatDuration,
  sessionIdTail,
  sessionLabel,
} from '../../lib/format/index.js';
import { useIsLive } from '../../lib/liveness.js';
import { allSessionActions, type SessionActionDescriptor } from './actions.js';
import { useSessionActionMutation } from './mutations.js';

/**
 * The Sessions table (TDS 06 §5.4), extracted so it has exactly one implementation.
 *
 * TDS 06 §5.3.2 specifies the Project detail's Sessions tab as "identical table to §5.4
 * pre-filtered to the Project (**shared component**)" — a second table would be a second place
 * for the §9.3 identity rule to be got wrong, and the identity rule is the whole reason this
 * table looks the way it does: **title leads**, `branch` beneath it, and the id demoted to its
 * last six hex characters. A UUIDv7 prefix column made every row of a busy list look identical,
 * because those leading characters encode the millisecond the Session started.
 */

export interface SessionsTableProps {
  readonly sessions: readonly Session[];
  /** Below `md` the table becomes two-line cards; the ID does not appear on mobile at all. */
  readonly mobile: boolean;
  readonly onOpen: (session: Session) => void;
}

export function SessionsTable({ sessions, mobile, onOpen }: SessionsTableProps) {
  const isLive = useIsLive();

  if (mobile) {
    return (
      <ul className="flex flex-col gap-2">
        {sessions.map((session) => (
          <li key={session.id}>
            <MobileCard session={session} muted={!isLive} onOpen={() => onOpen(session)} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="text-left text-2xs text-text-secondary uppercase">
          <th scope="col" className="py-2 pr-3 font-medium">
            State
          </th>
          <th scope="col" className="py-2 pr-3 font-medium">
            Session
          </th>
          <th scope="col" className="py-2 pr-3 font-medium">
            Type
          </th>
          <th scope="col" className="py-2 pr-3 font-medium">
            Duration
          </th>
          <th scope="col" className="py-2 pr-3 font-medium">
            ID
          </th>
          <th scope="col" className="py-2 pr-3 font-medium">
            Cost
          </th>
          <th scope="col" className="py-2 font-medium">
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {sessions.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            muted={!isLive}
            onOpen={() => onOpen(session)}
          />
        ))}
      </tbody>
    </table>
  );
}

function SessionRow({
  session,
  muted,
  onOpen,
}: {
  session: Session;
  muted: boolean;
  onOpen: () => void;
}) {
  return (
    <tr className="border-border border-t align-top" style={{ height: 'var(--mc-row-dense)' }}>
      <td className="py-2 pr-3">
        <StatusBadge state={session.state} muted={muted} />
      </td>
      <td className="py-2 pr-3">
        <button
          type="button"
          onClick={onOpen}
          className="block max-w-md text-left"
          style={{ minHeight: 24 }}
        >
          <span className="block truncate text-sm text-text" title={session.title}>
            {sessionLabel({ id: session.id, title: session.title })}
          </span>
          <span className="block truncate text-2xs text-text-muted">
            <span className="font-mono">{session.branch ?? 'no branch'}</span>
          </span>
        </button>
      </td>
      <td className="py-2 pr-3 text-text-secondary text-xs">{session.sessionType}</td>
      <td className="py-2 pr-3 font-mono text-text-secondary text-xs">
        {formatDuration(session.durationSeconds)}
      </td>
      <td className="py-2 pr-3">
        {/* Last six hex characters — the random tail. Title carries the full UUID; clicking
            copies it, per §5.4. */}
        <button
          type="button"
          title={session.id}
          onClick={() => void navigator.clipboard?.writeText(session.id)}
          className="rounded-xs font-mono text-2xs text-text-muted"
          style={{ minHeight: 24 }}
        >
          {sessionIdTail(session.id)}
        </button>
      </td>
      <td className="py-2 pr-3 font-mono text-text-secondary text-xs">
        {session.sessionType === 'observed' && session.costUsd === null
          ? '—'
          : formatCostUsd(session.costUsd)}
      </td>
      <td className="py-2">
        <RowMenu session={session} />
      </td>
    </tr>
  );
}

function MobileCard({
  session,
  muted,
  onOpen,
}: {
  session: Session;
  muted: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-md border border-border p-3 text-left"
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <span className="flex items-center gap-2">
        <StatusBadge state={session.state} muted={muted} />
        <span className="min-w-0 flex-1 truncate text-sm text-text">
          {sessionLabel({ id: session.id, title: session.title })}
        </span>
      </span>
      <span className="mt-1 block truncate text-2xs text-text-muted">
        <span className="font-mono">{session.branch ?? 'no branch'}</span> ·{' '}
        <span className="font-mono">{formatDuration(session.durationSeconds)}</span> ·{' '}
        <span className="font-mono">{formatCostUsd(session.costUsd)}</span>
      </span>
    </button>
  );
}

/**
 * The row overflow menu. It offers **only state-legal actions**, derived from the same
 * predicate as the header and the palette (§6.6), so an illegal transition is never presented
 * anywhere — the API would reject it with `INVALID_STATE_TRANSITION` regardless.
 */
function RowMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<SessionActionDescriptor | null>(null);
  const mutation = useSessionActionMutation(session.id);
  const navigate = useNavigate();

  // `turnInFlight` is false here on purpose: a list row has no live buffer, so `[Stop]` is
  // not one of its options — `[Pause]` is the process-level control this surface can offer.
  const actions = allSessionActions(session, false).filter((action) => action.id !== 'stop');

  const run = (action: SessionActionDescriptor): void => {
    void mutation.mutateAsync({ action: action.id }).then((outcome) => {
      if (outcome.session.id !== session.id) void navigate(`/sessions/${outcome.session.id}`);
    });
  };

  if (actions.length === 0) return null;

  return (
    <span className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${sessionLabel({ id: session.id, title: session.title })}`}
        onClick={() => setOpen((value) => !value)}
        className="rounded-xs px-2 text-text-muted"
        style={{ minWidth: 24, minHeight: 24 }}
      >
        ⋯
      </button>
      {open ? (
        <span
          role="menu"
          className="absolute right-0 z-20 mt-1 flex min-w-48 flex-col rounded-md border border-border p-1"
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            boxShadow: 'var(--shadow-overlay)',
          }}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                if (action.confirm === undefined) run(action);
                else setConfirming(action);
              }}
              className="rounded-xs px-3 py-2 text-left text-sm text-text"
            >
              {action.label}
            </button>
          ))}
        </span>
      ) : null}

      <ConfirmDialog
        open={confirming !== null}
        title={confirming?.confirm?.title ?? ''}
        body={confirming?.confirm?.body ?? ''}
        confirmLabel={confirming?.confirm?.confirmLabel ?? 'Confirm'}
        destructive={confirming?.confirm?.destructive ?? false}
        pending={mutation.isPending}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action !== null) run(action);
        }}
        onCancel={() => setConfirming(null)}
      />
    </span>
  );
}
