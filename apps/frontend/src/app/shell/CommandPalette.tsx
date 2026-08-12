import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ConfirmDialog } from '../../components/Modal.js';
import {
  allSessionActions,
  type SessionActionDescriptor,
} from '../../features/sessions/actions.js';
import { invalidateAfterAction, performSessionAction } from '../../features/sessions/mutations.js';
import { apiList } from '../../lib/api/client.js';
import {
  type ApiError,
  endpoints,
  errorMessage,
  queryKeys,
  type Session,
} from '../../lib/api/index.js';
import { sessionIdTail, sessionLabel } from '../../lib/format/index.js';
import { toast } from '../../stores/toast-store.js';
import { useUiStore } from '../../stores/ui-store.js';
import { NAV_ITEMS, SETTINGS_CATEGORIES, settingsCategoryLabel } from './navigation.js';

/**
 * The `Ctrl+K` command palette (TDS 05 §9.4, TDS 06 §4.7) — "the primary keyboard surface,
 * and the reason no capability depends on a memorised chord".
 *
 * Two properties from §9.4 are structural:
 *
 *  - **It reads only what the app already has.** The query cache plus `uiStore` plus the
 *    static route tables. Opening it triggers no blocking fetch; it renders instantly and
 *    issues a background `['sessions']` refresh whose results merge in when they land. A
 *    palette that is ever a loading screen is not a keyboard surface.
 *  - **Session actions come from the §6.6 predicate**, not from a second list. `allSessionActions`
 *    is the same function the detail header and the list-row overflow menu call, so an illegal
 *    transition is never offered from the palette either — and execution goes through the same
 *    non-optimistic path (§11.3), including the confirm step for destructive actions.
 */

interface Command {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly group: 'Navigate' | 'Sessions' | 'Actions' | 'Settings' | 'Preferences';
  readonly run: () => void;
}

interface PendingConfirm {
  readonly sessionId: string;
  readonly action: SessionActionDescriptor;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [confirming, setConfirming] = useState<PendingConfirm | null>(null);
  const [running, setRunning] = useState(false);

