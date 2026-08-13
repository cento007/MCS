import { describe, expect, it, vi } from 'vitest';
import { TelegramClient } from './client.js';
import {
  createDenyingTelegramHttp,
  createTelegramHttpPort,
  describeFailure,
  type TelegramHttpOutcome,
  type TelegramHttpPort,
  type TelegramHttpRequest,
} from './http.js';

/**
 * Every delivery outcome, driven through the injected port.
 *
 * **No test in this file can reach the network.** The port is a stub; the one case that
 * constructs the real transport asserts that `fetch` is never called because the deny-port is
 * in front of it. The prior incident this guards against is an override accepted at a call
 * site and never forwarded to the module, so the *real* port got constructed and the suite
 * quietly talked to a live API.
 */

// A shape that looks like a bot token so redaction has something realistic to remove.
const BOT_TOKEN = '8123456789:AAF-not-a-real-token-000000000000000';
const CHAT_ID = '-1001234567890';

interface Recorded {
  readonly requests: TelegramHttpRequest[];
  readonly port: TelegramHttpPort;
}

function stubPort(...outcomes: readonly TelegramHttpOutcome[]): Recorded {
  const requests: TelegramHttpRequest[] = [];
  let index = 0;

  return {
    requests,
    port: async (request) => {
      requests.push(request);
      const outcome = outcomes[Math.min(index, outcomes.length - 1)];
      index += 1;
      if (outcome === undefined) throw new Error('stub port ran out of outcomes');
      return outcome;
    },
  };
}

function ok(body: unknown = { ok: true, result: { message_id: 42 } }): TelegramHttpOutcome {
  return { kind: 'response', status: 200, body: JSON.stringify(body) };
}

function response(status: number, body: unknown): TelegramHttpOutcome {
  return { kind: 'response', status, body: JSON.stringify(body) };
}

function send(port: TelegramHttpPort, signal?: AbortSignal) {
  return new TelegramClient({ http: port, timeoutMs: 1_000 }).sendMessage({
    botToken: BOT_TOKEN,
    chatId: CHAT_ID,
    text: '<b>Session completed</b>',
    signal,
  });
}

