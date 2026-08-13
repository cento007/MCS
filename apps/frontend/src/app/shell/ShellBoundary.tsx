import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * A boundary around one shell widget, so a widget that throws cannot evict the shell.
 *
 * ## What this fixes
 *
 * The only error boundary in the route table sits on the `RequireAuth` element
 * (`app/router.tsx`), which is the **parent** of `AppShell`. A render failure anywhere in the
 * shell — a top-bar chip, the nav rail, the open-sessions strip — therefore replaced the whole
 * authenticated area with "Something broke on this page", *including the navigation that would
 * have let the operator go somewhere else*. One malformed read model took the entire app, and
 * the operator's only recovery was a reload onto the same broken route.
 *
 * `RouteErrorBoundary`'s own comment says it is "deliberately the last line rather than the
 * first". This is the first line. The shell's widgets are independent of one another and of
 * the route, so they should fail independently — losing the spend chip should cost the spend
 * chip.
 *
 * ## Why the fallback is never `null`
 *
 * `SpendChip` documents three separate reasons it renders nothing — alerts disabled, not
 * loaded, below 768px — and all three are deliberate states. If a **crashed** widget also
 * rendered nothing, a defect would be indistinguishable from an operator setting: the chip is
 * missing, so cost alerting must be switched off. That is precisely the mistake the Memory
 * screen's four empty states exist to prevent, reproduced in one corner of the top bar.
 *
 * So a crashed widget renders a marker that cannot be mistaken for data, carrying its reason on
 * `title` and to screen readers. `—` is deliberately *not* that marker: it already means "no
 * value" here — `RunningCount` renders it when `GET /sessions` errors, and `TopBar` renders it
 * for an unknown username.
 *
 * ## What it does not catch, and why that is fine
 *
 * React boundaries catch render, lifecycle and constructor errors — **not** event handlers and
 * not rejected promises, which still reach `window.onerror`. Nor do they catch TanStack Query
 * failures, because those are not exceptions: they are `isError` state, which every widget in
 * this shell already handles explicitly. This is the net under *shape* failures, which is where
 * the real exposure is: `lib/api/types.ts` is hand-written against the prose contract (there
 * are no response schemas in `openapi.yaml`), so a Backend field rename is caught by nothing
 * until it dereferences `undefined` in a component.
 *
 * ## The fallback persists until remount, deliberately
 *
 * There is no auto-reset when new data arrives. A widget that threw once has no claim to be
 * trusted on the next render, and a marker that flickers between broken and fine as queries
 * refetch is harder to read — and harder to report — than one that stays put. Remounting the
 * boundary (a `key` change, or a reload) is the reset.
 */

interface ShellBoundaryProps {
  /**
   * What failed, in the operator's words rather than the component's — "Spend indicator", not
   * "SpendChip". It is read aloud and shown on hover, so it names the thing that is missing
   * from the screen.
   */
  readonly label: string;
  readonly children: ReactNode;
  /** Test seam: asserts the error reached the boundary without depending on console output. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

interface ShellBoundaryState {
  readonly failed: boolean;
}

export class ShellBoundary extends Component<ShellBoundaryProps, ShellBoundaryState> {
  override state: ShellBoundaryState = { failed: false };

  static getDerivedStateFromError(): ShellBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError?.(error);
    // The console is the only sink a self-hosted SPA has — there is no error-reporting service
    // and TDS 02 §9.4 keeps logs to stdout on the server side. Logged at `error` with the
    // component stack because the marker on screen is deliberately too small to diagnose from.
    console.error(`[shell] ${this.props.label} failed to render`, error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <span
        // Deliberately **no** `role="status"`. The marker is static, not a live region, and the
        // top bar already has a real one — `ConnectionChip` — which tests and screen readers
        // both address as *the* status. A second one here would make `getByRole('status')`
        // ambiguous exactly when something is already broken, and would announce a defect with
        // the same urgency as a transport change. The `sr-only` text below is read in flow.
        data-testid="shell-boundary-fallback"
        className="inline-flex items-center px-2 text-2xs"
        // Inline rather than a utility class: this file's palette lives in `theme.css` custom
        // properties and there is no `text-warning` utility in this codebase (every other
        // coloured chip does the same — see `SpendChip`).
        style={{ color: 'var(--color-warning)' }}
        title={`${this.props.label} could not be displayed. The rest of Mission Control is unaffected — see the browser console.`}
      >
        <span aria-hidden="true">⚠</span>
        <span className="sr-only">{this.props.label} could not be displayed.</span>
      </span>
    );
  }
}
