import { Link } from 'react-router';
import { ErrorPanel } from '../../components/ErrorPanel.js';
import { Skeleton } from '../../components/Skeleton.js';
import type { Spend, SpendDayStatus } from '../../lib/api/index.js';
import { formatMoneyUsd } from '../../lib/format/index.js';
import { useIsLive, useLastUpdatedLabel } from '../../lib/liveness.js';
import { budgetPercent } from './attention.js';
import { useSpend } from './queries.js';
import { Widget } from './Widget.js';

/**
 * Spend vs budget (TDS 06 §5.2, PRD §4.4.2).
 *
 * **The threshold is the server's, not this component's.** `dayStatus` arrives computed from
 * `GET /spend` (TDS 04 §7.8) precisely so the four surfaces that state this number — this
 * widget, the top-bar chip, the Needs Attention budget row and the current-spend line in
 * Settings → Claude Code — cannot disagree about when the bar turns amber. The only thing
 * computed here is the percentage, which is a display rounding.
 *
 * The under-threshold fill is `--color-success`, **never the accent**: a meter fill whose
 * colour encodes a threshold is reporting a system condition, and TDS 06 §2.1.4 reserves the
 * accent for operator intent and position (rev. 2 correction R6).
 *
 * If cost-budget alerts are disabled the widget still shows spend, with "no budget set" in
 * place of the rule — spend is never invisible just because no limit was configured, which
 * was the original gap (WC1): the budget was configurable and the number it constrained
 * appeared nowhere.
 */
const RULE_COLOR: Readonly<Record<SpendDayStatus, string>> = {
  no_budget: '--color-border',
  ok: '--color-success',
  alert: '--color-warning',
  over: '--color-danger',
};

export function SpendWidget() {
  const query = useSpend();
  const isLive = useIsLive();
  const lastUpdated = useLastUpdatedLabel();

  return (
    <Widget
      title="Spend (today)"
      subtitle={query.data === undefined ? undefined : `calendar day in ${query.data.timezone}`}
      note={lastUpdated}
    >
      {query.isPending ? (
        <div className="space-y-2" role="status" aria-busy="true">
          <span className="sr-only">Loading spend</span>
          <Skeleton height={28} width={120} />
          <Skeleton height={8} />
        </div>
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <SpendBody spend={query.data} muted={!isLive} />
      )}
    </Widget>
  );
}

function SpendBody({ spend, muted }: { spend: Spend; muted: boolean }) {
  const percent = budgetPercent(spend);
  const hasBudget = spend.budget.dailyUsd !== null;
  const amount = formatMoneyUsd(spend.day.totalCostUsd);

  return (
    <div>
      <p
        // §3.3: "Dashboard spend stat and top-bar chip — muted; `~` prefix on the amount."
        // The prefix marks the number as last-known rather than current; the value itself is
        // never invented, only qualified.
        data-testid="spend-today"
        className={`font-mono text-2xl leading-110 tracking-2xl ${muted ? 'text-text-muted' : 'text-text'}`}
        title="Observed sessions report no cost"
      >
        {muted ? `~${amount}` : amount}
      </p>

      <p className="mt-1 text-text-secondary text-xs">
        {hasBudget ? `of ${formatMoneyUsd(spend.budget.dailyUsd)}` : 'no budget set'}
      </p>

      {hasBudget ? (
        <>
          <div
            role="progressbar"
            aria-label="Daily spend against budget"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            data-testid="spend-rule"
            data-day-status={spend.dayStatus}
            className="mt-2 w-full overflow-hidden rounded-full"
            style={{ height: 4, backgroundColor: 'var(--color-surface-inset)' }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, Math.max(0, percent))}%`,
                backgroundColor: `var(${RULE_COLOR[spend.dayStatus]})`,
              }}
            />
          </div>

          <p className="mt-1 text-2xs text-text-muted">
            {percent}% ·{' '}
            <Link to="/settings/integrations" className="rounded-xs underline decoration-dotted">
              alert at {spend.budget.alertThresholdPercent}%
            </Link>
          </p>
        </>
      ) : (
        <p className="mt-2 text-2xs text-text-muted">
          <Link to="/settings/integrations" className="rounded-xs underline decoration-dotted">
            Set a daily budget
          </Link>
        </p>
      )}

      <p className="mt-3 text-2xs text-text-muted">
        month <span className="font-mono">{formatMoneyUsd(spend.month.totalCostUsd)}</span> ·{' '}
        {spend.month.sessionCount} session{spend.month.sessionCount === 1 ? '' : 's'}
      </p>

      <p className="sr-only">Observed sessions report no cost.</p>
    </div>
  );
}
