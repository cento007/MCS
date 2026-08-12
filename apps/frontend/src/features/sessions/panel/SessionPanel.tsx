import { useEffect, useRef, useState } from 'react';
import type { Session } from '../../../lib/api/index.js';
import { PANEL_BREAKPOINTS, useMediaQuery } from '../../../lib/media.js';
import { SESSION_PANEL_TABS, type SessionPanelTab, useUiStore } from '../../../stores/ui-store.js';
import { CommitsTab, FilesTab, NotesTab, TimelineTab } from './PanelTabs.js';

/**
 * The Session detail right panel (TDS 05 §6.7).
 *
 * > "`/sessions/:sessionId` is **one composed view, not a set of page-level tabs**. An
 * > operator watching a stream must be able to see what the Session is *producing* — commits,
 * > touched files, lifecycle — without leaving the stream."
 *
 * The conversation never unmounts when panel tabs change, which is why the panel is a sibling
 * of the centre pane rather than a route: buffers and scroll position survive every tab click.
 *
 * Responsive collapse, per §6.7's table: expanded ≥1440px, an icon rail 1024–1439px whose
 * expansion overlays the conversation, and a bottom sheet below 1024px.
 */

const TAB_LABELS: Readonly<Record<SessionPanelTab, string>> = {
  commits: 'Commits',
  files: 'Files',
  timeline: 'Timeline',
  notes: 'Notes',
};

const TAB_ICONS: Readonly<Record<SessionPanelTab, string>> = {
  commits: '◇',
  files: '▤',
  timeline: '≡',
  notes: '✎',
};

export interface SessionPanelProps {
  readonly session: Session;
  readonly scrollToTime: (isoTimestamp: string) => boolean;
  readonly onSaveNotes: (notes: string) => void;
  readonly savingNotes: boolean;
}

export function SessionPanel({
  session,
  scrollToTime,
  onSaveNotes,
  savingNotes,
}: SessionPanelProps) {
  const panelTab = useUiStore((state) => state.panelTab);
  const setPanelTab = useUiStore((state) => state.setPanelTab);
  const collapsed = useUiStore((state) => state.panelCollapsed);
  const setCollapsed = useUiStore((state) => state.setPanelCollapsed);

  const wide = useMediaQuery(PANEL_BREAKPOINTS.wide);
  const mobile = useMediaQuery(PANEL_BREAKPOINTS.mobile);

  // §6.7 — "fetches lazily on first activation, then stays mounted". The activated set is what
  // keeps a panel the operator never opened from issuing three requests per Session view.
  const [activated, setActivated] = useState<ReadonlySet<SessionPanelTab>>(
    () => new Set(collapsed ? [] : [panelTab]),
  );
  useEffect(() => {
    if (collapsed) return;
    setActivated((previous) =>
      previous.has(panelTab) ? previous : new Set([...previous, panelTab]),
    );
  }, [panelTab, collapsed]);

  // The active tab is reflected in `?panel=` so a specific panel is linkable (§6.7). Written
  // with `replaceState` rather than a router navigation: a tab click is not a history entry,
  // and making it one would put four panel tabs between the operator and the Back button.
  useEffect(() => {
    if (typeof window === 'undefined' || collapsed) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('panel') === panelTab) return;
    url.searchParams.set('panel', panelTab);
    window.history.replaceState(window.history.state, '', url);
  }, [panelTab, collapsed]);

  // Wide viewports default to expanded; the 1024–1439 band defaults to the icon rail. The
  // operator's own choice, once made, is persisted in `uiStore` and wins over both.
  const appliedOnce = useRef(false);
  useEffect(() => {
    if (appliedOnce.current) return;
    appliedOnce.current = true;
    if (!wide && !mobile) setCollapsed(true);
  }, [wide, mobile, setCollapsed]);

  if (mobile) {
    return (
      <MobileSheet
        session={session}
        panelTab={panelTab}
        setPanelTab={setPanelTab}
        activated={activated}
        scrollToTime={scrollToTime}
        onSaveNotes={onSaveNotes}
        savingNotes={savingNotes}
      />
    );
  }

  if (collapsed) {
    return (
      <aside
        aria-label="Session panel"
        className="flex flex-col items-center gap-1 border-border border-l px-1 py-2"
        style={{ backgroundColor: 'var(--color-surface)' }}
      >
        <button
          type="button"
          aria-expanded={false}
          aria-label="Expand session panel"
          onClick={() => setCollapsed(false)}
          className="rounded-xs text-text-muted text-xs"
          style={{ minWidth: 28, minHeight: 28 }}
        >
          ‹
        </button>
        {SESSION_PANEL_TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            aria-label={TAB_LABELS[tab]}
            title={TAB_LABELS[tab]}
            onClick={() => {
              setPanelTab(tab);
              setCollapsed(false);
            }}
            className="rounded-xs text-text-secondary text-xs"
            style={{ minWidth: 28, minHeight: 28 }}
          >
            <span aria-hidden="true">{TAB_ICONS[tab]}</span>
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside
      aria-label="Session panel"
      className="flex min-h-0 shrink-0 flex-col border-border border-l"
      style={{ width: 'var(--mc-panel-w)', backgroundColor: 'var(--color-surface)' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setCollapsed(true);
      }}
    >
      <div className="flex items-center gap-1 border-border border-b px-2 py-1">
        <TabList panelTab={panelTab} setPanelTab={setPanelTab} />
        <button
          type="button"
          aria-expanded
          aria-label="Collapse session panel"
          onClick={() => setCollapsed(true)}
          className="ml-auto rounded-xs text-text-muted text-xs"
          style={{ minWidth: 24, minHeight: 24 }}
        >
          ›
        </button>
      </div>

      <div
        role="tabpanel"
        id={`session-panel-${panelTab}`}
        aria-labelledby={`session-tab-${panelTab}`}
        className="min-h-0 flex-1 overflow-y-auto p-3"
      >
        <PanelBody
          session={session}
          panelTab={panelTab}
          activated={activated}
          scrollToTime={scrollToTime}
          onSaveNotes={onSaveNotes}
          savingNotes={savingNotes}
        />
      </div>
    </aside>
  );
}

function TabList({
  panelTab,
  setPanelTab,
}: {
  panelTab: SessionPanelTab;
  setPanelTab: (tab: SessionPanelTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Session panel tabs" className="flex gap-1">
      {SESSION_PANEL_TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`session-tab-${tab}`}
          aria-selected={panelTab === tab}
          aria-controls={`session-panel-${tab}`}
          // Roving tabindex: one stop for the whole tablist, arrows move within it.
          tabIndex={panelTab === tab ? 0 : -1}
          onClick={() => setPanelTab(tab)}
          onKeyDown={(event) => {
            const index = SESSION_PANEL_TABS.indexOf(tab);
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              setPanelTab(
                SESSION_PANEL_TABS[(index + 1) % SESSION_PANEL_TABS.length] as SessionPanelTab,
              );
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              setPanelTab(
                SESSION_PANEL_TABS[
                  (index - 1 + SESSION_PANEL_TABS.length) % SESSION_PANEL_TABS.length
                ] as SessionPanelTab,
              );
            }
          }}
          className="rounded-xs px-2 text-2xs"
          style={{
            minHeight: 24,
            backgroundColor: panelTab === tab ? 'var(--color-selected)' : 'transparent',
            color: panelTab === tab ? 'var(--color-accent)' : 'var(--color-text-secondary)',
          }}
        >
          {TAB_LABELS[tab]}
        </button>
      ))}
    </div>
  );
}

