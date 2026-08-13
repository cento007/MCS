import { useState } from 'react';
import { Link } from 'react-router';
import type { ServiceHealthRow } from '../lib/api/index.js';
import { formatClockSeconds } from '../lib/format/index.js';
import {
  SERVICE_HEALTH_POLL_MS,
  serviceDetailText,
  serviceStatusPresentation,
  useServiceHealth,
} from '../lib/service-health.js';
import { ErrorPanel } from './ErrorPanel.js';
import { Skeleton } from './Skeleton.js';

/**
 * The Services health panel (TDS 06 §5.7.12) and its compact Dashboard variant (§5.2).
 *
 * TDS 05 §7.5: "A compact variant of this panel is reusable on the Dashboard." One component
 * with two renderings rather than two components, so the status vocabulary, the glyphs and
 * the 10 s poll cannot drift between the two screens that show them.
 *
 * The data is **polled, not socket-driven** — see `lib/service-health.ts` for why that is a
 * design decision rather than an omission.
 *
 * Per F2.1/F3 the queue row reads "Queue (PostgreSQL)": Redis does not exist in this
 * topology and must never appear in this UI. The label is whatever the server sent — it is
 * never derived here.
 */
export function ServicesPanel({ variant = 'full' }: { variant?: 'compact' | 'full' }) {
  const query = useServiceHealth();
  const rows = query.data?.services ?? [];

  if (query.isPending) {
    return (
      <div className="space-y-2" role="status" aria-busy="true">
        <span className="sr-only">Loading service health</span>
        <Skeleton height={variant === 'compact' ? 20 : 28} />
        <Skeleton height={variant === 'compact' ? 20 : 28} />
        <Skeleton height={variant === 'compact' ? 20 : 28} />
      </div>
    );
  }

  if (query.isError) {
    return <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />;
  }

  if (variant === 'compact') {
    return (
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map((row) => {
          // Never `row.detail` raw: an `unknown` row is a failed *check*, and the shared
          // helper is what keeps this tooltip from blaming the service it names.
          const detail = serviceDetailText(row);
          return (
            <li key={row.name} className="min-w-0">
              <Link
                to="/settings/services"
                className="flex min-w-0 items-center gap-1 rounded-xs text-2xs"
                style={{ minHeight: 24 }}
                title={detail === null ? row.label : `${row.label} — ${detail}`}
              >
                <StatusGlyph row={row} />
                <span className="truncate text-text-secondary">{row.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    );
  }

  const checkedAt = rows[0]?.checkedAt ?? null;

  return (
    <div>
      <table className="w-full border-collapse">
        <caption className="sr-only">
          Service health, refreshed every {Math.round(SERVICE_HEALTH_POLL_MS / 1000)} seconds
        </caption>
        <thead>
          <tr className="text-left text-2xs text-text-secondary uppercase">
            <th scope="col" className="py-2 pr-3 font-medium">
              Service
            </th>
            <th scope="col" className="py-2 pr-3 font-medium">
              Status
            </th>
            <th scope="col" className="py-2 font-medium">
              Detail
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <FullRow key={row.name} row={row} />
          ))}
        </tbody>
      </table>

      <p className="mt-2 text-2xs text-text-muted">
        auto-refresh {Math.round(SERVICE_HEALTH_POLL_MS / 1000)}s
        {checkedAt === null ? '' : ` · checked ${formatClockSeconds(checkedAt)}`}
      </p>
    </div>
  );
}

/**
 * One row of the `full` variant, with §5.7.12's `[view error]` disclosure.
 *
 * The disclosure is offered only for `degraded` and `down`, and that restriction is the point:
 * §5.7.12 attaches it to the row that "expands the last error", and a `disabled` row has no
 * error to show — offering the affordance there would imply a fault where the contract states
 * "specified but not deployed". The expanded body is the probe's own `detail` plus its `meta`
 * (heartbeat age, queue depth, latency) on `--color-surface-inset`, because that object is the
 * only machine-readable evidence the panel receives and paraphrasing it would lose it.
 */
function FullRow({ row }: { row: ServiceHealthRow }) {
  const [expanded, setExpanded] = useState(false);
  const presentation = serviceStatusPresentation(row.status);
  const diagnosable = row.status === 'degraded' || row.status === 'down';

  return (
    <>
      <tr className="border-border border-t align-top" data-testid={`service-row-${row.name}`}>
        <td className="py-2 pr-3 text-sm text-text">{row.label}</td>
        <td className="py-2 pr-3">
          <span
            className="inline-flex items-center gap-1 text-2xs"
            data-testid={`service-status-${row.name}`}
            data-status={row.status}
            data-attention={presentation.attention ? 'true' : 'false'}
          >
            <StatusGlyph row={row} />
            <span style={{ color: `var(${presentation.colorVar})` }}>{presentation.label}</span>
          </span>
        </td>
        <td className="py-2 text-text-secondary text-xs">
          {serviceDetailText(row) ?? '—'}
          {diagnosable ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              aria-expanded={expanded}
              className="ml-2 rounded-xs underline decoration-dotted underline-offset-2"
              style={{ color: 'var(--color-text-muted)', minHeight: 24, minWidth: 24 }}
            >
              {expanded ? 'hide error' : 'view error'}
            </button>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={3} className="pb-3">
            <pre
              data-testid={`service-error-${row.name}`}
              className="overflow-x-auto rounded-sm p-3 font-mono text-2xs text-text-secondary"
              style={{ backgroundColor: 'var(--color-surface-inset)' }}
            >
              {JSON.stringify({ detail: row.detail, meta: row.meta }, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * Glyph + verbatim status name for assistive tech. The glyph is mandatory in the compact
 * variant, where there is no room for the status word (TDS 06 §2.1.6).
 */
function StatusGlyph({ row }: { row: ServiceHealthRow }) {
  const { glyph, colorVar, label } = serviceStatusPresentation(row.status);

  return (
    <span
      role="img"
      aria-label={`${row.label}: ${label}`}
      title={label}
      className="shrink-0"
      style={{ color: `var(${colorVar})` }}
    >
      {glyph}
    </span>
  );
}
