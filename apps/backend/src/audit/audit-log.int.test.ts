import { newId, type PgBossQueue, schema } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import type { AuditLogEntryResource } from './query.js';

/**
 * `GET /api/v1/audit-log-entries` end to end (TDS 04 §12) — the "View audit log →" target.
 *
 * The two properties worth a real database: **cursor pagination across rows that share a
 * timestamp** (one settings save writes several entries inside one transaction, so this is the
 * normal case here) and the filters, which are the whole reason the endpoint is useful.
 */

let queue: PgBossQueue;
let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;

interface Page {
  readonly data: readonly AuditLogEntryResource[];
  readonly meta: { readonly nextCursor: string | null; readonly limit: number };
}

function auth(): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
}

async function list(query = ''): Promise<Page> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/audit-log-entries${query}`,
    headers: auth(),
  });
  expect(response.statusCode).toBe(200);
  return response.json<Page>();
}

/** Rows written directly: the writer has its own coverage, and this suite is about reading. */
async function seedEntry(input: {
  action: string;
  createdAt: Date;
  actorType?: 'user' | 'system';
  entityType?: string;
  entityId?: string;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.auditLogEntries)
    .values({
      id,
      actorType: input.actorType ?? 'user',
      actorId: input.actorType === 'system' ? null : userId,
      action: input.action,
      entityType: input.entityType ?? 'settings',
      entityId: input.entityId ?? null,
      after: { note: 'seeded' },
      requestId: 'req-seeded',
      createdAt: input.createdAt,
    });
  return id;
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

describe('contract (§12)', () => {
  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/audit-log-entries' });
    expect(response.statusCode).toBe(401);
  });

  it('serves the §12 field set and nothing else', async () => {
    const page = await list('?action=auth.login');
    const entry = page.data[0];

    expect(entry).toBeDefined();
    expect(Object.keys(entry as object).sort()).toEqual(
      [
        'action',
        'actorId',
        'actorType',
        'after',
        'before',
        'entityId',
        'entityType',
        'id',
        'occurredAt',
        'requestId',
      ].sort(),
    );
    // `ip_address` is stored (TDS 03 §3.14) and deliberately not part of the §12 resource.
    expect(entry as object).not.toHaveProperty('ipAddress');
  });

  it('records the login this suite performed, newest first', async () => {
    const page = await list();

    expect(page.data[0]?.action).toBe('auth.login');
    expect(page.data[0]?.actorId).toBe(userId);
  });

  it('fetches a single entry and 404s an id that is not there', async () => {
    const id = await seedEntry({ action: 'setting.updated', createdAt: new Date() });

    const found = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log-entries/${id}`,
      headers: auth(),
    });
    const missing = await app.inject({
      method: 'GET',
      url: `/api/v1/audit-log-entries/${newId()}`,
      headers: auth(),
    });

    expect(found.statusCode).toBe(200);
    expect(found.json<{ data: AuditLogEntryResource }>().data.id).toBe(id);
    expect(missing.statusCode).toBe(404);
  });
});

describe('cursor pagination (F5.3)', () => {
  it('walks every row exactly once, including rows sharing a timestamp', async () => {
    // One settings save writes `setting.updated` plus a `secret_item.updated` per secret, in
    // one transaction — so a shared millisecond is the normal case, not a contrived one.
    const shared = new Date('2026-08-13T07:00:00.000Z');
    for (let index = 0; index < 4; index += 1) {
      await seedEntry({ action: 'setting.updated', createdAt: shared });
    }
    for (let index = 0; index < 3; index += 1) {
      await seedEntry({
        action: 'secret_item.updated',
        createdAt: new Date(shared.getTime() + index * 1000),
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query: string = `?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`;
      const result: Page = await list(query);
      seen.push(...result.data.map((entry) => entry.id));
      cursor = result.meta.nextCursor;
      if (cursor === null) break;
    }

    // 7 seeded + 1 login + 1 bootstrap from `seedUser`.
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBe(9);
  });

  it('orders newest first and stops with a null cursor', async () => {
    const oldest = await seedEntry({
      action: 'setting.updated',
      createdAt: new Date('2020-01-01T00:00:00.000Z'),
    });

    const page = await list('?limit=200');

    expect(page.meta.nextCursor).toBeNull();
    expect(page.data[page.data.length - 1]?.id).toBe(oldest);
  });

  it('rejects a cursor that is not one of ours', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log-entries?cursor=not-a-cursor',
      headers: auth(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('INVALID_CURSOR');
  });
});

describe('filters (§12)', () => {
  beforeEach(async () => {
    await seedEntry({
      action: 'setting.updated',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    });
    await seedEntry({
      action: 'secret_item.updated',
      createdAt: new Date('2026-08-05T10:00:00.000Z'),
      entityType: 'secret_items',
    });
    await seedEntry({
      action: 'session.archived',
      createdAt: new Date('2026-08-09T10:00:00.000Z'),
      actorType: 'system',
      entityType: 'sessions',
    });
  });

  it('filters by action, actorType and entityType', async () => {
    expect((await list('?action=setting.updated')).data).toHaveLength(1);
    expect((await list('?entityType=secret_items')).data).toHaveLength(1);

    // `system` also covers the account bootstrap `seedUser` performed — asserted by action
    // rather than by count so this does not depend on how the suite created its user.
    const bySystem = await list('?actorType=system');
    expect(bySystem.data.map((entry) => entry.action)).toContain('session.archived');
    expect(bySystem.data.every((entry) => entry.actorId === null)).toBe(true);
  });

  it('filters by an inclusive time window', async () => {
    const page = await list('?from=2026-08-01T00:00:00.000Z&to=2026-08-05T23:59:59.000Z');

    expect(page.data.map((entry) => entry.action).sort()).toEqual([
      'secret_item.updated',
      'setting.updated',
    ]);
  });

  it('refuses an unparseable window rather than silently widening it', async () => {
    // Failing open here would answer a narrow question with every row in the table, which is
    // the one direction an audit filter must never fail in.
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log-entries?from=lastTuesday',
      headers: auth(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects a filter value the schema does not admit', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/audit-log-entries?actorType=robot',
      headers: auth(),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });
});
