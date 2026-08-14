import type { Notification, ServiceHealthRow, Session, Spend } from '../../lib/api/index.js';
import { formatMoneyUsd, sessionLabel } from '../../lib/format/index.js';
import { attentionServices, serviceDetailText } from '../../lib/service-health.js';

/**
 * Needs Attention — the aggregation, pure (TDS 06 §5.2).
 *
 * This widget exists because a `session.failed` that happened while the operator was away
 * otherwise leaves no trace: the Phase 1 notification inbox has no producer for most types
 * yet, so the toast died with the page, and the failure was reachable only by navigating to
 * the screen that owned it. The Dashboard's job is to answer "what is broken?" first.
 *
 * Four sources, all folded into one ordered list here rather than in the component, so the
 * ordering and the exclusions are unit-testable without a DOM:
 *
 *  1. Sessions that entered `failed` in the last 24 h  → `/sessions/:id`
 *  2. Services that are not healthy                     → Settings → Services
 *  3. The last `sync_failed` Notification (Phase 2)     → Settings → Integrations
 *  4. A cost-budget breach, from the server's `dayStatus` → Settings → Integrations
 *
 * Severity ordering per §5.2: `failed` Sessions first, then `down` services, then
 * `degraded`/`unknown` services, sync, budget. Row glyphs are `✕` (danger) and `▲`
 * (warning) — never colour alone.
 */

export type AttentionSource = 'session' | 'service' | 'sync' | 'budget';
export type AttentionSeverity = 'danger' | 'warning';

export interface AttentionItem {
  readonly id: string;
  readonly source: AttentionSource;
  readonly severity: AttentionSeverity;
  /** `✕` or `▲`. Mandatory — colour is never the only channel (TDS 06 §2.1.6). */
  readonly glyph: string;
  readonly title: string;
  readonly detail: string | null;
  /** When the condition was observed. `null` for conditions that are true *right now*. */
  readonly occurredAt: string | null;
  /** In-app deep link. Every row has one — §5.2: "every row deep-links". */
  readonly to: string;
}

export interface AttentionDigest {
  /** At most `MAX_ATTENTION_ROWS`, already ordered. */
  readonly items: readonly AttentionItem[];
  /** Everything that qualified, including rows the cap hid. */
  readonly totalCount: number;
}

/** §5.2: "Sessions that entered `failed` in the last 24 h". */
export const ATTENTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one `failureReason` that is not a condition needing attention.
 *
 * A Session the operator cancelled before it launched is `failed` because F7 gives a Session that
 * never ran no other exit — not because anything went wrong. Listing it here would put `✕ Session
 * failed` in front of the operator for the thing they just did, most often by stopping a workflow
 * run, which is the widget crying wolf about its own user. Every other reason (`spawn_error`,
 * `process_crash`, `backend_restart`, `resume_target_lost`) is news and still appears.
 *
 * Matched verbatim against the Backend's vocabulary (TDS 03 §3.9), like `failedSecondaryLine`
 * below: a reason this build does not recognise is shown, never suppressed.
 */
export const CANCELLED_FAILURE_REASON = 'cancelled';

/** §5.2: "newest first, max 8 rows". */
export const MAX_ATTENTION_ROWS = 8;

export interface AttentionSources {
  readonly failedSessions: readonly Session[];
  /** `projectId → name`, for the row's secondary line. Missing ids simply omit the project. */
  readonly projectNames: ReadonlyMap<string, string>;
  readonly services: readonly ServiceHealthRow[];
  /** Newest notifications; the builder picks the last `sync_failed` itself. */
  readonly notifications: readonly Notification[];
  readonly spend: Spend | null;
  /** Epoch ms. Comes from the frozen live clock, so the window stops moving with the socket. */
  readonly now: number;
}

