import { MAX_DELIVERY_ATTEMPTS, type PgBossQueue, QUEUE_NAMES } from '@mc/shared';
import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  configureTelegram,
  denyingHttp,
  errorResponse,
  eventsOfType,
  FAKE_BOT_TOKEN,
  jobsOn,
  notificationRow,
  okResponse,
  type RecordingHttp,
  recordingHttp,
  seedNotification,
  seedUser,
  setBotToken,
  setSetting,
  setUnreadableBotToken,
  TEST_CHAT_ID,
  testDatabase,
  testEncryptionKey,
  testQueue,
  truncateAll,
} from '../test/integration/harness.js';
import { DeliveryAbortedError, DeliveryService } from './delivery.js';
import { TelegramClient } from './telegram/client.js';
import type { TelegramHttpPort } from './telegram/http.js';

/**
 * Telegram delivery against a real database and a real pg-boss queue — with a **stubbed**
 * transport (TDS 07 §3).
 *
 * Nothing in this file can reach `api.telegram.org`: the default port throws, and the tests
 * that exercise an outcome pass an explicit recording stub. The one test that omits a stub
 * asserts exactly that refusal.
 */

let queue: PgBossQueue;
let userId: string;

function service(http: TelegramHttpPort, signal?: AbortSignal): DeliveryService {
  return new DeliveryService({
    db: testDatabase().db,
    queue,
    client: new TelegramClient({ http, timeoutMs: 1_000 }),
    encryptionKey: testEncryptionKey(),
    ...(signal === undefined ? {} : { signal }),
  });
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();
  userId = await seedUser();
});

describe('the harness cannot reach the network', () => {
  it('installs a denying transport by default, so a forgotten stub fails loudly here', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    await expect(
      service(denyingHttp()).deliver({ notificationId: id, attempt: 1 }),
    ).rejects.toThrow('Refusing to call the Telegram Bot API');
  });
});

describe('a successful delivery', () => {
  it('sends once, records `sent`, and emits notification.sent', async () => {
    await configureTelegram();
    const id = await seedNotification({
      userId,
      title: 'Session completed — x',
      body: 'Commits: 3',
    });

    const http: RecordingHttp = recordingHttp(okResponse());
    const result = await service(http.port).deliver({ notificationId: id, attempt: 1 });

    expect(result).toEqual({ kind: 'sent', notificationId: id });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.body).toMatchObject({ chat_id: TEST_CHAT_ID, parse_mode: 'HTML' });
    expect(http.requests[0]?.body['text']).toContain('<b>Session completed — x</b>');

    const row = await notificationRow(id);
    expect(row.telegramStatus).toBe('sent');
    expect(row.telegramSentAt).toBeInstanceOf(Date);
    expect(row.telegramError).toBeNull();

    expect(await eventsOfType('notification.sent')).toHaveLength(1);
  });

  it('unseals the token through the real crypto path and puts it in the URL only', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const http = recordingHttp(okResponse());
    await service(http.port).deliver({ notificationId: id, attempt: 1 });

    expect(http.requests[0]?.url).toContain(`/bot${FAKE_BOT_TOKEN}/sendMessage`);
    // …and nowhere else: not in the body, and not in anything persisted.
    expect(JSON.stringify(http.requests[0]?.body)).not.toContain(FAKE_BOT_TOKEN);
  });
});

describe('idempotence — the notification row is the anchor (F6.3)', () => {
  it('a redelivered job sends exactly once', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const http = recordingHttp(okResponse());
    const delivery = service(http.port);

    const first = await delivery.deliver({ notificationId: id, attempt: 1 });
    // pg-boss is at-least-once: the same job comes back.
    const second = await delivery.deliver({ notificationId: id, attempt: 1 });

    expect(first.kind).toBe('sent');
    expect(second).toEqual({ kind: 'already_settled', notificationId: id, status: 'sent' });
    expect(http.requests).toHaveLength(1);
    expect(await eventsOfType('notification.sent')).toHaveLength(1);
  });

  it('does not resurrect a notification that already failed terminally', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId, telegramStatus: 'failed' });

    const http = recordingHttp(okResponse());
    const result = await service(http.port).deliver({ notificationId: id, attempt: 1 });

    expect(result.kind).toBe('already_settled');
    expect(http.requests).toHaveLength(0);
  });

  it('does nothing for a job naming a notification that no longer exists', async () => {
    await configureTelegram();
    const http = recordingHttp(okResponse());

    const result = await service(http.port).deliver({
      notificationId: '019ffa00-0000-7000-8000-000000000000',
      attempt: 1,
    });

    expect(result.kind).toBe('missing');
    expect(http.requests).toHaveLength(0);
  });
});

