/**
 * Notification text — pure, and the only place `title`/`body` are written.
 *
 * TDS 04 §8 makes both **pre-rendered**: "Telegram and the UI share it". So the words an
 * operator reads in the browser and the words their phone buzzes with are the same string,
 * produced once, at production time, from facts the producer had. The Telegram Worker adds
 * transport formatting (HTML escaping, a bold title) and nothing else — it never re-words a
 * Notification, because a channel that paraphrases is a channel that can disagree with the
 * record.
 *
 * PRD §9 fixes the content of two of these:
 *   - **Session Complete** — "Summary, Commits, Duration"
 *   - **Daily Report** — "Projects, Sessions, PRs, ADRs" (rendered in the Telegram Worker,
 *     which is the process that owns the scheduled job — TDS 02 §2.2)
 * and describes the rest as "Alerts: Failed Syncs, Repository Problems, Session Errors".
 *
 * Everything here is a total function over its input: a missing project name, an absent
 * duration and a Session that never got a title are all ordinary, and each degrades to a
 * stated phrase rather than to `undefined` in an operator's notification.
 */

export interface RenderedNotification {
  readonly title: string;
  readonly body: string;
}

export const UNTITLED_SESSION = 'Untitled session';

// ------------------------------------------------------------------------------- formatting

/**
 * `1h 04m`, `4m 12s`, `8s` — never `3600000`.
 *
 * Deliberately not `Intl.RelativeTimeFormat`: this is an elapsed duration, not a relative
 * time, and "in 1 hour" is the wrong sentence for "the session took an hour".
 */
export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown';

  const totalSeconds = Math.round(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/**
 * `$1.20`, `$0.0042`.
 *
 * Sub-cent amounts get four decimals because a Claude Code turn routinely costs less than a
 * cent, and `$0.00` for a real charge reads as "free" — which is the one thing a spend line
 * must never imply.
 */
export function formatUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return 'unknown';
  return `$${amount < 1 ? amount.toFixed(4) : amount.toFixed(2)}`;
}

function pad(value: number): string {
  return value.toString().padStart(2, '0');
}

/** Join the non-empty lines of a body. Absent facts drop their line entirely. */
export function bodyLines(lines: readonly (string | null)[]): string {
  return lines.filter((line): line is string => line !== null && line.length > 0).join('\n');
}

/** One line of a failure's own words, flattened and capped — never a stack. */
export function shortReason(reason: string | null | undefined, max = 300): string | null {
  if (typeof reason !== 'string') return null;
  const flattened = reason.replace(/\s+/g, ' ').trim();
  return flattened.length === 0 ? null : flattened.slice(0, max);
}

// -------------------------------------------------------------------------------- sessions

export interface SessionNotificationFacts {
  readonly sessionId: string;
  readonly title: string | null;
  readonly projectName: string | null;
  readonly sessionType: string;
  /** Runtime-reported active duration; falls back to the wall-clock span. */
  readonly durationMs: number | null;
  readonly commitCount: number;
  readonly totalCostUsd: number | null;
  readonly failureReason: string | null;
}

/** PRD §9 Session Complete: Summary, Commits, Duration. */
export function renderSessionCompleted(facts: SessionNotificationFacts): RenderedNotification {
  const summary = facts.title ?? UNTITLED_SESSION;

  return {
    title: `Session completed — ${summary}`,
    body: bodyLines([
      facts.projectName === null ? null : `Project: ${facts.projectName}`,
      `Duration: ${formatDuration(facts.durationMs)}`,
      `Commits: ${facts.commitCount}`,
      // Observed Sessions report no cost (§7.8 footnote), so the line is omitted rather than
      // printed as `$0.00` — which would claim a free session instead of an unmeasured one.
      facts.totalCostUsd === null ? null : `Cost: ${formatUsd(facts.totalCostUsd)}`,
    ]),
  };
}

/** PRD §9 Alerts: "Session Errors". */
export function renderSessionFailed(facts: SessionNotificationFacts): RenderedNotification {
  const summary = facts.title ?? UNTITLED_SESSION;
  const reason = shortReason(facts.failureReason);

  return {
    title: `Session failed — ${summary}`,
    body: bodyLines([
      facts.projectName === null ? null : `Project: ${facts.projectName}`,
      `Reason: ${reason ?? 'not recorded'}`,
      `Duration: ${formatDuration(facts.durationMs)}`,
      `Commits: ${facts.commitCount}`,
    ]),
  };
}

// ---------------------------------------------------------------------------- repositories

export interface RepositoryNotificationFacts {
  readonly repositoryId: string;
  readonly name: string | null;
  readonly reason: string | null;
  readonly localPath: string | null;
}

/** PRD §9 Alerts: "Repository Problems". */
export function renderRepositoryProblem(facts: RepositoryNotificationFacts): RenderedNotification {
  const name = facts.name ?? 'Unknown repository';

  return {
    title: `Repository sync failed — ${name}`,
    body: bodyLines([
      `Repository: ${name}`,
      `Reason: ${shortReason(facts.reason) ?? 'not recorded'}`,
      facts.localPath === null ? null : `Path: ${facts.localPath}`,
    ]),
  };
}

// ------------------------------------------------------------------------------------ sync

export interface SyncNotificationFacts {
  readonly syncRunId: string;
  readonly reason: string | null;
}

/** PRD §9 Alerts: "Failed Syncs" — Obsidian sync runs only (TDS 04 §15.2 row 25). */
export function renderSyncFailed(facts: SyncNotificationFacts): RenderedNotification {
  return {
    title: 'Obsidian sync failed',
    body: bodyLines([
      `Reason: ${shortReason(facts.reason) ?? 'not recorded'}`,
      `Sync run: ${facts.syncRunId}`,
    ]),
  };
}

// ----------------------------------------------------------------------------- cost budget

export interface CostBudgetNotificationFacts {
  readonly status: 'alert' | 'over';
  readonly spentUsd: number;
  readonly budgetUsd: number;
  readonly thresholdPercent: number;
  readonly timezone: string;
  readonly localDate: string;
}

/** PRD §4.4.2's budget alert. Not an event — a threshold evaluation (TDS 04 §15.2 note). */
export function renderCostBudgetAlert(facts: CostBudgetNotificationFacts): RenderedNotification {
  const percent = facts.budgetUsd > 0 ? Math.round((facts.spentUsd / facts.budgetUsd) * 100) : 0;

  return {
    title:
      facts.status === 'over'
        ? `Daily spend is over budget — ${formatUsd(facts.spentUsd)}`
        : `Daily spend at ${percent}% of budget`,
    body: bodyLines([
      `Spent today: ${formatUsd(facts.spentUsd)} of ${formatUsd(facts.budgetUsd)} (${percent}%)`,
      `Alert threshold: ${facts.thresholdPercent}%`,
      `Day: ${facts.localDate} (${facts.timezone})`,
    ]),
  };
}
