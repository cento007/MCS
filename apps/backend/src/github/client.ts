import { redactSecret } from '../settings/test-connection/ports.js';
import { GITHUB_TIMEOUT_MS, type GithubHttpPort } from './http.js';
import {
  isPrimaryExhaustion,
  parseRateLimit,
  RateLimitBudget,
  type RateLimitSnapshot,
  retryEligibleAt,
} from './rate-limit.js';

/**
 * The GitHub REST client (TDS 02 §2: "commit/PR polling producers").
 *
 * Four properties, in the order they matter:
 *
 *  1. **It never throws and it never returns a 500's worth of ambiguity.** Every call resolves
 *     to `{ ok: true, value }` or `{ ok: false, failure }`, where the failure carries a *kind*
 *     the sync service switches on and a *message* written for the operator who will read it in
 *     `repositories.last_sync_error`. "Token rejected by GitHub (401)" is worth ten
 *     "Sync failed"s.
 *  2. **It never retries into a wall.** There is no retry loop anywhere in this file. A rate
 *     limit is reported, not slept through: sleeping would hold a pg-boss job's lease for up to
 *     an hour, and retrying would burn the *secondary* limit that GitHub imposes precisely to
 *     stop that behaviour. The `RateLimitBudget` goes further and refuses the *next* call
 *     locally while the window is closed, so a poll over twenty repositories discovers an
 *     exhausted budget once instead of twenty times.
 *  3. **The token never leaves this process.** It travels in an `authorization` header, never
 *     in a URL, and every string this client produces is passed through `redactSecret` before
 *     it can reach `last_sync_error`, an event payload, an audit row or a log line. There is no
 *     logger in this file and no `toJSON` that could serialize the field.
 *  4. **Every call is bounded** by the port's deadline (`http.ts`) and by an explicit page cap.
 *     This is a poll, not a history importer: it reads one page and says so.
 */

export const GITHUB_API_BASE_URL = 'https://api.github.com';

/** GitHub rejects requests without one with a 403 that reads like an auth failure. */
export const GITHUB_USER_AGENT = 'mission-control';

/** Pinned so a future GitHub default cannot silently reshape a response we parse. */
export const GITHUB_API_VERSION = '2022-11-28';

/** GitHub's own maximum. Asking for more is silently clamped, so ask for exactly this. */
export const MAX_PER_PAGE = 100;

export type GithubFailureKind =
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'not_found'
  | 'moved'
  | 'http_error'
  | 'timeout'
  | 'unreachable'
  | 'malformed';

export interface GithubFailure {
  readonly kind: GithubFailureKind;
  readonly status: number | null;
  /**
   * Operator-facing and already redacted. Safe to persist in `repositories.last_sync_error`,
   * to put in a `repository.sync_failed` payload, and to log.
   */
  readonly message: string;
  /** ISO instant at which a retry could succeed; `null` when retrying will not help. */
  readonly retryAfterAt: string | null;
  readonly rateLimit: RateLimitSnapshot;
}

export type GithubResult<T> =
  | { readonly ok: true; readonly value: T; readonly rateLimit: RateLimitSnapshot }
  | { readonly ok: false; readonly failure: GithubFailure };

export interface GithubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export interface GithubClientOptions {
  readonly http: GithubHttpPort;
  /** The unsealed `integrations.github.token`. Held in a private field, never re-exposed. */
  readonly token: string;
  readonly baseUrl?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Shared across a poll tick so one exhausted window is discovered once. */
  readonly budget?: RateLimitBudget | undefined;
}

export class GithubClient {
  readonly #http: GithubHttpPort;
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #now: () => Date;
  readonly #budget: RateLimitBudget;

  constructor(options: GithubClientOptions) {
    this.#http = options.http;
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? GITHUB_API_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? GITHUB_TIMEOUT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#budget = options.budget ?? new RateLimitBudget();
  }

  get budget(): RateLimitBudget {
    return this.#budget;
  }

  /** `GET /repos/{owner}/{repo}` — name, visibility, default branch, canonical URL. */
  async getRepository(ref: GithubRepositoryRef): Promise<GithubResult<unknown>> {
    return this.#get(`/repos/${segment(ref.owner)}/${segment(ref.repo)}`, describeRef(ref));
  }

