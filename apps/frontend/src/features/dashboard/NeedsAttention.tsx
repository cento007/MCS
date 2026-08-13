import { Link } from 'react-router';
import { Skeleton } from '../../components/Skeleton.js';
import { formatRelativePast } from '../../lib/format/relative.js';
import { useIsLive, useLastUpdatedLabel, useLiveClock } from '../../lib/liveness.js';
import { useServiceHealth } from '../../lib/service-health.js';
import { type AttentionItem, buildAttention, MAX_ATTENTION_ROWS } from './attention.js';
import {
  projectNames,
  useActiveProjects,
  useFailedSessions,
  useNotifications,
  useSpend,
} from './queries.js';
import { Widget } from './Widget.js';

/**
 * Needs Attention — first in the grid and first in the mobile stack (TDS 06 §5.2).
 *
 * The aggregation itself is pure and lives in `attention.ts`; this component owns only the
 * four fetches, the §3.3 degraded treatment and the two shapes the widget can take.
 *
 * **Empty is one line, not a card.** "It never occupies a full card's worth of vertical space
 * when there is nothing to say, and it never disappears — its absence and its 'all clear' must
 * be distinguishable." A permanently present empty card on the most-visited page is furniture
 * that operators learn to skip, which is exactly how a real failure gets missed.
 */
export function NeedsAttention() {
  const clock = useLiveClock();
  const isLive = useIsLive();
  const lastUpdated = useLastUpdatedLabel();

  const failed = useFailedSessions();
  const health = useServiceHealth();
  const notifications = useNotifications(20);
  const spend = useSpend();
  const projects = useActiveProjects();

  const digest = buildAttention({
    failedSessions: failed.sessions,
    projectNames: projectNames(projects.data),
    services: health.data?.services ?? [],
    notifications: notifications.data ?? [],
    spend: spend.data ?? null,
    now: clock.now,
  });

  const pending = failed.isPending || health.isPending || spend.isPending;
  // A source that failed to load is NOT "nothing to report". Saying "All clear" over a broken
  // fetch is the one lie this widget cannot afford, so the degraded case says so instead.
  const brokenSources = [
    failed.isError ? 'sessions' : null,
    health.isError ? 'services' : null,
    spend.isError ? 'spend' : null,
    notifications.isError ? 'notifications' : null,
  ].filter((source): source is string => source !== null);

  if (pending && digest.items.length === 0) {
    return (
      <Widget title="Needs attention" className="lg:col-span-3">
        <div role="status" aria-busy="true">
          <span className="sr-only">Checking for failures</span>
          <Skeleton height={20} />
        </div>
      </Widget>
    );
  }

  if (digest.items.length === 0 && brokenSources.length === 0) {
    return <AllClear note={lastUpdated} />;
  }

  return (
    <Widget
      title="Needs attention"
      count={digest.totalCount}
      note={lastUpdated}
      className="lg:col-span-3"
    >
      <ul
        // §3.3 live region: an operator who is not looking here still needs to be told when
        // something breaks.
        aria-live="polite"
        className="flex flex-col"
        style={{ opacity: isLive ? 1 : 0.75 }}
      >
        {digest.items.map((item) => (
          <li key={item.id} className="border-border border-t first:border-t-0">
            <AttentionRow item={item} now={clock.now} />
          </li>
        ))}
      </ul>

      {digest.totalCount > MAX_ATTENTION_ROWS ? (
        <p className="mt-2 text-2xs text-text-muted">
          {digest.totalCount - MAX_ATTENTION_ROWS} more not shown
        </p>
      ) : null}

      {brokenSources.length === 0 ? null : (
        <p className="mt-2 text-2xs" style={{ color: 'var(--color-warning)' }}>
          ▲ Could not check {brokenSources.join(', ')} — this list may be incomplete.
        </p>
      )}
    </Widget>
  );
}

/**
 * The one-line "all clear" rule. A `--mc-success` rule rather than a card, and it carries the
 * same heading as the card form so the two states are the same region to assistive tech.
 */
function AllClear({ note }: { note: string | null }) {
  return (
    <section
      aria-label="Needs attention"
      data-testid="needs-attention-all-clear"
      className="flex items-center gap-2 rounded-md border border-border border-l-2 px-3 py-2 lg:col-span-3"
      style={{ backgroundColor: 'var(--color-surface)', borderLeftColor: 'var(--color-success)' }}
    >
      <span aria-hidden="true" style={{ color: 'var(--color-success)' }}>
        ✓
      </span>
      <p className="text-text-secondary text-xs" aria-live="polite">
        All clear · no failures in the last 24 h
      </p>
      {note === null ? null : <p className="ml-auto text-2xs text-text-muted">{note}</p>}
    </section>
  );
}

function AttentionRow({ item, now }: { item: AttentionItem; now: number }) {
  const color = item.severity === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)';

  return (
    <Link
      to={item.to}
      data-testid={`attention-${item.source}`}
      className="flex min-w-0 items-start gap-2 py-2"
      style={{ minHeight: 24 }}
    >
      <span aria-hidden="true" className="shrink-0" style={{ color }}>
        {item.glyph}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text">{item.title}</span>
        {item.detail === null ? null : (
          <span className="block truncate text-2xs text-text-muted">{item.detail}</span>
        )}
      </span>

      <span className="shrink-0 text-2xs text-text-muted">
        {item.occurredAt === null ? 'now' : formatRelativePast(item.occurredAt, now)}
      </span>
      <span aria-hidden="true" className="shrink-0 text-2xs text-text-muted">
        →
      </span>
    </Link>
  );
}
