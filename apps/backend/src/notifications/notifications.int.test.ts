import { newId, type PgBossQueue } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedNotification,
  seedUser,
  type TestApp,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import type { NotificationResource } from './serialize.js';

/**
 * `/api/v1/notifications/*` end to end (TDS 04 §8) — through the real Fastify app and a real
 * database (WS6 §11.2: happy path + error envelope + auth for every WS2 Phase-1 endpoint).
 *
 * Rows are seeded directly because creation is **system-only** (§8): its producers are the
 * Backend's threshold evaluation and the Telegram Worker, both Phase 2. The read/acknowledge
 * surface is Phase 1 because the Dashboard widget and the unread badge call it on day one.
 */

let queue: PgBossQueue;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;

type InjectedResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function request(method: 'GET' | 'POST', url: string): Promise<InjectedResponse> {
  return app.inject({ method, url, headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` } });
}

async function list(query = ''): Promise<{
  data: NotificationResource[];
  meta: { nextCursor: string | null; limit: number };
}> {
  const response = await request('GET', `/api/v1/notifications${query}`);
  expect(response.statusCode).toBe(200);
  return response.json();
}

beforeEach(async () => {
  await truncateAll();
  queue = await testQueue();

  const user = await seedUser();
  userId = user.id;

  built = createTestApp({ queue, cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

afterEach(async () => {
  await built?.sessions.registry.stop();
  await built?.app.close();
});

describe('auth (TDS 04 §1.4)', () => {
  it('rejects every notification route without a credential', async () => {
    const id = await seedNotification({ userId });

    for (const [method, url] of [
      ['GET', '/api/v1/notifications'],
      ['GET', `/api/v1/notifications/${id}`],
      ['POST', `/api/v1/notifications/${id}/read`],
      ['POST', '/api/v1/notifications/read-all'],
    ] as const) {
      const response = await app.inject({ method, url });
      expect(response.statusCode).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('GET /notifications', () => {
  it('returns an empty list with the F5.3 envelope before any producer exists', async () => {
    const body = await list();

    expect(body.data).toEqual([]);
    expect(body.meta).toEqual({ nextCursor: null, limit: 50 });
  });

  it('returns newest first', async () => {
    const oldest = await seedNotification({
      userId,
      title: 'oldest',
      createdAt: new Date('2026-08-12T09:00:00.000Z'),
    });
    const newest = await seedNotification({
      userId,
      title: 'newest',
      createdAt: new Date('2026-08-12T11:00:00.000Z'),
    });
    const middle = await seedNotification({
      userId,
      title: 'middle',
      createdAt: new Date('2026-08-12T10:00:00.000Z'),
    });

    const body = await list();

    expect(body.data.map((row) => row.id)).toEqual([newest, middle, oldest]);
  });

  it('renders the §8 shape, including the flat telegram object (WS7 N5)', async () => {
    await seedNotification({
      userId,
      type: 'session_failed',
      severity: 'error',
      title: 'Session failed',
      body: 'Fix nginx TLS renewal crashed.',
      payload: { eventType: 'session.failed', sessionId: newId() },
      correlationId: newId(),
      telegramStatus: 'sent',
      telegramSentAt: new Date('2026-08-12T14:03:24.000Z'),
    });

    const [notification] = (await list()).data;

    expect(Object.keys(notification as NotificationResource).sort()).toEqual([
      'body',
      'correlationId',
      'createdAt',
      'id',
      'payload',
      'readAt',
      'severity',
      'telegram',
      'title',
      'type',
    ]);
    // `type` is the notification-type enum; the F6 event name lives in the payload (A8).
    expect(notification?.type).toBe('session_failed');
    expect(notification?.payload?.['eventType']).toBe('session.failed');
    expect(notification?.telegram).toEqual({
      status: 'sent',
      sentAt: '2026-08-12T14:03:24.000Z',
      error: null,
    });
  });

  it('reports a Telegram failure verbatim without hiding the notification', async () => {
    await seedNotification({
      userId,
      telegramStatus: 'failed',
      telegramError: 'chat not found',
    });

    const [notification] = (await list()).data;
    expect(notification?.telegram.status).toBe('failed');
    expect(notification?.telegram.error).toBe('chat not found');
  });

  it('filters to unread with ?unread=true', async () => {
    const unread = await seedNotification({ userId, title: 'unread' });
    await seedNotification({ userId, title: 'read', readAt: new Date() });

    const all = await list();
    const onlyUnread = await list('?unread=true');

    expect(all.data).toHaveLength(2);
    expect(onlyUnread.data.map((row) => row.id)).toEqual([unread]);
  });

  it('paginates with an opaque cursor and stops with nextCursor: null', async () => {
    for (let index = 0; index < 5; index += 1) {
      await seedNotification({
        userId,
        title: `n${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 12, 9, index)),
      });
    }

    const first = await list('?limit=2');
    expect(first.data.map((row) => row.title)).toEqual(['n4', 'n3']);
    expect(first.meta.nextCursor).toBeTruthy();

    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor ?? '')}`);
    expect(second.data.map((row) => row.title)).toEqual(['n2', 'n1']);

    const third = await list(`?limit=2&cursor=${encodeURIComponent(second.meta.nextCursor ?? '')}`);
    expect(third.data.map((row) => row.title)).toEqual(['n0']);
    expect(third.meta.nextCursor).toBeNull();
  });

  it('keeps the unread filter across pages', async () => {
    for (let index = 0; index < 4; index += 1) {
      await seedNotification({
        userId,
        title: `u${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 12, 9, index)),
        ...(index % 2 === 0 ? { readAt: new Date() } : {}),
      });
    }

    const first = await list('?unread=true&limit=1');
    expect(first.data.map((row) => row.title)).toEqual(['u3']);

    const second = await list(
      `?unread=true&limit=1&cursor=${encodeURIComponent(first.meta.nextCursor ?? '')}`,
    );
    expect(second.data.map((row) => row.title)).toEqual(['u1']);
  });

  it('separates notifications sharing a created_at by the id tiebreak', async () => {
    const sameInstant = new Date('2026-08-12T09:00:00.000Z');
    for (let index = 0; index < 3; index += 1) {
      await seedNotification({ userId, title: `t${index}`, createdAt: sameInstant });
    }

    const first = await list('?limit=2');
    const second = await list(`?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor ?? '')}`);

    const seen = [...first.data, ...second.data].map((row) => row.id);
    expect(new Set(seen).size).toBe(3);
  });

  it('rejects a malformed cursor with INVALID_CURSOR', async () => {
    const response = await request('GET', '/api/v1/notifications?cursor=%21%21not-a-cursor');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_CURSOR');
  });
});