function PanelBody({
  session,
  panelTab,
  activated,
  scrollToTime,
  onSaveNotes,
  savingNotes,
}: {
  session: Session;
  panelTab: SessionPanelTab;
  activated: ReadonlySet<SessionPanelTab>;
  scrollToTime: (isoTimestamp: string) => boolean;
  onSaveNotes: (notes: string) => void;
  savingNotes: boolean;
}) {
  switch (panelTab) {
    case 'commits':
      return (
        <CommitsTab
          session={session}
          active={activated.has('commits')}
          scrollToTime={scrollToTime}
        />
      );
    case 'files':
      return (
        <FilesTab session={session} active={activated.has('files')} scrollToTime={scrollToTime} />
      );
    case 'notes':
      return <NotesTab session={session} onSave={onSaveNotes} saving={savingNotes} />;
    default:
      return (
        <TimelineTab
          session={session}
          active={activated.has('timeline')}
          scrollToTime={scrollToTime}
        />
      );
  }
}

/** Below 1024 px the panel is a bottom sheet, so the conversation owns the whole viewport. */
function MobileSheet({
  session,
  panelTab,
  setPanelTab,
  activated,
  scrollToTime,
  onSaveNotes,
  savingNotes,
}: {
  session: Session;
  panelTab: SessionPanelTab;
  setPanelTab: (tab: SessionPanelTab) => void;
  activated: ReadonlySet<SessionPanelTab>;
  scrollToTime: (isoTimestamp: string) => boolean;
  onSaveNotes: (notes: string) => void;
  savingNotes: boolean;
}) {
  const [open, setOpen] = useState(false);
  const opener = useRef<Element | null>(null);

  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-label="Open session panel"
        onClick={() => {
          opener.current = document.activeElement;
          setOpen(true);
        }}
        className="border-border border-t px-4 py-2 text-2xs text-text-secondary"
        style={{ backgroundColor: 'var(--color-surface)', minHeight: 'var(--mc-control-lg)' }}
      >
        ≡ Commits · Files · Timeline · Notes
      </button>

      {open ? (
        <div
          className="fixed inset-x-0 bottom-0 z-40 max-h-[70vh] overflow-y-auto rounded-t-xl border-border border-t"
          role="dialog"
          aria-modal="true"
          aria-label="Session panel"
          style={{ backgroundColor: 'var(--color-surface-raised)' }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setOpen(false);
              (opener.current as HTMLElement | null)?.focus?.();
            }
          }}
        >
          <div className="flex items-center gap-1 border-border border-b px-2 py-2">
            <TabList panelTab={panelTab} setPanelTab={setPanelTab} />
            <button
              type="button"
              aria-label="Close session panel"
              onClick={() => {
                setOpen(false);
                (opener.current as HTMLElement | null)?.focus?.();
              }}
              className="ml-auto rounded-xs text-text-muted"
              style={{ minWidth: 24, minHeight: 24 }}
            >
              ✕
            </button>
          </div>
          <div
            role="tabpanel"
            id={`session-panel-${panelTab}`}
            aria-labelledby={`session-tab-${panelTab}`}
            className="p-3"
          >
            <PanelBody
              session={session}
              panelTab={panelTab}
              activated={new Set([...activated, panelTab])}
              scrollToTime={scrollToTime}
              onSaveNotes={onSaveNotes}
              savingNotes={savingNotes}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
