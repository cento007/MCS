import { type ToastKind, useToastStore } from '../stores/toast-store.js';

/**
 * Toast surface (TDS 06 §4.5, §2.5 Toast).
 *
 * Bottom-right on desktop, top on mobile; `--color-surface-raised` with a 3px status rule
 * on the left edge. The container is an `aria-live` region so a toast an operator is not
 * looking at is still announced — a failure that only exists as a coloured rectangle in the
 * corner is a failure a screen-reader user never learns about.
 */
const RULE_COLOR: Readonly<Record<ToastKind, string>> = {
  success: 'var(--color-success)',
  info: 'var(--color-info)',
  warning: 'var(--color-warning)',
  danger: 'var(--color-danger)',
};

export function Toaster() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-4 top-4 z-50 flex flex-col gap-2 md:inset-x-auto md:top-auto md:right-6 md:bottom-6 md:w-96"
    >
      {toasts.map((item) => (
        <div
          key={item.id}
          className="pointer-events-auto rounded-lg border border-border p-3"
          style={{
            backgroundColor: 'var(--color-surface-raised)',
            borderLeft: `3px solid ${RULE_COLOR[item.kind]}`,
            boxShadow: 'var(--shadow-overlay)',
          }}
        >
          <div className="flex items-start gap-3">
            <p className="flex-1 text-sm text-text">{item.message}</p>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="Dismiss notification"
              className="rounded-xs px-2 text-text-muted text-xs"
              style={{ minWidth: 24, minHeight: 24 }}
            >
              ✕
            </button>
          </div>
          {item.detail === undefined ? null : (
            <p className="mt-1 font-mono text-2xs text-text-muted">{item.detail}</p>
          )}
          {item.action === undefined ? null : (
            <button
              type="button"
              onClick={() => {
                item.action?.run();
                dismiss(item.id);
              }}
              className="mt-2 rounded-sm border border-border-control px-3 font-medium text-sm text-text"
              style={{ height: 'var(--mc-control-sm)' }}
            >
              {item.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
