import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';

/**
 * A Phase 1–2 screen whose content belongs to a later task.
 *
 * Distinct from `PhasePlaceholder`, which is the permanent, roadmap-facing Phase 3/4 shell.
 * This one is scaffolding: the route, its heading and its landmark exist so navigation,
 * keyboard dispatch, the open-sessions strip and the socket wiring can be exercised
 * end-to-end before the screen itself lands.
 *
 * The `h1` takes focus on mount — TDS 06 §7.2 requires focus to be programmatically managed
 * at route change, and a SPA that silently swaps `main` leaves a screen-reader user's focus
 * on a control that no longer exists.
 */
export function PagePlaceholder({
  title,
  summary,
  owner,
  children,
}: {
  title: string;
  summary: string;
  /** Which contract section defines what lands here. */
  owner: string;
  children?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <section className="px-6 py-6">
      <h1 ref={headingRef} tabIndex={-1} className="font-medium text-text text-xl outline-none">
        {title}
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-text-secondary leading-150">{summary}</p>
      <p className="mt-4 text-text-muted text-xs">Specified by {owner}.</p>
      {children}
    </section>
  );
}