export function buildAttention(sources: AttentionSources): AttentionDigest {
  const items = [
    ...sessionItems(sources),
    ...serviceItems(sources.services),
    ...syncItems(sources.notifications),
    ...budgetItems(sources.spend),
  ];

  return { items: items.slice(0, MAX_ATTENTION_ROWS), totalCount: items.length };
}

/**
 * The instant a Session entered `failed`.
 *
 * `completed_at` is set on `failed` as well as on `completed` (TDS 03 §3.9 / WS1's state
 * machine), so it is the real transition time. `updatedAt` is the fallback for a row that
 * predates that behaviour — never `createdAt`, which is when the Session was *launched* and
 * would keep a long-running Session that failed a minute ago out of a 24 h window.
 */
export function failedAt(session: Session): string {
  return session.completedAt ?? session.updatedAt;
}

function sessionItems(sources: AttentionSources): readonly AttentionItem[] {
  return sources.failedSessions
    .filter((session) => session.state === 'failed')
    .filter((session) => session.failureReason?.trim() !== CANCELLED_FAILURE_REASON)
    .filter((session) => withinWindow(failedAt(session), sources.now))
    .sort((a, b) => Date.parse(failedAt(b)) - Date.parse(failedAt(a)))
    .map((session) => ({
      id: `session:${session.id}`,
      source: 'session' as const,
      severity: 'danger' as const,
      glyph: '✕',
      // §9.3: title first, never a UUIDv7 prefix — those leading hex characters are the
      // millisecond the Session started and are identical across a busy hour.
      title: `Session failed — ${sessionLabel({ id: session.id, title: session.title })}`,
      detail: failedSecondaryLine(session, sources.projectNames),
      occurredAt: failedAt(session),
      to: `/sessions/${session.id}`,
    }));
}

/**
 * Services that are not healthy, `down` before `degraded`/`unknown`.
 *
 * **`disabled` never appears here.** It means *specified but not deployed* — Qdrant, Ollama
 * and the Phase 2 workers — so surfacing it would put permanent rows in this widget for an
 * install behaving exactly as designed. See `lib/service-health.ts` for the full reasoning;
 * this function delegates the predicate there so the panel and the widget cannot disagree.
 */
function serviceItems(services: readonly ServiceHealthRow[]): readonly AttentionItem[] {
  const ranked = [...attentionServices(services)].sort(
    (a, b) => serviceRank(a.status) - serviceRank(b.status),
  );

  return ranked.map((service) => ({
    id: `service:${service.name}`,
    source: 'service' as const,
    severity: service.status === 'down' ? ('danger' as const) : ('warning' as const),
    // The `✕`/`▲` pair here is §5.2's *row severity* vocabulary, not §5.7.12's status glyphs —
    // two different alphabets for two different questions, so this is not a second definition
    // of the status glyph. `unknown` maps to `▲`; its `?` belongs to the Services surfaces.
    glyph: service.status === 'down' ? '✕' : '▲',
    title: `${service.label} ${service.status}`,
    // Via the shared helper: an `unknown` worker row means the heartbeat read failed, and the
    // row is titled with the worker's name, so the detail has to say where the fault is.
    detail: serviceDetailText(service),
    occurredAt: service.checkedAt,
    to: '/settings/services',
  }));
}

function serviceRank(status: ServiceHealthRow['status']): number {
  return status === 'down' ? 0 : 1;
}

/**
 * The last `sync_failed` Notification.
 *
 * Sourced from the Notification (§8) rather than from `GET /sync-runs`, because the
 * notification row is the artifact that survives the run: it carries the pre-rendered reason
 * and the instant, and it is the same record the Telegram message was built from. In Phase 1
 * nothing writes one yet, so this contributes nothing — honestly, rather than by pretending
 * the source does not exist.
 */
function syncItems(notifications: readonly Notification[]): readonly AttentionItem[] {
  const failures = notifications
    .filter((notification) => notification.type === 'sync_failed')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const last = failures[0];
  if (last === undefined) return [];

  return [
    {
      id: `sync:${last.id}`,
      source: 'sync',
      severity: 'warning',
      glyph: '▲',
      title: last.title.length > 0 ? last.title : 'Obsidian sync failed',
      detail: last.body.length > 0 ? last.body : null,
      occurredAt: last.createdAt,
      to: '/settings/integrations',
    },
  ];
}