describe('GET /notifications/{id}', () => {
  it('fetches one', async () => {
    const id = await seedNotification({ userId, title: 'Session completed' });

    const response = await request('GET', `/api/v1/notifications/${id}`);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: NotificationResource }>().data.title).toBe('Session completed');
  });

  it('answers NOT_FOUND for an unknown id', async () => {
    const response = await request('GET', `/api/v1/notifications/${newId()}`);

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('answers VALIDATION_FAILED for a non-uuid id', async () => {
    const response = await request('GET', '/api/v1/notifications/not-a-uuid');

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('POST /notifications/{id}/read — idempotent (§8)', () => {
  it('marks an unread notification read and returns it', async () => {
    const id = await seedNotification({ userId });

    const response = await request('POST', `/api/v1/notifications/${id}/read`);

    expect(response.statusCode).toBe(200);
    const notification = response.json<{ data: NotificationResource }>().data;
    expect(notification.id).toBe(id);
    expect(notification.readAt).not.toBeNull();
  });

  it('is idempotent — a second call neither fails nor moves readAt', async () => {
    const id = await seedNotification({ userId });

    const first = await request('POST', `/api/v1/notifications/${id}/read`);
    const second = await request('POST', `/api/v1/notifications/${id}/read`);
    const third = await request('POST', `/api/v1/notifications/${id}/read`);

    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);

    const readAt = first.json<{ data: NotificationResource }>().data.readAt;
    // `readAt` records when the operator FIRST saw it; a double-click must not rewrite that.
    expect(second.json<{ data: NotificationResource }>().data.readAt).toBe(readAt);
    expect(third.json<{ data: NotificationResource }>().data.readAt).toBe(readAt);
  });

  it('drops the notification out of the unread filter', async () => {
    const id = await seedNotification({ userId });
    expect((await list('?unread=true')).data).toHaveLength(1);

    await request('POST', `/api/v1/notifications/${id}/read`);

    expect((await list('?unread=true')).data).toHaveLength(0);
    expect((await list()).data).toHaveLength(1);
  });

  it('answers NOT_FOUND for an unknown id instead of pretending to succeed', async () => {
    const response = await request('POST', `/api/v1/notifications/${newId()}/read`);

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });
});

describe('POST /notifications/read-all', () => {
  it('returns how many rows it changed', async () => {
    await seedNotification({ userId });
    await seedNotification({ userId });
    await seedNotification({ userId, readAt: new Date() });

    const response = await request('POST', '/api/v1/notifications/read-all');

    expect(response.statusCode).toBe(200);
    // Only the two that were actually unread.
    expect(response.json<{ data: { updated: number } }>().data.updated).toBe(2);
    expect((await list('?unread=true')).data).toHaveLength(0);
  });

  it('is idempotent — a second call reports 0 updated, not an error', async () => {
    await seedNotification({ userId });

    await request('POST', '/api/v1/notifications/read-all');
    const second = await request('POST', '/api/v1/notifications/read-all');

    expect(second.statusCode).toBe(200);
    expect(second.json<{ data: { updated: number } }>().data.updated).toBe(0);
  });

  it('reports 0 on an empty inbox', async () => {
    const response = await request('POST', '/api/v1/notifications/read-all');

    expect(response.json<{ data: { updated: number } }>().data.updated).toBe(0);
  });
});

describe('creation is system-only (§8)', () => {
  it('exposes no create endpoint', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
      payload: { type: 'session_completed', title: 'nope' },
    });

    expect(response.statusCode).toBe(404);
  });
});
