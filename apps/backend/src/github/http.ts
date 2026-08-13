/**
 * The one outbound network edge of the GitHub integration, as a narrow injectable port.
 *
 * It exists as a port and not as a bare `fetch` call for two reasons, and the second is the
 * one that keeps costing us:
 *
 *  1. **Every call is bounded.** A wall-clock deadline enforced *here* (not only by the
 *     transport), a capped body read, and no retries. An unbounded outbound call is what made
 *     `POST /sessions/{id}/start` hang for 45 seconds; a poll that stalls on a half-open TCP
 *     connection would do the same to the sync job and, through it, to the Repositories view.
 *  2. **Tests must not be able to reach the network.** The port is constructed exactly once,
 *     in `registerGithub`, and only when the caller supplied none. `createDenyingGithubHttp`
 *     is what the integration harness installs by default: a suite that quietly reaches
 *     api.github.com is a suite that fails on a train, and this repository has already been
 *     burned once by an override that was accepted but not forwarded.
 *
 * The port never throws. A dead network, a DNS failure and a stalled TLS handshake are all
 * ordinary answers returned as data — the client above turns them into a `sync_status` an
 * operator can act on, never into a 500.
 */

/**
 * Long enough for a cold TLS handshake to api.github.com plus a 50-item page, short enough
 * that a poll over twenty repositories cannot outlive its own interval.
 */
export const GITHUB_TIMEOUT_MS = 10_000;

/**
 * A `?per_page=100` commit page with large messages runs to a few hundred kilobytes; the
 * single-commit endpoint with a big diff runs larger. 4 MiB is far above anything GitHub
 * returns for the endpoints this integration calls and far below "allocate until OOM".
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** How much of a transport failure's own words survive into an operator-facing message. */
const MAX_REASON_LENGTH = 300;

export interface GithubHttpRequest {
  readonly url: string;
  /** Includes `authorization`. The token is NEVER placed in the URL — see `client.ts`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export type GithubHttpOutcome =
  | {
      readonly kind: 'response';
      readonly status: number;
      /** Lower-cased names — the rate-limit parser indexes them directly. */
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
    }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'unreachable'; readonly reason: string };

export type GithubHttpPort = (request: GithubHttpRequest) => Promise<GithubHttpOutcome>;

/** The real transport: `fetch`, aborted at the deadline, with a bounded body read. */
export function createGithubHttpPort(): GithubHttpPort {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);
    timer.unref?.();

    try {
      const response = await fetch(request.url, {
        method: 'GET',
        headers: { ...request.headers },
        signal: controller.signal,
        // GitHub answers 301 for a renamed repository. Following it would silently sync the
        // *new* repository under the old row's name; the client reports the 301 instead.
        redirect: 'manual',
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });

      return {
        kind: 'response',
        status: response.status,
        headers,
        body: await readBounded(response, MAX_RESPONSE_BYTES),
      };
    } catch (error) {
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'unreachable', reason: describeTransportFailure(error) };
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * A port that refuses to do anything and says so.
 *
 * Installed by the integration harness for every test that has not deliberately supplied its
 * own double, so an accidental outbound call fails loudly and locally instead of succeeding
 * quietly against the real api.github.com.
 */
export function createDenyingGithubHttp(label = 'test'): GithubHttpPort {
  return (request) => {
    throw new Error(
      `Outbound GitHub request blocked in ${label}: ${request.url}. ` +
        'Inject a GithubHttpPort double instead of reaching the network.',
    );
  };
}

async function readBounded(response: Response, max: number): Promise<string> {
  const body = response.body;
  if (body === null) return '';

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  try {
    while (received < max) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer.subarray(0, max));
}

/** One line of a transport failure's own words, capped. Never a stack. */
export function describeTransportFailure(error: unknown): string {
  const message =
    error instanceof Error
      ? error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error.message
      : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}
