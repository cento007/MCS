import { redactSecret } from '@mc/shared';

/**
 * The worker's **one** outbound network edge, as a narrow injectable port.
 *
 * Everything about this file exists so that no test can reach `api.telegram.org` by accident
 * and no failure can hang a job:
 *
 *  - **Bounded here, not only by the transport.** The deadline is enforced by a timer in this
 *    module, so a stub or a driver that ignores an `AbortSignal` still cannot stall a delivery.
 *  - **Never throws.** A dead network, a DNS failure and a Telegram outage are ordinary answers
 *    returned as data — the worker's whole job is to record what happened to a delivery, and a
 *    thrown error would turn a recordable outcome into a crashed job.
 *  - **Abortable from outside.** The caller passes the worker's shutdown signal, so an in-flight
 *    send unblocks on SIGTERM instead of holding `offWork` open for its full timeout.
 *  - **Redacting.** The bot token is in the URL. Every string this port produces from an error
 *    passes through `redactSecret` before it leaves.
 *
 * Injecting it is how the tests exercise every delivery outcome — and the harness installs a
 * port that *throws*, so a suite that forgot to inject fails locally and loudly rather than
 * quietly messaging a real chat.
 */

/** Long enough for a cold TLS handshake to a CDN, short enough that a job never looks stuck. */
export const TELEGRAM_TIMEOUT_MS = 10_000;

/** Bot API responses are small JSON documents; anything larger is not an answer. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/** How much of a failure's own words survive into `telegram_error`. */
const MAX_DETAIL_LENGTH = 300;

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

export interface TelegramHttpRequest {
  /** Absolute Bot API URL. **Contains the bot token** — never log this string. */
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly timeoutMs: number;
  /** The worker's shutdown signal. Aborting settles the request as `aborted`. */
  readonly signal?: AbortSignal | undefined;
  /** Redacted out of every string this port returns. */
  readonly secret: string;
}

export type TelegramHttpOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly body: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'aborted' }
  | { readonly kind: 'unreachable'; readonly reason: string };

export type TelegramHttpPort = (request: TelegramHttpRequest) => Promise<TelegramHttpOutcome>;

/** The real transport: one `POST`, JSON in and out, deadline enforced, body read bounded. */
export function createTelegramHttpPort(): TelegramHttpPort {
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, request.timeoutMs);

    const onExternalAbort = (): void => {
      controller.abort();
    };
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const response = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(request.body),
        signal: controller.signal,
        redirect: 'follow',
      });

      return {
        kind: 'response',
        status: response.status,
        body: await readBounded(response, MAX_RESPONSE_BYTES),
      };
    } catch (error) {
      // Order matters: a shutdown that also raced the deadline is reported as a shutdown, so a
      // deploy does not fill `telegram_error` with timeouts nobody caused.
      if (request.signal?.aborted === true) return { kind: 'aborted' };
      if (controller.signal.aborted) return { kind: 'timeout' };
      return { kind: 'unreachable', reason: describeFailure(error, request.secret) };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }
  };
}

/**
 * A port that refuses to make a request. **The default in every test harness.**
 *
 * Forwarding an override is not enough on its own: the defect this guards against is an
 * override accepted at the call site and never reaching the module, in which case the real
 * port is constructed and the suite quietly messages a real chat. With a denying default, a
 * test that forgot to inject fails immediately, and the integration suite asserts it.
 */
export function createDenyingTelegramHttp(who: string): TelegramHttpPort {
  return async () => {
    throw new Error(
      `Refusing to call the Telegram Bot API: ${who} installed the denying HTTP port. ` +
        'Inject a stub into the delivery service instead.',
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

/** One line of a failure's own words, capped and redacted. Never a stack, never a token. */
export function describeFailure(error: unknown, secret: string | null = null): string {
  const message =
    error instanceof Error
      ? error.cause instanceof Error
        ? `${error.message}: ${error.cause.message}`
        : error.message
      : String(error);

  return redactSecret(message.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH), secret);
}
