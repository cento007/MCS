import type { ReactNode } from 'react';

/**
 * Shared empty state (TDS 05 §11.2, TDS 06 §4.2).
 *
 * "Empty ≠ loading ≠ error" — every list surface must define all three explicitly, and a
 * filtered-to-empty result is a different state from a genuinely empty one.
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <p className="text-sm text-text-muted">{title}</p>
      {hint === undefined ? null : <p className="text-text-muted text-xs">{hint}</p>}
      {action}
    </div>
  );
}
