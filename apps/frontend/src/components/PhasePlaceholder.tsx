import type { ReactNode } from 'react';

/**
 * The one placeholder component for every Phase 3–5 destination (TDS 05 §10).
 *
 * > "The placeholder pattern is one shared `<PhasePlaceholder phase={n} title description />`
 * > component so placeholders are consistent and trivially replaceable."
 *
 * The route exists, is reachable, and says what it will be — it is never `disabled`.
 * TDS 06 §2.5 is explicit about why: a phase-gated destination is focusable and it *does*
 * something (it routes), so `disabled` would be a lie to both the pointer user and the
 * screen-reader user, and `--color-text-disabled` is deliberately exempt from the AA
 * contrast floor. The badge, not the contrast, communicates "later phase".
 */
export function PhasePlaceholder({
  phase,
  title,
  description,
  children,
}: {
  phase: 3 | 4 | 5;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <section className="mx-auto max-w-2xl px-6 py-16">
      <div className="flex items-center gap-3">
        <h1 className="font-medium text-text text-xl">{title}</h1>
        <PhaseBadge phase={phase} />
      </div>
      <p className="mt-3 text-sm text-text-secondary leading-150">{description}</p>
      <p className="mt-4 text-text-muted text-xs">
        This screen ships in Phase {phase}. The route, the navigation entry and the reserved
        query-key namespace are the only commitments made today.
      </p>
      {children}
    </section>
  );
}

/** Muted `P3` / `P4` tag (TDS 06 §2.5). Never paired with dimmed label text. */
export function PhaseBadge({ phase }: { phase: 3 | 4 | 5 }) {
  return (
    <span
      className="inline-flex items-center rounded-xs border border-border px-2 py-05 font-medium text-2xs text-text-muted"
      title={`Available in Phase ${phase}`}
    >
      P{phase}
    </span>
  );
}
