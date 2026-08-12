/**
 * Loading primitives (TDS 05 §11.2, TDS 06 §4.1).
 *
 * > "Skeletons, not spinners, for structural loads."
 *
 * A spinner says "wait"; a skeleton says "wait, and here is the shape of what is coming",
 * which on an operator console is the difference between a blank pause and a page that is
 * obviously about to be a table. The shimmer is a `mc-shimmer` class so the global
 * reduced-motion reset in `app.css` can flatten it to a static block.
 */
export function Skeleton({ className = '', width, height = 12 }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={`mc-shimmer block rounded-xs ${className}`}
      style={{
        backgroundColor: 'var(--color-hover)',
        ...(width === undefined ? {} : { width }),
        height,
      }}
    />
  );
}

export interface SkeletonProps {
  readonly className?: string;
  readonly width?: number | string;
  readonly height?: number | string;
}

/** Full-page skeleton behind a lazy route boundary (§2.3, §11.2). */
export function RouteSkeleton() {
  return (
    <div className="p-6" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading</span>
      <Skeleton width={220} height={22} />
      <div className="mt-6 space-y-3">
        <Skeleton height={36} />
        <Skeleton height={36} />
        <Skeleton height={36} />
        <Skeleton height={36} />
        <Skeleton height={36} />
      </div>
    </div>
  );
}
