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
  compact = false,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  /**
   * Dashboard-card density. A route-level empty state earns its whitespace; the same
   * treatment inside a widget makes an empty card taller than a full one, which is how the
   * Dashboard ends up mostly blank space on an instance that simply has nothing running.
   */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 px-6 text-center ${
        compact ? 'py-6' : 'py-16'
      }`}
    >
      <p className="text-sm text-text-muted">{title}</p>
      {hint === undefined ? null : <p className="text-text-muted text-xs">{hint}</p>}
      {action}
    </div>
  );
}
