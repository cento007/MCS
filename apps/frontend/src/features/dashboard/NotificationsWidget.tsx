import { EmptyState } from '../../components/EmptyState.js';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import type { Notification } from '../../lib/api/index.js';
import { useLiveClock } from '../../lib/liveness.js';
import { useNotifications } from './queries.js';
import { formatRelativePast } from './relative.js';
import { Widget } from './Widget.js';

/**
 * Notifications (TDS 06 §5.2).
 *
 * `GET /notifications` (TDS 04 §8) is served today, so this widget queries it for real — but
 * creation is system-only and most producers ship in Phase 2, so an empty list is the normal
 * Phase 1 answer and is rendered as such. That is exactly why Needs Attention exists above:
 * until the inbox has producers, a `session.failed` that happened while the operator was away
 * leaves no trace here.
 *
 * Severity is the server's (`info` / `warning` / `error`), rendered with a glyph as well as a
 * colour so it survives every form of colour blindness.
 */
const SEVERITY: Readonly<Record<Notification['severity'], { glyph: string; colorVar: string }>> = {
  info: { glyph: '•', colorVar: '--color-info' },
  warning: { glyph: '▲', colorVar: '--color-warning' },
  error: { glyph: '✕', colorVar: '--color-danger' },
};

export function NotificationsWidget() {
  const query = useNotifications(5);
  const clock = useLiveClock();
  const rows = query.data ?? [];

  return (
    // Two columns rather than three: it sits on the same row as Upcoming Tasks, which is one
    // column wide, and a full-width Notifications card would leave two empty columns beside it.
    <Widget title="Notifications" className="lg:col-span-2">
      {query.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading notifications</span>
          <Skeleton height={20} />
          <Skeleton height={20} />
        </div>
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          compact
          title="No notifications"
          hint="Session, sync and budget alerts land here once their workers ship in Phase 2."
        />
      ) : (
        <ul className="flex flex-col">
          {rows.map((notification) => (
            <li
              key={notification.id}
              className="flex min-w-0 items-baseline gap-2 border-border border-t py-1 first:border-t-0"
            >
              <span
                aria-hidden="true"
                className="shrink-0 text-2xs"
                style={{ color: `var(${SEVERITY[notification.severity].colorVar})` }}
              >
                {SEVERITY[notification.severity].glyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text">
                  {notification.title}
                  <span className="sr-only"> ({notification.severity})</span>
                </span>
                {notification.body.length === 0 ? null : (
                  <span className="block truncate text-2xs text-text-muted">
                    {notification.body}
                  </span>
                )}
              </span>
              <span className="shrink-0 text-2xs text-text-muted">
                {formatRelativePast(notification.createdAt, clock.now)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Widget>
  );
}