describe('the injected port is the only way out', () => {
  it('makes exactly one request per send', async () => {
    const { port, requests } = stubPort(ok());

    await send(port);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain('/sendMessage');
    expect(requests[0]?.body).toMatchObject({
      chat_id: CHAT_ID,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  });

  it('bounds every request with a wall-clock timeout', async () => {
    const { port, requests } = stubPort(ok());

    await send(port);

    expect(requests[0]?.timeoutMs).toBe(1_000);
  });

  it('hands the port the token to redact with, not just in the URL', async () => {
    const { port, requests } = stubPort(ok());

    await send(port);

    expect(requests[0]?.secret).toBe(BOT_TOKEN);
  });

  it('the deny port refuses rather than reaching api.telegram.org', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const denying = createDenyingTelegramHttp('this test');

    await expect(
      new TelegramClient({ http: denying }).sendMessage({
        botToken: BOT_TOKEN,
        chatId: CHAT_ID,
        text: 'x',
      }),
    ).rejects.toThrow('Refusing to call the Telegram Bot API');

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('the real port exists and is not what any test here uses', () => {
    // Constructing it must not perform I/O — the request does, and no test makes one.
    expect(typeof createTelegramHttpPort()).toBe('function');
  });
});

describe('success', () => {
  it('reports the message id Telegram assigned', async () => {
    const outcome = await send(stubPort(ok()).port);
    expect(outcome).toEqual({ kind: 'sent', messageId: 42 });
  });

  it('accepts a 200 with no message id rather than calling it a failure', async () => {
    const outcome = await send(stubPort(ok({ ok: true, result: {} })).port);
    expect(outcome).toEqual({ kind: 'sent', messageId: null });
  });

  it('treats a 200 that is not `ok: true` as a terminal failure, not a success', async () => {
    const outcome = await send(
      stubPort(response(200, { ok: false, description: 'Bad Request: chat not found' })).port,
    );
    expect(outcome.kind).toBe('terminal');
  });
});

describe('terminal failures — recorded, never retried', () => {
  it('401: a revoked or wrong bot token', async () => {
    const outcome = await send(
      stubPort(response(401, { ok: false, description: 'Unauthorized' })).port,
    );

    expect(outcome.kind).toBe('terminal');
    expect(outcome.kind === 'terminal' && outcome.message).toContain('401');
    expect(outcome.kind === 'terminal' && outcome.message).toContain('@BotFather');
  });

  it('400: a chat id that does not exist', async () => {
    const outcome = await send(
      stubPort(response(400, { ok: false, description: 'Bad Request: chat not found' })).port,
    );

    expect(outcome.kind).toBe('terminal');
    expect(outcome.kind === 'terminal' && outcome.message).toContain('chat not found');
    expect(outcome.kind === 'terminal' && outcome.message).toContain('chat ID in Settings');
  });

  it('403: the bot was blocked or removed from the chat', async () => {
    const outcome = await send(
      stubPort(response(403, { ok: false, description: 'Forbidden: bot was blocked by the user' }))
        .port,
    );

    expect(outcome.kind).toBe('terminal');
    expect(outcome.kind === 'terminal' && outcome.message).toContain('blocked');
  });

  it('any other 4xx: repeating a wrong request keeps being wrong', async () => {
    const outcome = await send(stubPort(response(404, { ok: false })).port);
    expect(outcome.kind).toBe('terminal');
  });
});

describe('retriable failures', () => {
  it('429 carries Telegram’s own retry_after', async () => {
    const outcome = await send(
      stubPort(
        response(429, {
          ok: false,
          description: 'Too Many Requests: retry after 30',
          parameters: { retry_after: 30 },
        }),
      ).port,
    );

    expect(outcome).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: 30 });
    expect(outcome.kind === 'rate_limited' && outcome.message).toContain('429');
  });

  it('429 without parameters still classifies as rate limited', async () => {
    const outcome = await send(stubPort(response(429, { ok: false })).port);
    expect(outcome).toMatchObject({ kind: 'rate_limited', retryAfterSeconds: null });
  });

  it('5xx is Telegram having a bad day, not our request being wrong', async () => {
    const outcome = await send(stubPort(response(502, { ok: false })).port);
    expect(outcome.kind).toBe('retriable');
  });

  it('a timeout is retriable and names the bound it hit', async () => {
    const outcome = await send(stubPort({ kind: 'timeout' }).port);

    expect(outcome.kind).toBe('retriable');
    expect(outcome.kind === 'retriable' && outcome.message).toContain('1000 ms');
  });

  it('an unreachable network is retriable', async () => {
    const outcome = await send(stubPort({ kind: 'unreachable', reason: 'ENOTFOUND' }).port);

    expect(outcome.kind).toBe('retriable');
    expect(outcome.kind === 'retriable' && outcome.message).toContain('ENOTFOUND');
  });
});

describe('shutdown', () => {
  it('reports an aborted request as `aborted`, never as a failure of the message', async () => {
    const outcome = await send(stubPort({ kind: 'aborted' }).port);
    expect(outcome).toEqual({ kind: 'aborted' });
  });

  it('passes the caller’s signal through to the transport', async () => {
    const controller = new AbortController();
    const { port, requests } = stubPort(ok());

    await send(port, controller.signal);

    expect(requests[0]?.signal).toBe(controller.signal);
  });
});

describe('the token never survives into an operator-facing string', () => {
  const cases: readonly { name: string; outcome: TelegramHttpOutcome }[] = [
    { name: 'unreachable', outcome: { kind: 'unreachable', reason: `POST /bot${BOT_TOKEN}/x` } },
    {
      name: '400 description',
      outcome: response(400, { ok: false, description: `bad token ${BOT_TOKEN}` }),
    },
    {
      name: '429 description',
      outcome: response(429, { ok: false, description: `slow down ${BOT_TOKEN}` }),
    },
    { name: '502 description', outcome: response(502, { ok: false, description: BOT_TOKEN }) },
    { name: '404 description', outcome: response(404, { ok: false, description: BOT_TOKEN }) },
  ];

  it.each(cases)('$name is redacted', async ({ outcome }) => {
    const result = await send(stubPort(outcome).port);
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain(BOT_TOKEN);
    // The distinctive middle of the token, in case a prefix ever survives on its own.
    expect(serialized).not.toContain('AAF-not-a-real-token');
    expect(serialized).toContain('«redacted»');
  });

  it('describeFailure scrubs a token quoted by a transport error', () => {
    const described = describeFailure(
      new Error(`fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`),
      BOT_TOKEN,
    );

    expect(described).not.toContain(BOT_TOKEN);
    expect(described).toContain('«redacted»');
  });

  it('describeFailure flattens and caps, so a stack never becomes a telegram_error', () => {
    const described = describeFailure(new Error(`a\n b   c ${'x'.repeat(500)}`));
    expect(described.length).toBeLessThanOrEqual(300);
    expect(described).not.toContain('\n');
  });
});