describe('not configured is a stated state, not a retry loop', () => {
  it('no bot token → skipped, with an actionable reason and no new job', async () => {
    await setSetting('integrations', 'telegram_enabled', true);
    await setSetting('integrations', 'telegram_chat_id', TEST_CHAT_ID);
    const id = await seedNotification({ userId });

    const http = recordingHttp(okResponse());
    const result = await service(http.port).deliver({ notificationId: id, attempt: 1 });

    expect(result.kind).toBe('skipped');
    expect(http.requests).toHaveLength(0);

    const row = await notificationRow(id);
    expect(row.telegramStatus).toBe('skipped');
    expect(row.telegramError).toContain('bot token');
    expect(await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER)).toHaveLength(0);
  });

  it('telegram disabled → skipped', async () => {
    await configureTelegram();
    await setSetting('integrations', 'telegram_enabled', false);
    const id = await seedNotification({ userId });

    const result = await service(recordingHttp(okResponse()).port).deliver({
      notificationId: id,
      attempt: 1,
    });

    expect(result.kind).toBe('skipped');
    expect((await notificationRow(id)).telegramError).toContain('switched off');
  });

  it('no chat id → skipped', async () => {
    await setSetting('integrations', 'telegram_enabled', true);
    await setBotToken();
    const id = await seedNotification({ userId });

    const result = await service(recordingHttp(okResponse()).port).deliver({
      notificationId: id,
      attempt: 1,
    });

    expect(result.kind).toBe('skipped');
    expect((await notificationRow(id)).telegramError).toContain('chat ID');
  });

  it('a token sealed with a different key fails with the restore-scenario message', async () => {
    await setSetting('integrations', 'telegram_enabled', true);
    await setSetting('integrations', 'telegram_chat_id', TEST_CHAT_ID);
    await setUnreadableBotToken();
    const id = await seedNotification({ userId });

    const http = recordingHttp(okResponse());
    const result = await service(http.port).deliver({ notificationId: id, attempt: 1 });

    expect(result.kind).toBe('failed');
    expect(http.requests).toHaveLength(0);

    const row = await notificationRow(id);
    expect(row.telegramStatus).toBe('failed');
    expect(row.telegramError).toContain('MC_ENCRYPTION_KEY');
    // The failure message must carry no ciphertext and no plaintext.
    expect(row.telegramError).not.toContain('whatever');
  });
});

describe('a delivery failure is data', () => {
  it('401 is terminal: recorded, and emits notification.failed', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const http = recordingHttp(errorResponse(401, { ok: false, description: 'Unauthorized' }));
    const result = await service(http.port).deliver({ notificationId: id, attempt: 1 });

    expect(result.kind).toBe('failed');
    const row = await notificationRow(id);
    expect(row.telegramStatus).toBe('failed');
    expect(row.telegramError).toContain('401');

    const failed = await eventsOfType('notification.failed');
    expect(failed).toHaveLength(1);
    expect(payloadOf(failed[0])['channel']).toBe('telegram');

    // Terminal means terminal: no retry job was queued.
    expect(await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER)).toHaveLength(0);
  });

  it('400 chat-not-found is terminal', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const result = await service(
      recordingHttp(errorResponse(400, { ok: false, description: 'Bad Request: chat not found' }))
        .port,
    ).deliver({ notificationId: id, attempt: 1 });

    expect(result.kind).toBe('failed');
    expect((await notificationRow(id)).telegramError).toContain('chat not found');
  });

  it('a network timeout is retried with backoff, and the row says so', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const result = await service(recordingHttp({ kind: 'timeout' }).port).deliver({
      notificationId: id,
      attempt: 1,
    });

    expect(result.kind).toBe('retry_scheduled');
    const row = await notificationRow(id);
    // Still pending — the delivery is not finished, and the row does not pretend otherwise.
    expect(row.telegramStatus).toBe('pending');
    expect(row.telegramError).toContain('attempt 2 of');

    const jobs = await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data['attempt']).toBe(2);
    expect(new Date(jobs[0]?.start_after as unknown as string).getTime()).toBeGreaterThan(
      Date.now() + 1_000,
    );
  });

  it('429 waits exactly as long as Telegram asked', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const result = await service(
      recordingHttp(
        errorResponse(429, {
          ok: false,
          description: 'Too Many Requests: retry after 37',
          parameters: { retry_after: 37 },
        }),
      ).port,
    ).deliver({ notificationId: id, attempt: 1 });

    expect(result).toMatchObject({ kind: 'retry_scheduled', delaySeconds: 37, attempt: 2 });
    expect((await notificationRow(id)).telegramError).toContain('retrying in 37s');

    const jobs = await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER);
    const startAfter = new Date(jobs[0]?.start_after as unknown as string).getTime();
    expect(startAfter).toBeGreaterThan(Date.now() + 30_000);
  });

  it('gives up after the attempt cap instead of retrying forever', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const result = await service(recordingHttp({ kind: 'timeout' }).port).deliver({
      notificationId: id,
      attempt: MAX_DELIVERY_ATTEMPTS,
    });

    expect(result.kind).toBe('failed');
    const row = await notificationRow(id);
    expect(row.telegramStatus).toBe('failed');
    expect(row.telegramError).toContain(`gave up after ${MAX_DELIVERY_ATTEMPTS} attempts`);
    expect(await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER)).toHaveLength(0);
  });

  it('the whole retry chain terminates — it never re-queues past the cap', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const delivery = service(recordingHttp({ kind: 'unreachable', reason: 'ENOTFOUND' }).port);

    let attempt = 1;
    for (let guard = 0; guard < MAX_DELIVERY_ATTEMPTS + 2; guard += 1) {
      const result = await delivery.deliver({ notificationId: id, attempt });
      if (result.kind === 'failed') break;
      expect(result.kind).toBe('retry_scheduled');
      attempt = result.kind === 'retry_scheduled' ? result.attempt : attempt + 1;
    }

    expect((await notificationRow(id)).telegramStatus).toBe('failed');
    expect(attempt).toBe(MAX_DELIVERY_ATTEMPTS);
  });
});