  const openSessionIds = useUiStore((state) => state.openSessionIds);
  const openSession = useUiStore((state) => state.openSession);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);
  const toggleNav = useUiStore((state) => state.toggleNav);

  /**
   * The palette's data source (§9.4: "renders instantly from cache and issues a background
   * refresh whose results merge in when they land").
   *
   * It has to be a *subscription*, not a cache read. An imperative `getQueryData` inside a
   * `useMemo` renders whatever happened to be cached at open time and then never updates —
   * the background refresh lands in the cache and nothing re-renders, so the palette silently
   * shows a stale (often empty) session list. Observed against the real Backend: the Actions
   * group was empty on first open every time.
   */
  const sessionsQuery = useQuery<readonly Session[], ApiError>({
    queryKey: queryKeys.sessions.palette(),
    enabled: open,
    retry: false,
    staleTime: 15_000,
    queryFn: async ({ signal }) => {
      const page = await apiList<Session>(endpoints.sessions.list, {
        query: { limit: 50, order: 'desc' },
        signal,
      });
      return page.data;
    },
  });

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  /**
   * Execution goes through `performSessionAction` — the same non-optimistic request path the
   * Session header uses (§11.3). A palette that ran its own fetch would be the surface that
   * forgets the F7 refetch and shows a state the Backend rejected.
   */
  const runSessionAction = useCallback(
    (sessionId: string, action: SessionActionDescriptor) => {
      setRunning(true);
      void performSessionAction(sessionId, { action: action.id })
        .then((outcome) => {
          invalidateAfterAction(queryClient, sessionId, outcome);
          if (outcome.session.id !== sessionId) void navigate(`/sessions/${outcome.session.id}`);
        })
        .catch((error: unknown) => {
          toast({ kind: 'danger', message: errorMessage(error) });
        })
        .finally(() => setRunning(false));
    },
    [queryClient, navigate],
  );

  const cachedSessions = sessionsQuery.data ?? [];

  const commands = useMemo<readonly Command[]>(() => {
    const sessionCommands: Command[] = cachedSessions.map((session) => ({
      id: `session-${session.id}`,
      label: sessionLabel({ id: session.id, title: session.title }),
      // §9.3 identity: title primary, `project · branch` secondary, id TAIL — never a
      // UUIDv7 prefix, whose leading characters are a timestamp shared by every Session
      // started in the same hour.
      hint: `${session.state} · ${session.branch ?? 'no branch'} · ${sessionIdTail(session.id)}`,
      group: 'Sessions',
      run: () => {
        openSession(session.id);
        void navigate(`/sessions/${session.id}`);
      },
    }));

    // §9.4: state-legal lifecycle actions on cached Sessions. `[Stop]` is excluded because the
    // palette cannot know whether a turn is in flight for a Session it is not displaying —
    // and offering an interrupt that answers `NO_TURN_IN_FLIGHT` is worse than not offering it.
    const actionCommands: Command[] = cachedSessions.flatMap((session) =>
      allSessionActions(session, false)
        .filter((action) => action.id !== 'stop')
        .map<Command>((action) => ({
          id: `action-${session.id}-${action.id}`,
          label: `${action.label} — ${sessionLabel({ id: session.id, title: session.title })}`,
          hint: `${session.state} · ${sessionIdTail(session.id)}`,
          group: 'Actions',
          run: () => {
            if (action.confirm === undefined) runSessionAction(session.id, action);
            else setConfirming({ sessionId: session.id, action });
          },
        })),
    );

    // Open Sessions the list has not returned yet still deserve to be switchable.
    for (const id of openSessionIds) {
      if (sessionCommands.some((command) => command.id === `session-${id}`)) continue;
      sessionCommands.push({
        id: `session-${id}`,
        label: `Open session ${sessionIdTail(id)}`,
        group: 'Sessions',
        run: () => void navigate(`/sessions/${id}`),
      });
    }

    return [
      ...NAV_ITEMS.map<Command>((item) => ({
        id: `nav-${item.to}`,
        label: `Go to ${item.label}`,
        ...(item.phase === undefined ? {} : { hint: `Phase ${item.phase}` }),
        group: 'Navigate',
        run: () => void navigate(item.to),
      })),
      ...sessionCommands,
      ...actionCommands,
      ...SETTINGS_CATEGORIES.map<Command>((category) => ({
        id: `settings-${category}`,
        label: `Settings — ${settingsCategoryLabel(category)}`,
        group: 'Settings',
        run: () => void navigate(`/settings/${category}`),
      })),
      {
        id: 'theme-toggle',
        label: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
        hint: 'Dark is the default palette',
        group: 'Preferences',
        run: toggleTheme,
      },
      {
        id: 'nav-toggle',
        label: 'Toggle navigation rail',
        group: 'Preferences',
        run: toggleNav,
      },
    ];
  }, [
    cachedSessions,
    navigate,
    openSession,
    openSessionIds,
    theme,
    toggleTheme,
    toggleNav,
    runSessionAction,
  ]);

  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const active = results[Math.min(activeIndex, Math.max(0, results.length - 1))] ?? null;

  // The confirm dialog outlives the palette: `Archive` from the palette must still be
  // confirmable after the palette closes, or the confirm would be dismissed by the same
  // keystroke that requested it.
  const confirmDialog =
    confirming === null ? null : (
      <ConfirmDialog
        open
        title={confirming.action.confirm?.title ?? ''}
        body={confirming.action.confirm?.body ?? ''}
        confirmLabel={confirming.action.confirm?.confirmLabel ?? 'Confirm'}
        destructive={confirming.action.confirm?.destructive ?? false}
        pending={running}
        onConfirm={() => {
          const pending = confirming;
          setConfirming(null);
          runSessionAction(pending.sessionId, pending.action);
        }}
        onCancel={() => setConfirming(null)}
      />
    );

  if (!open) return confirmDialog;

  const runActive = (): void => {
    if (active === null) return;
    onClose();
    active.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh]">
      {/* The scrim is a real button, not a div with a click handler: dismissing an overlay
          by clicking outside it is an action, and an action that only a pointer can reach
          is one a keyboard user cannot undo. `Esc` does the same thing. */}
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close command palette"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{ backgroundColor: 'var(--color-overlay)' }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-xl rounded-lg border border-border"
        style={{
          backgroundColor: 'var(--color-surface-raised)',
          boxShadow: 'var(--shadow-overlay)',
        }}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={active === null ? undefined : `${listboxId}-${active.id}`}
          aria-autocomplete="list"
          aria-label="Search commands"
          placeholder="Jump to a session, page or setting…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActiveIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActiveIndex((index) => Math.max(0, index - 1));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              runActive();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            } else if (event.key === 'Tab') {
              // One focusable element; trapping Tab keeps focus inside the dialog without a
              // focus-trap dependency.
              event.preventDefault();
            }
          }}
          className="w-full rounded-t-lg border-border border-b bg-transparent px-4 py-3 text-md text-text outline-none"
        />

        {/* The combobox/listbox pattern (§9.4 a11y): the input keeps focus and
            `aria-activedescendant` points at the highlighted option, so arrow keys move a
            virtual cursor without ever moving real focus out of the text field. */}
        <div
          role="listbox"
          id={listboxId}
          aria-label="Commands"
          className="max-h-80 overflow-y-auto p-1"
        >
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-text-muted">No matches</p>
          ) : (
            results.map((command, index) => (
              // biome-ignore lint/a11y/useKeyWithClickEvents: keys are handled by the combobox input, which never loses focus
              <div
                key={command.id}
                role="option"
                // Options carry `tabIndex={-1}` and never receive real focus: in the
                // combobox pattern the input keeps focus and `aria-activedescendant` moves
                // a virtual cursor. Moving real focus here would break typing.
                tabIndex={-1}
                id={`${listboxId}-${command.id}`}
                aria-selected={command === active}
                className="flex cursor-pointer items-center gap-3 rounded-xs px-3 py-2"
                style={
                  command === active ? { backgroundColor: 'var(--color-selected)' } : undefined
                }
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  onClose();
                  command.run();
                }}
              >
                <span className="w-20 shrink-0 text-2xs text-text-muted">{command.group}</span>
                <span className="flex-1 truncate text-sm text-text">{command.label}</span>
                {command.hint === undefined ? null : (
                  <span className="truncate font-mono text-2xs text-text-muted">
                    {command.hint}
                  </span>
                )}
              </div>
            ))
          )}
        </div>

        <p aria-live="polite" className="sr-only">
          {results.length} result{results.length === 1 ? '' : 's'}
        </p>
      </div>

      {/* Rendered here as well as in the closed branch: whether the palette closes before the
          confirm appears is the caller's business, and a confirm that only exists in one of
          those two arrangements is a confirm that can be skipped. */}
      {confirmDialog}
    </div>
  );
}

/** Client-side fuzzy-ish match over label + hint. No server search dependency in V1 (§9.4). */
export function filterCommands(commands: readonly Command[], query: string): readonly Command[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return commands;
  return commands.filter((command) =>
    `${command.label} ${command.hint ?? ''} ${command.group}`.toLowerCase().includes(needle),
  );
}
