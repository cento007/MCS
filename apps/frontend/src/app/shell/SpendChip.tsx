import { Link } from 'react-router';
import { useSpend } from '../../features/dashboard/queries.js';
import type { SpendDayStatus } from '../../lib/api/index.js';
import { formatMoneyUsd } from '../../lib/format/index.js';
import { useIsLive } from '../../lib/liveness.js';

/**
 * The top-bar spend chip (TDS 06 §3.1, UX finding WC1).
 *
 * `‹$3.42/$10.00›` — mono, `--mc-fs-2xs`, click → the Dashboard spend stat. WC1 was that the
 * cost budget was configurable while the number it constrained appeared nowhere; this chip is
 * the always-visible half of the fix, the Dashboard's Spend widget the detailed half.
 *
 * **The threshold colour is the server's `dayStatus`, never re-derived here** (TDS 04 §7.8).
 * Four surfaces state this number — this chip, the Dashboard widget, the Needs Attention
 * budget row and Settings → Claude Code — and a client-side `spent / budget >= threshold`
 * anywhere in that set is how two of them end up disagreeing about when the bar turns amber.
 * The only thing computed here is `formatMoneyUsd`.
 *
 * Three things make the chip disappear, and they are different facts:
 *
 *  - **Alerts disabled** → hidden entirely, per §3.1. That is an operator saying "do not tell
 *    me about cost", and the chip is a permanent, unclosable telling.
 *  - **Not loaded / failed to load** → hidden. A chip is a glance affordance with no room for
 *    an error state, and the Dashboard widget already reports a failed `GET /spend` properly
 *    (`ErrorPanel` + retry). `$0.00` while the request is in flight would be a wrong number
 *    rendered with total confidence.
 *  - **< 768px** → hidden, per §3.2: "the spend chip is *not* in the mobile header (space); it
 *    appears in the mobile Dashboard stack instead", which the Spend widget already is.
 *
 * §3.3's degraded-liveness table names this chip explicitly — "muted; `~` prefix on the
 * amount" — so once the socket is not `live` the value is marked last-known rather than
 * presented as current.
 */

/**
 * `dayStatus → colour`. **Not the same map as the Spend widget's rule fill**, deliberately:
 * §3.1 says the chip "turns `--mc-warning` at the alert threshold and `--mc-danger` over
 * budget", i.e. its resting state is ordinary top-bar metadata, whereas §5.2's meter fill is
 * `--mc-success` under threshold because a *meter* has to show a healthy reading as healthy.
 * A permanently cyan chip in the top bar would be a status light that never means anything.
 */
const CHIP_COLOR: Readonly<Record<SpendDayStatus, string>> = {
  no_budget: '--color-text-secondary',
  ok: '--color-text-secondary',
  alert: '--color-warning',
  over: '--color-danger',
};

/** Colour is never the only channel (TDS 06 §2.1.6), so a breach also carries a glyph. */
const CHIP_GLYPH: Readonly<Record<SpendDayStatus, string | null>> = {
  no_budget: null,
  ok: null,
  // `▲` for `over` too, not `✕`: an exceeded budget is a spending condition, not a failure.
  // The colour carries the escalation from `alert` to `over`. Same call as `attention.ts`.
  alert: '▲',
  over: '▲',
};

/** The four fields this chip actually renders, once they are known to be renderable. */
export interface SpendChipModel {
  readonly dayStatus: SpendDayStatus;
  readonly totalCostUsd: number;
  readonly dailyUsd: number | null;
  /** Title text only, so an absent threshold degrades the tooltip rather than the chip. */
  readonly alertThresholdPercent: number | null;
}

/**
 * Read `GET /spend` defensively, and return `null` for anything this chip cannot render.
 *
 * **Not paranoia about a Backend that is currently correct.** `lib/api/types.ts` is hand-written
 * against the prose contract, because `openapi.yaml` declares no response schemas — so nothing
 * checks that the shape arriving at runtime is the shape this file was compiled against. Before
 * this guard, `data.budget.alertsEnabled` on a body without `budget` threw during render, and
 * the nearest boundary was on `RequireAuth` — the *parent* of `AppShell` — so a single bad field
 * replaced the entire authenticated area, navigation included.
 *
 * `null` (hide) rather than an error marker, because that is this chip's own documented rule for
 * a body it cannot use: "**Not loaded / failed to load → hidden.** A chip is a glance affordance
 * with no room for an error state, and the Dashboard widget already reports a failed
 * `GET /spend` properly." A shape it cannot read is a failure to load. `ShellBoundary`'s ⚠ is
 * reserved for the throws nobody anticipated; this one is anticipated, so it takes the
 * documented path instead of inventing a fourth reason for the chip to look different.
 */
