import { Suspense, useEffect, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router';
import { RouteSkeleton } from '../../components/Skeleton.js';
import { useKeyBindings } from '../../lib/keys/context.js';
import type { KeyBinding } from '../../lib/keys/registry.js';
import { useChannel, useOpenSessionChannels } from '../../lib/ws/context.js';
import { adjacentOpenSession, openSessionAt, useUiStore } from '../../stores/ui-store.js';
import { CommandPalette } from './CommandPalette.js';
import { MobileNav, NavRail } from './NavRail.js';
import { NAV_ITEMS } from './navigation.js';
import { OpenSessionsStrip } from './OpenSessionsStrip.js';
import { ShortcutSheet } from './ShortcutSheet.js';
import { TopBar } from './TopBar.js';

/**
 * The authenticated application shell (TDS 06 §3).
 *
 * It owns the four things that must be true on *every* route:
 *
 *  1. **Always-on channel subscriptions.** `sessions` and `settings` for the shell's own
 *     live regions, `notifications` because §5.2 keeps it subscribed for the whole
 *     authenticated lifetime, plus one `session:{id}` per entry of the open set so
 *     background activity accrues while the operator is somewhere else entirely.
 *  2. **The ConnectionChip and the OpenSessionsStrip** — TDS 06 §3.3/§3.4 both put these in
 *     the shell rather than on a screen, and §3.4 explains why: a switcher that only exists
 *     inside the Live Session view forces a two-step navigation to answer "is B still
 *     running while I read the Dashboard?", which is the question multi-session support
 *     exists to answer.
 *  3. **Keyboard dispatch** — one document-level listener, registered here (§9.4).
 *  4. **Theme application** — `data-theme` on `<html>` from `uiStore` (§9.1).
 */
export function AppShell() {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const theme = useUiStore((state) => state.theme);
  const openSessionIds = useUiStore((state) => state.openSessionIds);

  // Always-on channels for the shell's own live regions (§5.2).
  useChannel('sessions');
  useChannel('settings');
  useChannel('notifications');
  // §5.2/§6.5 — every Session in the open set holds a subscription even when it is not the
  // visible route. This is what makes the strip's unread counters mean anything.
  useOpenSessionChannels(openSessionIds);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  const bindings = useMemo<readonly KeyBinding[]>(() => {
    const navigation = NAV_ITEMS.filter((item) => item.sequence !== undefined).map<KeyBinding>(
      (item) => ({
        id: `nav-${item.to}`,
        keys: item.sequence as string,
        label: `Go to ${item.label}`,
        scope: 'global',
        run: () => void navigate(item.to),
      }),
    );

    // §9.4: `Alt+1…9`, NOT `Ctrl+1…9`. Chrome and Edge consume `Ctrl+1…9` for tab switching
    // at the browser-chrome level and never deliver the event to page JavaScript, so a
    // session-switching binding on it is dead on this product's own target browsers.
    const positional = Array.from({ length: 9 }, (_, index): KeyBinding => {
      const position = index + 1;
      return {
        id: `session-slot-${position}`,
        keys: `Alt+${position}`,
        label: `Switch to open session ${position}`,
        scope: 'global',
        run: () => {
          const sessionId = openSessionAt(useUiStore.getState(), position);
          if (sessionId !== null) void navigate(`/sessions/${sessionId}`);
        },
      };
    });

    return [
      {
        id: 'command-palette',
        keys: 'Ctrl+K',
        label: 'Command palette',
        scope: 'global',
        // `Ctrl+K` IS delivered to page JavaScript and is cancellable, unlike `Ctrl+1…9`,
        // so the handler preventDefaults to stop the browser's address-bar search (§9.4).
        run: () => setPaletteOpen(true),
      },
      {
        id: 'global-search',
        keys: '/',
        label: 'Focus search',
        scope: 'global',
        run: () => setPaletteOpen(true),
      },
      {
        id: 'shortcut-sheet',
        keys: '?',
        label: 'Keyboard shortcuts',
        scope: 'global',
        run: () => setShortcutsOpen(true),
      },
      {
        id: 'escape',
        keys: 'Escape',
        label: 'Close overlay',
        scope: 'global',
        // One of exactly two bindings that survive text entry (§9.4). From a composer it
        // steps focus out; it must never be swallowed by the suppression rule.
        allowInTextEntry: true,
        preventDefault: false,
        run: () => {
          setPaletteOpen(false);
          setShortcutsOpen(false);
        },
      },
      ...navigation,
      ...positional,
      {
        id: 'session-prev',
        keys: 'Alt+[',
        label: 'Previous open session',
        scope: 'global',
        run: () => {
          const sessionId = adjacentOpenSession(useUiStore.getState(), -1);
          if (sessionId !== null) void navigate(`/sessions/${sessionId}`);
        },
      },
      {
        id: 'session-next',
        keys: 'Alt+]',
        label: 'Next open session',
        scope: 'global',
        run: () => {
          const sessionId = adjacentOpenSession(useUiStore.getState(), 1);
          if (sessionId !== null) void navigate(`/sessions/${sessionId}`);
        },
      },
    ];
  }, [navigate]);

  useKeyBindings(bindings);

  return (
    <div className="flex h-full flex-col bg-bg text-text">
      <TopBar onOpenPalette={() => setPaletteOpen(true)} />

      <div className="flex min-h-0 flex-1">
        <NavRail />

        <div className="flex min-w-0 flex-1 flex-col">
          {/* The strip is present on every authenticated route. On mobile it is the
              horizontal chip scroller of TDS 06 §3.2/§3.4. */}
          <div className="border-border border-b md:hidden">
            <OpenSessionsStrip orientation="horizontal" />
          </div>

          <main id="main" className="min-h-0 flex-1 overflow-y-auto">
            <Suspense fallback={<RouteSkeleton />}>
              <Outlet />
            </Suspense>
          </main>
        </div>
      </div>

      <MobileNav />

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ShortcutSheet open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
    </div>
  );
}