  /**
   * `GET /repos/{owner}/{repo}/commits` — one page of the given branch, newest first.
   *
   * One page, no `Link` following. A poll that walked a repository's whole history on first
   * contact would spend thousands of requests to import commits nobody asked for; the sync
   * service treats the newest page as the window and records the cursor.
   */
  async listCommits(
    ref: GithubRepositoryRef,
    options: { readonly branch: string; readonly perPage: number },
  ): Promise<GithubResult<unknown>> {
    const query = new URLSearchParams({
      sha: options.branch,
      per_page: String(Math.min(options.perPage, MAX_PER_PAGE)),
    });
    return this.#get(
      `/repos/${segment(ref.owner)}/${segment(ref.repo)}/commits?${query.toString()}`,
      `${describeRef(ref)} (branch ${options.branch})`,
    );
  }

  /** `GET /repos/{owner}/{repo}/commits/{sha}` — the only source of a commit's `files[]`. */
  async getCommit(ref: GithubRepositoryRef, sha: string): Promise<GithubResult<unknown>> {
    return this.#get(
      `/repos/${segment(ref.owner)}/${segment(ref.repo)}/commits/${segment(sha)}`,
      `${describeRef(ref)}@${sha.slice(0, 12)}`,
    );
  }

  /** `GET /repos/{owner}/{repo}/pulls?state=all&sort=updated` — one page, most recent first. */
  async listPullRequests(
    ref: GithubRepositoryRef,
    options: { readonly perPage: number },
  ): Promise<GithubResult<unknown>> {
    const query = new URLSearchParams({
      state: 'all',
      sort: 'updated',
      direction: 'desc',
      per_page: String(Math.min(options.perPage, MAX_PER_PAGE)),
    });
    return this.#get(
      `/repos/${segment(ref.owner)}/${segment(ref.repo)}/pulls?${query.toString()}`,
      `pull requests of ${describeRef(ref)}`,
    );
  }

  /**
   * `GET /repos/{owner}/{repo}/pulls/{number}/reviews` — the source of `pull_requests.reviewed_at`.
   *
   * The list endpoint does not carry reviews, so this is one request per PR. The sync service
   * caps how many it will spend per run and never re-asks once `reviewed_at` is known.
   */
  async listReviews(
    ref: GithubRepositoryRef,
    number: number,
    options: { readonly perPage: number },
  ): Promise<GithubResult<unknown>> {
    const query = new URLSearchParams({
      per_page: String(Math.min(options.perPage, MAX_PER_PAGE)),
    });
    return this.#get(
      `/repos/${segment(ref.owner)}/${segment(ref.repo)}/pulls/${String(number)}/reviews?${query.toString()}`,
      `reviews of ${describeRef(ref)}#${String(number)}`,
    );
  }

  async #get(path: string, resource: string): Promise<GithubResult<unknown>> {
    const now = this.#now();

    // Pre-flight: the window this process already knows is closed. No request is made, and the
    // answer is the same one the network would have given — minus the round trip and minus the
    // secondary-limit penalty for asking again.
    const blockedUntil = this.#budget.blockedAt(now);
    if (blockedUntil !== null) {
      return {
        ok: false,
        failure: {
          kind: 'rate_limited',
          status: null,
          message:
            `GitHub API rate limit is exhausted until ${blockedUntil.toISOString()}; ` +
            `skipped ${resource} without contacting GitHub. Sync will succeed after that time.`,
          retryAfterAt: blockedUntil.toISOString(),
          rateLimit: this.#budget.snapshot,
        },
      };
    }

    const outcome = await this.#http({
      url: `${this.#baseUrl}${path}`,
      timeoutMs: this.#timeoutMs,
      headers: {
        // The credential lives here and only here. Never a query parameter, never a URL.
        authorization: `Bearer ${this.#token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': GITHUB_API_VERSION,
        'user-agent': GITHUB_USER_AGENT,
      },
    });

    if (outcome.kind === 'timeout') {
      return this.#fail({
        kind: 'timeout',
        status: null,
        message: `Timed out after ${String(this.#timeoutMs)} ms fetching ${resource} from api.github.com`,
        retryAfterAt: null,
        rateLimit: this.#budget.snapshot,
      });
    }

    if (outcome.kind === 'unreachable') {
      return this.#fail({
        kind: 'unreachable',
        status: null,
        message: `Could not reach api.github.com for ${resource} — ${this.#redact(outcome.reason)}`,
        retryAfterAt: null,
        rateLimit: this.#budget.snapshot,
      });
    }

    const rateLimit = parseRateLimit(outcome.headers, now);
    this.#budget.observe(rateLimit);

    if (outcome.status >= 200 && outcome.status < 300) {
      const json = parseJson(outcome.body);
      if (json === MALFORMED) {
        return this.#fail({
          kind: 'malformed',
          status: outcome.status,
          message: `GitHub returned a ${String(outcome.status)} for ${resource} whose body was not JSON. This is usually a proxy or captive portal answering instead of GitHub.`,
          retryAfterAt: null,
          rateLimit,
        });
      }
      return { ok: true, value: json, rateLimit };
    }

    return this.#fail(this.#classify(outcome.status, outcome.body, resource, rateLimit));
  }

  #classify(
    status: number,
    body: string,
    resource: string,
    rateLimit: RateLimitSnapshot,
  ): GithubFailure {
    const detail = this.#messageFrom(body);
    const suffix = detail === null ? '' : ` — ${detail}`;

    // 403 and 429 are both used for both limits; `x-ratelimit-remaining` is what disambiguates.
    if (status === 403 || status === 429) {
      const exhausted = isPrimaryExhaustion(rateLimit);
      const until = retryEligibleAt(rateLimit);

      if (exhausted || rateLimit.retryAfterAt !== null) {
        this.#budget.block(rateLimit, until);
        const when = until === null ? 'shortly' : `at ${until.toISOString()}`;
        return {
          kind: 'rate_limited',
          status,
          message: exhausted
            ? `GitHub API rate limit exhausted (${describeBudget(rateLimit)}); it resets ${when}. ` +
              `Sync of ${resource} stopped without retrying and will succeed after that time.`
            : `GitHub asked Mission Control to slow down (secondary rate limit, ${String(status)}); retry ${when}. ` +
              `Sync of ${resource} stopped without retrying.`,
          retryAfterAt: until?.toISOString() ?? null,
          rateLimit,
        };
      }

      return {
        kind: 'forbidden',
        status,
        message:
          `GitHub refused access to ${resource} (403)${suffix}. The token is valid but is not permitted ` +
          'to read this repository — check its repository access and that it carries the `repo` scope for private repositories.',
        retryAfterAt: null,
        rateLimit,
      };
    }

    if (status === 401) {
      return {
        kind: 'unauthorized',
        status,
        message:
          'Token rejected by GitHub (401). Create a new personal access token and save it in Settings → Integrations → GitHub.',
        retryAfterAt: null,
        rateLimit,
      };
    }

    if (status === 404) {
      return {
        kind: 'not_found',
        status,
        message:
          `GitHub has no ${resource} (404). It may have been renamed, deleted, or made private — ` +
          'check the remote and that the saved token can see it.',
        retryAfterAt: null,
        rateLimit,
      };
    }

    if (status === 301 || status === 302 || status === 307 || status === 308) {
      return {
        kind: 'moved',
        status,
        message:
          `GitHub answered ${String(status)} for ${resource}: the repository has been renamed or transferred. ` +
          'Update the `origin` remote of the local clone, then sync again.',
        retryAfterAt: null,
        rateLimit,
      };
    }

    return {
      kind: 'http_error',
      status,
      message: `GitHub answered ${String(status)} for ${resource}${suffix}`,
      retryAfterAt: null,
      rateLimit,
    };
  }

  #fail(failure: GithubFailure): GithubResult<never> {
    return { ok: false, failure: { ...failure, message: this.#redact(failure.message) } };
  }

  /**
   * The last line of defence. Every operator-facing string this client produces goes through
   * here, including ones that cannot contain the token — the cheap belt-and-braces call is the
   * reason `token-redaction.test.ts` can assert the property mechanically over every failure
   * kind rather than over the ones we remembered.
   */
  #redact(text: string): string {
    return redactSecret(text, this.#token);
  }

  #messageFrom(body: string): string | null {
    const json = parseJson(body);
    if (json === MALFORMED || typeof json !== 'object' || json === null) return null;
    const message = (json as Record<string, unknown>)['message'];
    return typeof message === 'string' && message.length > 0
      ? this.#redact(message.slice(0, 300))
      : null;
  }
}

/** Distinguishes "the body was `null`" from "the body did not parse". */
const MALFORMED = Symbol('malformed');

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return MALFORMED;
  }
}

function describeRef(ref: GithubRepositoryRef): string {
  return `repository ${ref.owner}/${ref.repo}`;
}

function describeBudget(rateLimit: RateLimitSnapshot): string {
  if (rateLimit.limit === null) return '0 remaining';
  return `0 of ${String(rateLimit.limit)} remaining`;
}

/**
 * Percent-encode one path segment.
 *
 * `owner` and `repo` are already constrained by `remote.ts`, but a sha or a branch name reaches
 * this file from a working tree the operator controls, and a branch may legitimately contain
 * `#`, `?` or `%`. Encoding here is what keeps a branch name from becoming URL syntax.
 */
function segment(value: string): string {
  return encodeURIComponent(value);
}