describe('the token never appears in anything persisted', () => {
  it('is absent from telegram_error for every failure mode', async () => {
    await configureTelegram();

    const outcomes = [
      errorResponse(401, { ok: false, description: `bad token ${FAKE_BOT_TOKEN}` }),
      errorResponse(400, { ok: false, description: `chat not found ${FAKE_BOT_TOKEN}` }),
      { kind: 'unreachable' as const, reason: `connect ECONNREFUSED ${FAKE_BOT_TOKEN}` },
    ];

    for (const outcome of outcomes) {
      const id = await seedNotification({ userId });
      await service(recordingHttp(outcome).port).deliver({ notificationId: id, attempt: 1 });

      const row = await notificationRow(id);
      expect(JSON.stringify(row)).not.toContain(FAKE_BOT_TOKEN);
      expect(JSON.stringify(row)).not.toContain('AAF-mission-control-test-token');
    }
  });

  it('is absent from every event this worker enqueues', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    await service(
      recordingHttp(errorResponse(403, { ok: false, description: `blocked ${FAKE_BOT_TOKEN}` }))
        .port,
    ).deliver({ notificationId: id, attempt: 1 });

    // Every job on every queue, not only the ones this test expected to exist.
    const rows = await testDatabase().db.execute<{ data: unknown }>(
      sql`SELECT data FROM pgboss.job`,
    );
    expect(JSON.stringify(rows.rows)).not.toContain(FAKE_BOT_TOKEN);
    expect(JSON.stringify(rows.rows)).not.toContain('AAF-mission-control-test-token');
  });
});

describe('shutdown', () => {
  it('an aborted send throws so the job is re-queued rather than completed', async () => {
    await configureTelegram();
    const id = await seedNotification({ userId });

    const controller = new AbortController();
    controller.abort();

    await expect(
      service(recordingHttp({ kind: 'aborted' }).port, controller.signal).deliver({
        notificationId: id,
        attempt: 1,
      }),
    ).rejects.toBeInstanceOf(DeliveryAbortedError);

    // Nothing was guessed onto the row: it is still deliverable by the next process.
    expect((await notificationRow(id)).telegramStatus).toBe('pending');
  });
});

describe('the startup sweep', () => {
  it('re-queues a notification a previous process left pending', async () => {
    await configureTelegram();
    const id = await seedNotification({
      userId,
      // Older than the one-minute grace window, so its own job is presumed lost.
      createdAt: new Date(Date.now() - 10 * 60_000),
    });

    const swept = await service(denyingHttp()).sweepPending();

    expect(swept).toBe(1);
    const jobs = await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data['notificationId']).toBe(id);
  });

  it('leaves a freshly produced notification to its own in-flight job', async () => {
    await configureTelegram();
    await seedNotification({ userId, createdAt: new Date() });

    expect(await service(denyingHttp()).sweepPending()).toBe(0);
  });

  it('respects a quiet-hours deferral instead of delivering at restart', async () => {
    await configureTelegram();
    const deferredUntil = new Date(Date.now() + 3_600_000);
    await seedNotification({
      userId,
      createdAt: new Date(Date.now() - 10 * 60_000),
      payload: {
        quietHours: {
          deferredUntil: deferredUntil.toISOString(),
          start: '23:00',
          end: '07:30',
          timezone: 'UTC',
        },
      },
    });

    await service(denyingHttp()).sweepPending();

    const jobs = await jobsOn(QUEUE_NAMES.NOTIFICATION_DELIVER);
    expect(jobs).toHaveLength(1);
    // The whole point: a restart during the night must not defeat quiet hours.
    expect(new Date(jobs[0]?.start_after as unknown as string).getTime()).toBeGreaterThan(
      Date.now() + 3_000_000,
    );
  });

  it('ignores rows that are already settled', async () => {
    await configureTelegram();
    const old = new Date(Date.now() - 10 * 60_000);
    await seedNotification({ userId, telegramStatus: 'sent', createdAt: old });
    await seedNotification({ userId, telegramStatus: 'failed', createdAt: old });
    await seedNotification({ userId, telegramStatus: 'skipped', createdAt: old });

    expect(await service(denyingHttp()).sweepPending()).toBe(0);
  });
});

/** The `payload` of an F6 envelope read back off the queue, with the absence made explicit. */
function payloadOf(event: Record<string, unknown> | undefined): Record<string, unknown> {
  if (event === undefined) throw new Error('expected an event, found none');
  const payload = event['payload'];
  if (typeof payload !== 'object' || payload === null) {
    throw new Error(`event carried no payload object: ${JSON.stringify(event)}`);
  }
  return payload as Record<string, unknown>;
}
