import { SESSION_STATES } from '@mc/shared/types';
import type { ReactNode } from 'react';
import { StatusBadge } from './StatusBadge.js';

/**
 * Minimal app shell.
 *
 * SCAFFOLD STATE: this renders the token system and nothing else. The real shell — nav
 * rail, top bar, ConnectionChip, open-sessions strip, command palette, mobile bottom nav —
 * is TDS 06 §3 and belongs to WS4. There is no router, no data layer and no WebSocket
 * client here yet; adding them before their workstream lands would be guesswork.
 *
 * What this page IS for: proving that `@theme` tokens resolve, that dark is the default
 * with no light block, that the F7 state ramp is wired to the six canonical states, and
 * that the type/spacing/radius scales exist.
 */
export function AppShell({ children }: { children?: ReactNode }) {
  return (
    <div className="min-h-full bg-bg text-text">
      <header className="border-border border-b bg-surface px-6 py-4">
        <h1 className="font-medium text-text text-xl tracking-0">Mission Control</h1>
        <p className="mt-1 text-text-muted text-xs">
          Phase 1 foundation scaffold — no features implemented yet.
        </p>
      </header>

      <main className="p-6">
        <section className="rounded-md border border-border bg-surface p-4">
          <h2 className="font-medium text-lg text-text">Design tokens</h2>
          <p className="mt-1 text-text-secondary text-xs">
            If these render as a near-black canvas with an emerald accent and six
            distinctly-coloured state badges, the CSS-first Tailwind 4 theme is wired correctly.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {SESSION_STATES.map((state) => (
              <StatusBadge key={state} state={state} />
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded-sm bg-accent px-4 font-medium text-on-accent text-sm"
              style={{ height: 'var(--mc-control-md)' }}
            >
              Primary action
            </button>
            <button
              type="button"
              className="rounded-sm border border-border-control bg-surface px-4 font-medium text-sm text-text"
              style={{ height: 'var(--mc-control-md)' }}
            >
              Secondary action
            </button>
            <code className="rounded-xs bg-surface-inset px-2 py-1 font-mono text-text-secondary text-sm">
              0198a2f3-4c2a-7d31-9e44-2f1a09b7c001
            </code>
          </div>
        </section>

        {children}
      </main>
    </div>
  );
}
