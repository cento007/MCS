import { QUEUE_NAMES, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedAdr,
  seedProject,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';

/**
 * `/api/v1/adrs` and `POST /sessions/{id}/generate-adr` — TDS 04 §9, against a real database.
 */

let app: TestApp;
let cookie: string;
let projectId: string;
let userId: string;

beforeEach(async () => {
  await truncateAll();

  const queue = await testQueue();
  app = createTestApp({ queue });

  const user = await seedUser();
  userId = user.id;

  const login = await app.app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = `${SESSION_COOKIE_NAME}=${cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME)}`;

  ({ projectId } = await seedProject());
});

async function post(url: string, body: Record<string, unknown> = {}) {
  return app.app.inject({ method: 'POST', url, headers: { cookie }, payload: body });
}

describe('POST /api/v1/adrs', () => {
  it('creates a `proposed` ADR numbered from 1 within its project', async () => {
    const response = await post('/api/v1/adrs', {
      projectId,
      title: 'Use pg-boss for the job queue',
      context: 'Redis has no native Windows build.',
      decision: 'PostgreSQL is the single stateful substrate.',
    });

    expect(response.statusCode).toBe(201);
    const created = response.json().data;

    expect(created).toMatchObject({
      projectId,
      adrNumber: 1,
      title: 'Use pg-boss for the job queue',
      status: 'proposed',
      alternatives: '',
      supersededByAdrId: null,
      sourceSessionId: null,
      obsidianPath: null,
      syncedAt: null,
    });
  });

  it('numbers per project, not globally', async () => {
    const other = await seedProject('Other project');

    await post('/api/v1/adrs', { projectId, title: 'First here' });
    await post('/api/v1/adrs', { projectId, title: 'Second here' });
    const elsewhere = await post('/api/v1/adrs', {
      projectId: other.projectId,
      title: 'First there',
    });

    expect(elsewhere.json().data.adrNumber).toBe(1);
  });

  it('refuses `draft` — there is no such status (§9, A4)', async () => {
    const response = await post('/api/v1/adrs', { projectId, title: 'x', status: 'draft' });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('refuses an unknown project', async () => {
    const response = await post('/api/v1/adrs', {
      projectId: '0199a3f1-9999-7a10-9f01-3d4e5f607182',
      title: 'x',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.details.field).toBe('projectId');
  });

  it('emits `adr.created` on the events queue, in the same transaction as the row', async () => {
    const response = await post('/api/v1/adrs', { projectId, title: 'Queue decision' });
    const adrId = response.json().data.id;

    const jobs = await testDatabase().db.execute<{ data: { type: string; payload: unknown } }>(
      `SELECT data FROM pgboss.job WHERE name = '${QUEUE_NAMES.EVENTS}'`,
    );

    const created = jobs.rows.map((row) => row.data).filter((data) => data.type === 'adr.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toMatchObject({ adrId, projectId, sourceSessionId: null });
  });

  it('writes an audit row', async () => {
    const response = await post('/api/v1/adrs', { projectId, title: 'Audited' });

    const rows = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, response.json().data.id));

    expect(rows[0]).toMatchObject({ action: 'adr.created', actorType: 'user', actorId: userId });
  });
});

describe('GET /api/v1/adrs', () => {
  it('lists with `?projectId=` and `?status=` filters', async () => {
    const other = await seedProject('Other');
    await seedAdr({ projectId, title: 'A', status: 'accepted' });
    await seedAdr({ projectId, title: 'B', status: 'proposed' });
    await seedAdr({ projectId: other.projectId, title: 'C' });

    const byProject = await app.app.inject({
      method: 'GET',
      url: `/api/v1/adrs?projectId=${projectId}`,
      headers: { cookie },
    });
    expect(byProject.json().data).toHaveLength(2);

    const byStatus = await app.app.inject({
      method: 'GET',
      url: `/api/v1/adrs?projectId=${projectId}&status=accepted`,
      headers: { cookie },
    });
    expect(byStatus.json().data.map((row: { title: string }) => row.title)).toEqual(['A']);
  });

  it('rejects a status the schema does not know', async () => {
    const response = await app.app.inject({
      method: 'GET',
      url: '/api/v1/adrs?status=draft',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('PATCH /api/v1/adrs/{id}', () => {
  it('edits the template sections', async () => {
    const { id } = await seedAdr({ projectId });

    const response = await app.app.inject({
      method: 'PATCH',
      url: `/api/v1/adrs/${id}`,
      headers: { cookie },
      payload: { alternatives: 'Memurai on Windows.' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.alternatives).toBe('Memurai on Windows.');
  });

  it('supersede sets the status as well as the pointer', async () => {
    const older = await seedAdr({ projectId, title: 'Older', status: 'accepted' });
    const newer = await seedAdr({ projectId, title: 'Newer' });

    const response = await app.app.inject({
      method: 'PATCH',
      url: `/api/v1/adrs/${older.id}`,
      headers: { cookie },
      payload: { supersededByAdrId: newer.id },
    });

    expect(response.json().data).toMatchObject({
      status: 'superseded',
      supersededByAdrId: newer.id,
    });
  });

  it('refuses an ADR that supersedes itself', async () => {
    const { id } = await seedAdr({ projectId });

    const response = await app.app.inject({
      method: 'PATCH',
      url: `/api/v1/adrs/${id}`,
      headers: { cookie },
      payload: { supersededByAdrId: id },
    });

    expect(response.statusCode).toBe(400);
  });

  it('emits `adr.updated` naming only the fields that changed', async () => {
    const { id } = await seedAdr({ projectId });

    await app.app.inject({
      method: 'PATCH',
      url: `/api/v1/adrs/${id}`,
      headers: { cookie },
      payload: { status: 'accepted' },
    });

    const jobs = await testDatabase().db.execute<{
      data: { type: string; payload: { changedFields?: string[] } };
    }>(`SELECT data FROM pgboss.job WHERE name = '${QUEUE_NAMES.EVENTS}'`);

    const updated = jobs.rows.map((row) => row.data).find((data) => data.type === 'adr.updated');
    expect(updated?.payload.changedFields).toEqual(['status']);
  });

  it('404s for an unknown id', async () => {
    const response = await app.app.inject({
      method: 'PATCH',
      url: '/api/v1/adrs/0199a3f1-9999-7a10-9f01-3d4e5f607182',
      headers: { cookie },
      payload: { title: 'x' },
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('POST /api/v1/sessions/{id}/generate-adr', () => {
  it('answers 202 with the queue job id and enqueues the drafting job', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });

    const response = await post(`/api/v1/sessions/${sessionId}/generate-adr`);

    expect(response.statusCode).toBe(202);
    const { jobId } = response.json().data;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    const jobs = await testDatabase().db.execute<{ id: string; data: { sessionId: string } }>(
      `SELECT id, data FROM pgboss.job WHERE name = '${QUEUE_NAMES.ADR_GENERATE}'`,
    );

    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.id).toBe(jobId);
    expect(jobs.rows[0]?.data.sessionId).toBe(sessionId);
  });

  it('refuses a session that has not run — there is nothing to draft from', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    const response = await post(`/api/v1/sessions/${sessionId}/generate-adr`);

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFLICT');
  });

  it('404s for an unknown session', async () => {
    const response = await post(
      '/api/v1/sessions/0199a3f1-9999-7a10-9f01-3d4e5f607182/generate-adr',
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('authentication', () => {
  it('refuses every ADR route without a session cookie', async () => {
    const { id } = await seedAdr({ projectId });

    for (const [method, url] of [
      ['GET', '/api/v1/adrs'],
      ['POST', '/api/v1/adrs'],
      ['GET', `/api/v1/adrs/${id}`],
      ['PATCH', `/api/v1/adrs/${id}`],
    ] as const) {
      const response = await app.app.inject({ method, url, payload: {} });
      expect(response.statusCode).toBe(401);
    }
  });
});
