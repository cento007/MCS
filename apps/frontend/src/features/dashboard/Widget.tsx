import { type ReactNode, useId } from 'react';
import { Link } from 'react-router';

/**
 * The Dashboard card frame (TDS 06 §5.2).
 *
 * Every widget is a labelled `section` with an `h2`, so the page is navigable by landmark and
 * heading rather than by sighted scanning alone — this screen is the mobile monitoring entry
 * point (§9.2) and eight unlabelled cards would be eight unlabelled cards on a phone.
 *
 * The header carries three optional affordances the wireframe specifies:
 *  - a count beside the title (`NEEDS ATTENTION (3)`),
 *  - the `→` link to the page that owns the data,
 *  - a right-aligned note, which is where the §3.3 `updated HH:MM` disclosure lands when the
 *    connection chip is not `live`.
 */
export function Widget({
  title,
  count,
  to,
  toLabel,
  subtitle,
  note,
  children,
  className = '',
}: {
  title: string;
  count?: number | undefined;
  /** The page that owns this data. Renders the `→` affordance when present. */
  to?: string | undefined;
  toLabel?: string | undefined;
  subtitle?: string | undefined;
  /** Right-aligned header note — `updated HH:MM` when the socket is not live. */
  note?: string | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();

  return (
    <section
      aria-labelledby={headingId}
      className={`flex min-w-0 flex-col rounded-md border border-border p-3 ${className}`}
      style={{ backgroundColor: 'var(--color-surface)' }}
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <h2
          id={headingId}
          className="min-w-0 truncate font-medium text-2xs text-text-secondary uppercase tracking-0"
        >
          {title}
          {count === undefined ? null : <span className="ml-1 text-text">({count})</span>}
        </h2>

        {to === undefined ? null : (
          <Link
            to={to}
            aria-label={toLabel ?? `View ${title}`}
            className="ml-auto rounded-xs px-1 text-2xs"
            style={{ color: 'var(--color-accent)', minHeight: 24 }}
          >
            →
          </Link>
        )}

        {note === undefined || note === null ? null : (
          <p className={`${to === undefined ? 'ml-auto' : ''} shrink-0 text-2xs text-text-muted`}>
            {note}
          </p>
        )}
      </div>

      {subtitle === undefined ? null : <p className="mt-1 text-2xs text-text-muted">{subtitle}</p>}

      <div className="mt-2 min-w-0 flex-1">{children}</div>
    </section>
  );
}
