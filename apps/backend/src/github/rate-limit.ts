/**
 * GitHub's rate-limit headers, and the budget this process keeps from them. Pure — no clock of
 * its own, no I/O — so the exhaustion path is unit tested in microseconds.
 *
 * GitHub signals two different limits with the same status codes, and conflating them is the
 * mistake this module exists to prevent:
 *
 *  - **Primary limit** — `403` (classic) or `429` (newer) with `x-ratelimit-remaining: 0` and
 *    `x-ratelimit-reset` as a Unix epoch second. The budget is gone until that instant. Nothing
 *    retried before then can succeed.
 *  - **Secondary / abuse limit** — `403` or `429` with `retry-after` in seconds and a
 *    *non-zero* remaining budget. GitHub is asking for a pause, not reporting exhaustion.
 *
 * In both cases the honest response is the same and it is not a retry loop: stop, record why,
 * and say when it is worth trying again. `RateLimitBudget` makes the *next* call cheap to
 * refuse — a poll over twenty repositories must not spend twenty round trips discovering the
 * same exhausted budget.
 */

export interface RateLimitSnapshot {
  /** Requests allowed in the window. `null` when GitHub did not say. */
  readonly limit: number | null;
  readonly remaining: number | null;
  /** When the window resets. `null` when GitHub did not say. */
  readonly resetAt: Date | null;
  /** `core`, `search`, … — GitHub buckets by resource and reports which one it charged. */
  readonly resource: string | null;
  /** `retry-after`, in seconds, as an absolute instant. Secondary-limit signal. */
  readonly retryAfterAt: Date | null;
}

export const EMPTY_RATE_LIMIT: RateLimitSnapshot = Object.freeze({
  limit: null,
  remaining: null,
  resetAt: null,
  resource: null,
  retryAfterAt: null,
});

/**
 * Read the rate-limit headers off a response.
 *
 * `now` is a parameter because `retry-after` is *relative* — resolving it against a real clock
 * inside a parser would make this untestable and would silently drift under a slow response.
 */
export function parseRateLimit(
  headers: Readonly<Record<string, string>>,
  now: Date,
): RateLimitSnapshot {
  const retryAfterSeconds = integerHeader(headers['retry-after']);
  const resetSeconds = integerHeader(headers['x-ratelimit-reset']);

  return {
    limit: integerHeader(headers['x-ratelimit-limit']),
    remaining: integerHeader(headers['x-ratelimit-remaining']),
    resetAt: resetSeconds === null ? null : new Date(resetSeconds * 1000),
    resource: headers['x-ratelimit-resource'] ?? null,
    retryAfterAt:
      retryAfterSeconds === null ? null : new Date(now.getTime() + retryAfterSeconds * 1000),
  };
}

/** Did this response say "your budget is gone", as opposed to "you may not do that"? */
export function isPrimaryExhaustion(snapshot: RateLimitSnapshot): boolean {
  return snapshot.remaining === 0;
}

/**
 * The instant at which it is worth calling GitHub again — the later of the two signals, or
 * `null` when neither was present.
 */
export function retryEligibleAt(snapshot: RateLimitSnapshot): Date | null {
  const candidates = [snapshot.resetAt, snapshot.retryAfterAt].filter(
    (value): value is Date => value !== null,
  );
  if (candidates.length === 0) return null;
  return new Date(Math.max(...candidates.map((value) => value.getTime())));
}

/**
 * What this process currently believes about its GitHub budget.
 *
 * Deliberately advisory rather than authoritative: it is updated from responses and consulted
 * before requests, and a wrong belief costs at most one wasted call (the response corrects it).
 * It exists so that "the budget is exhausted" is discovered **once per window** instead of once
 * per repository — the difference between a poll that degrades honestly and a poll that spends
 * its whole tick collecting identical 403s.
 */
export class RateLimitBudget {
  #snapshot: RateLimitSnapshot = EMPTY_RATE_LIMIT;
  /** Set only by an actual 403/429; a merely low `remaining` is not a block. */
  #blockedUntil: Date | null = null;

  get snapshot(): RateLimitSnapshot {
    return this.#snapshot;
  }

  get blockedUntil(): Date | null {
    return this.#blockedUntil;
  }

  /** Fold in the headers of any response. */
  observe(snapshot: RateLimitSnapshot): void {
    this.#snapshot = snapshot;
  }

  /** Record that GitHub actually refused a call, and until when. */
  block(snapshot: RateLimitSnapshot, until: Date | null): void {
    this.#snapshot = snapshot;
    // A refusal with no reset header is still a refusal. Without a stated instant the block
    // would either last forever or not at all; neither is defensible, so an unstated window is
    // treated as "one minute", long enough to stop a tight loop and short enough to self-heal.
    this.#blockedUntil = until ?? new Date(Date.now() + FALLBACK_BLOCK_MS);
  }

  /** `null` when a request may proceed; otherwise the instant it becomes worth retrying. */
  blockedAt(now: Date): Date | null {
    if (this.#blockedUntil === null) return null;
    if (this.#blockedUntil.getTime() <= now.getTime()) {
      this.#blockedUntil = null;
      return null;
    }
    return this.#blockedUntil;
  }

  /** Forgets the block. Used when settings change — a new token has a new budget. */
  reset(): void {
    this.#snapshot = EMPTY_RATE_LIMIT;
    this.#blockedUntil = null;
  }
}

const FALLBACK_BLOCK_MS = 60_000;

function integerHeader(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