/**
 * The cost-budget row, driven entirely by the server's `dayStatus`.
 *
 * **The threshold is never re-derived here** (TDS 04 §7.8): `dayStatus` is computed
 * server-side precisely so the Dashboard meter, the top-bar chip, this row and the
 * current-spend line in Settings cannot disagree about when the bar turns amber. Only the
 * percentage — a display rounding — is computed client-side.
 *
 * `budget.alertsEnabled` is deliberately *not* consulted: it governs whether a
 * `cost_budget_alert` Notification is delivered (§8), not whether an on-screen meter reports
 * a condition the server has already evaluated.
 */
function budgetItems(spend: Spend | null): readonly AttentionItem[] {
  if (spend === null) return [];
  if (spend.dayStatus !== 'alert' && spend.dayStatus !== 'over') return [];

  const spent = formatMoneyUsd(spend.day.totalCostUsd);
  const budget = formatMoneyUsd(spend.budget.dailyUsd);

  return [
    {
      id: 'budget:day',
      source: 'budget',
      severity: spend.dayStatus === 'over' ? 'danger' : 'warning',
      // `▲` even when over budget: an exceeded budget is a spending condition, not a
      // failure, and `✕` is this widget's failure glyph. The colour carries the escalation.
      glyph: '▲',
      title: `Daily spend ${spent} of ${budget} — ${budgetPercent(spend)}%`,
      detail:
        spend.dayStatus === 'over'
          ? 'Over the daily budget'
          : `Alert threshold ${spend.budget.alertThresholdPercent}%`,
      // True as of now, not as of an event — the row shows `now`, which is the honest answer.
      occurredAt: null,
      to: '/settings/integrations',
    },
  ];
}

/** Display rounding only. The *threshold* decision is `dayStatus`, and it is the server's. */
export function budgetPercent(spend: Spend): number {
  const budget = spend.budget.dailyUsd;
  if (budget === null || budget <= 0) return 0;
  return Math.round((spend.day.totalCostUsd / budget) * 100);
}

function withinWindow(timestamp: string, now: number): boolean {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return false;
  return now - at <= ATTENTION_WINDOW_MS;
}

/** `project · branch` (§9.3), omitting whichever half the client does not have. */
export function secondaryLine(session: Session, names: ReadonlyMap<string, string>): string | null {
  const parts = [names.get(session.projectId), session.branch].filter(
    (part): part is string => typeof part === 'string' && part.length > 0,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The failed row's second line: `project · branch · code` (§5.2).
 *
 * §5.2 specifies the failed-session row as "`✕ Session failed` · title · project · time ·
 * `code` + `requestId`", and the code is the only part of that which answers *why*. It comes
 * from `Session.failureReason`, verbatim — `spawn_error`, `process_crash`, `backend_restart`
 * are the Backend's own vocabulary (TDS 03 §3.9) and prettifying them would break the
 * operator's grep against the Backend log, which is the entire point of showing a code.
 *
 * **Degrades to exactly the old line when it is `null`.** A `failed` Session whose transition
 * carried no reason is a real case, and inventing `unknown` for it would be indistinguishable
 * from a Session that genuinely failed with an `unknown` code. `requestId` is deliberately
 * absent: nothing persists one against a Session today, so there is no honest value to show.
 */
export function failedSecondaryLine(
  session: Session,
  names: ReadonlyMap<string, string>,
): string | null {
  const reason = session.failureReason?.trim() ?? '';
  const parts = [secondaryLine(session, names), reason.length === 0 ? null : reason].filter(
    (part): part is string => part !== null,
  );
  return parts.length === 0 ? null : parts.join(' · ');
}
