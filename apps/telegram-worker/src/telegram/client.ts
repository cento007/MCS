import { redactSecret } from '@mc/shared';
import { TELEGRAM_API_ORIGIN, TELEGRAM_TIMEOUT_MS, type TelegramHttpPort } from './http.js';

/**
 * The Telegram Bot API client — total, redacting, retry-free.
 *
 * **Retry-free is deliberate.** This client classifies; the delivery service decides whether to
 * try again, how long to wait, and when to stop (`MAX_DELIVERY_ATTEMPTS`). A client that
 * retried internally would hide the attempt count from the `notifications` row, which is the
 * one place an operator can see it.
 *
 * **Every outcome is data.** `sendMessage` cannot throw for a Telegram condition: a rejected
 * token, a deleted chat, a rate limit and a dead network all come back as a `SendOutcome`, and
 * every human-readable string in one has been through `redactSecret` — the token is in the URL,
 * and transport errors quote URLs.
 *
 * The split that matters is **terminal vs retriable**:
 *
 *   - *terminal* — no amount of waiting fixes it. A revoked token, a chat the bot was kicked
 *     from, a message Telegram refuses to parse. Recorded as `failed` on the first attempt.
 *   - *retriable* — the same request could succeed later. `429`, `5xx`, a timeout, a network
 *     blip. Retried with backoff up to the cap, then recorded as `failed`.
 *
 * Getting that boundary wrong in the safe-looking direction (treat everything as retriable) is
 * exactly how a home server ends up hammering `api.telegram.org` forever with a token that was
 * revoked in March.
 */

export interface SendMessageInput {
  readonly botToken: string;
  readonly chatId: string;
  /** Already formatted for HTML parse mode (`format.ts`). */
  readonly text: string;
  readonly signal?: AbortSignal | undefined;
}

export type SendOutcome =
  | { readonly kind: 'sent'; readonly messageId: number | null }
  | {
      readonly kind: 'rate_limited';
      readonly retryAfterSeconds: number | null;
      readonly message: string;
    }
  | { readonly kind: 'retriable'; readonly message: string }
  | { readonly kind: 'terminal'; readonly message: string }
  /** The process is shutting down. Not an outcome for the row — the job must be retried. */
  | { readonly kind: 'aborted' };

export interface TelegramClientOptions {
  readonly http: TelegramHttpPort;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

export class TelegramClient {
  readonly #http: TelegramHttpPort;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: TelegramClientOptions) {
    this.#http = options.http;
    this.#baseUrl = options.baseUrl ?? TELEGRAM_API_ORIGIN;
    this.#timeoutMs = options.timeoutMs ?? TELEGRAM_TIMEOUT_MS;
  }

  async sendMessage(input: SendMessageInput): Promise<SendOutcome> {
    const redact = (text: string): string => redactSecret(text, input.botToken);

    const outcome = await this.#http({
      // THE CREDENTIAL IS IN THIS STRING. It goes to the port and nowhere else.
      url: `${this.#baseUrl}/bot${input.botToken}/sendMessage`,
      body: {
        chat_id: input.chatId,
        text: input.text,
        parse_mode: 'HTML',
        // Mission Control links are loopback URLs a phone cannot open; a preview card for one
        // is noise at best. Notifications are also not conversations — no reply threading.
        disable_web_page_preview: true,
      },
      timeoutMs: this.#timeoutMs,
      signal: input.signal,
      secret: input.botToken,
    });

    switch (outcome.kind) {
      case 'aborted':
        return { kind: 'aborted' };

      case 'timeout':
        return {
          kind: 'retriable',
          message: `Timed out after ${this.#timeoutMs} ms contacting api.telegram.org`,
        };

      case 'unreachable':
        return {
          kind: 'retriable',
          message: `Could not reach api.telegram.org — ${redact(outcome.reason)}`,
        };

      case 'response':
        return this.#classify(outcome.status, outcome.body, redact);
    }
  }

  #classify(status: number, body: string, redact: (text: string) => string): SendOutcome {
    const parsed = parseJson(body);
    const rawDescription = parsed?.['description'];
    const description = typeof rawDescription === 'string' ? redact(rawDescription) : null;

    if (status === 200 && parsed?.['ok'] === true) {
      const result = asObject(parsed['result']);
      const rawMessageId = result?.['message_id'];
      return { kind: 'sent', messageId: typeof rawMessageId === 'number' ? rawMessageId : null };
    }

    if (status === 429) {
      // `parameters.retry_after` is the only number in the exchange that reflects the real
      // limit. Honour it rather than guessing — the server knows, we do not.
      const retryAfter = asObject(parsed?.['parameters'])?.['retry_after'];
      return {
        kind: 'rate_limited',
        retryAfterSeconds: typeof retryAfter === 'number' ? retryAfter : null,
        message: `Rate limited by Telegram (429)${description === null ? '' : ` — ${description}`}`,
      };
    }

    if (status === 401) {
      return {
        kind: 'terminal',
        message:
          'Bot token rejected by Telegram (401). Re-issue the token with @BotFather and save it ' +
          'in Settings → Integrations → Telegram.',
      };
    }

    if (status === 403) {
      return {
        kind: 'terminal',
        message:
          `Telegram refused the message (403)${description === null ? '' : ` — ${description}`}. ` +
          'The bot was blocked, removed from the chat, or never started by the recipient.',
      };
    }

    if (status === 400) {
      return {
        kind: 'terminal',
        message:
          `Telegram rejected the request (400)${description === null ? '' : ` — ${description}`}. ` +
          'Check the chat ID in Settings → Integrations → Telegram.',
      };
    }

    if (status >= 500) {
      return {
        kind: 'retriable',
        message: `Telegram answered ${status}${description === null ? '' : ` — ${description}`}`,
      };
    }

    // Any other 4xx: the request itself is wrong, and repeating it keeps being wrong.
    return {
      kind: 'terminal',
      message: `Telegram answered ${status}${description === null ? '' : ` — ${description}`}`,
    };
  }
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(body));
  } catch {
    return null;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