export function readSpendChip(data: unknown): SpendChipModel | null {
  if (typeof data !== 'object' || data === null) return null;

  const { budget, day, dayStatus } = data as Record<string, unknown>;
  if (typeof budget !== 'object' || budget === null) return null;
  if (typeof day !== 'object' || day === null) return null;
  if (!isSpendDayStatus(dayStatus)) return null;

  const { alertsEnabled, dailyUsd, alertThresholdPercent } = budget as Record<string, unknown>;
  // §3.1: "hidden entirely when cost-budget alerts are disabled in Settings". `!== true` also
  // covers the field being absent — an install whose alert state cannot be read is not one to
  // start announcing cost at.
  if (alertsEnabled !== true) return null;

  const { totalCostUsd } = day as Record<string, unknown>;
  if (!Number.isFinite(totalCostUsd)) return null;
  // `null` is the meaningful "no budget set" case (`no_budget`); any other non-number is drift.
  if (dailyUsd !== null && !Number.isFinite(dailyUsd)) return null;

  return {
    dayStatus,
    totalCostUsd: totalCostUsd as number,
    dailyUsd: dailyUsd as number | null,
    alertThresholdPercent: Number.isFinite(alertThresholdPercent)
      ? (alertThresholdPercent as number)
      : null,
  };
}

function isSpendDayStatus(value: unknown): value is SpendDayStatus {
  return typeof value === 'string' && Object.hasOwn(CHIP_COLOR, value);
}

export function SpendChip() {
  const { data } = useSpend();
  const isLive = useIsLive();

  const model = readSpendChip(data);
  if (model === null) return null;

  const amount = formatMoneyUsd(model.totalCostUsd);
  const budget = model.dailyUsd;
  const glyph = CHIP_GLYPH[model.dayStatus];

  /*
   * `no_budget` — the case §3.1 does not answer, decided here.
   *
   * The spec gives the chip a denominator and one hide rule, and the hide rule is about
   * *alerts being disabled*. `no_budget` is a different fact, and the Backend keeps them
   * strictly orthogonal: `alertsEnabled` is `notifications.events.costBudgetAlert` (an
   * operator toggle) while `no_budget` is just `budget.dailyUsd === null`
   * (`spend/status.ts`). So on a `no_budget` chip alerts are *on* — the operator has asked to
   * be told about cost — there is simply no daily limit to compare against. Which is why
   * the chip stays and drops the denominator — `$4.12`, not `$4.12 / $0.00` (a budget nobody
   * set, stated as if they had) and not `$4.12 / —` (which reads as a value that failed to
   * load). Hiding it instead would recreate WC1 exactly — spend invisible — for the one
   * install that has no budget configured at all, which is every install on day one.
   *
   * It matches the Dashboard widget, which already renders the amount with "no budget set"
   * rather than hiding it; the two surfaces have to agree, and this is the direction that
   * agrees with the finding.
   */
  const label = budget === null ? amount : `${amount} / ${formatMoneyUsd(budget)}`;

  return (
    <Link
      to="/"
      data-testid="spend-chip"
      data-day-status={model.dayStatus}
      // §3.2: not in the mobile header at all. `md:` matches the search entry beside it.
      className="hidden items-center gap-1 rounded-xs px-2 font-mono text-2xs md:inline-flex"
      style={{
        // §3.3: muted while the socket is not live — the amount is last-known, not current.
        color: isLive ? `var(${CHIP_COLOR[model.dayStatus]})` : 'var(--color-text-muted)',
        minHeight: 24,
      }}
      title={
        budget === null
          ? `Spend today ${amount} · no daily budget set`
          : // The threshold clause is dropped rather than rendered as `alert at undefined%`
            // when the field cannot be read — a missing tooltip detail is not worth hiding a
            // chip whose amount and budget are both perfectly good.
            `Spend today ${amount} of ${formatMoneyUsd(budget)}${
              model.alertThresholdPercent === null
                ? ''
                : ` · alert at ${model.alertThresholdPercent}%`
            }`
      }
    >
      {glyph === null ? null : <span aria-hidden="true">{glyph}</span>}
      <span>{isLive ? label : `~${label}`}</span>
      <span className="sr-only">
        {budget === null
          ? `Spend today ${amount}, no daily budget set.`
          : `Spend today ${amount} of ${formatMoneyUsd(budget)} daily budget, ${model.dayStatus === 'over' ? 'over budget' : model.dayStatus === 'alert' ? 'past the alert threshold' : 'within budget'}.`}
      </span>
    </Link>
  );
}
