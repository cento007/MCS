import { newId, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedRepository,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';

/**
 * `/api/v1/projects/*` end to end — TDS 04 §4, through the real Fastify app and a real
 * database. WS6 §11.2: "every WS2 Phase-1 endpoint has integration coverage (happy + error
 * envelope + auth)".
 */

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;

interface ProjectBody {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  workflowMode: 'manual' | 'assisted' | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

interface ErrorBody {
  error: { code: string; message: string; details: unknown; requestId: string };
}

type InjectedResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<InjectedResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function createProject(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: ProjectBody }> {
  const response = await request('POST', '/api/v1/projects', payload);
  return { status: response.statusCode, body: response.json<{ data: ProjectBody }>().data };
}

beforeEach(async () => {
  await truncateAll();

  const user = await seedUser();
  userId = user.id;

  built = createTestApp({ cookieSecure: false });
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

describe('auth (TDS 04 §1.4 — authenticated by default)', () => {
  it('rejects every project route without a credential', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/projects'],
      ['POST', '/api/v1/projects'],
      ['GET', `/api/v1/projects/${newId()}`],
      ['PATCH', `/api/v1/projects/${newId()}`],
      ['DELETE', `/api/v1/projects/${newId()}`],
    ] as const) {
      const response = await app.inject({ method, url });

      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('POST /api/v1/projects', () => {
  it('creates a Project and seeds the single default Workspace on first use', async () => {
    const { status, body } = await createProject({ name: 'Mission Control' });

    expect(status).toBe(201);
    expect(body.name).toBe('Mission Control');
    expect(body.description).toBeNull();
    // §4: `null` = inherit the global GitHub workflow mode.
    expect(body.workflowMode).toBeNull();
    expect(body.archivedAt).toBeNull();
    expect(body.createdAt).toMatch(/Z$/);

    const workspaces = await testDatabase().db.select().from(schema.workspaces);
    expect(workspaces).toHaveLength(1);
    expect(body.workspaceId).toBe(workspaces[0]?.id);
  });

  it('reuses the existing Workspace rather than creating a second one', async () => {
    await createProject({ name: 'First' });
    const second = await createProject({ name: 'Second' });

    const workspaces = await testDatabase().db.select().from(schema.workspaces);
    expect(workspaces).toHaveLength(1);
    expect(second.body.workspaceId).toBe(workspaces[0]?.id);
  });

  it('stores an explicit workflowMode override', async () => {
    const { body } = await createProject({ name: 'Assisted', workflowMode: 'assisted' });

    expect(body.workflowMode).toBe('assisted');

    const row = await testDatabase()
      .db.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, body.id));
    expect(row[0]?.workflowMode).toBe('assisted');
  });

  it('writes an audit row for the creation (TDS 03 §3.14)', async () => {
    const { body } = await createProject({ name: 'Audited' });

    const entries = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, body.id));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('project.created');
    expect(entries[0]?.entityType).toBe('projects');
    expect(entries[0]?.actorId).toBe(userId);
  });

  it('rejects a duplicate name in the same Workspace with the F5.4 envelope', async () => {
    await createProject({ name: 'Mission Control' });

    // The unique index is on `lower(name)`, so case is not a way around it.
    const response = await request('POST', '/api/v1/projects', { name: 'mission control' });

    expect(response.statusCode).toBe(409);
    const body = response.json<ErrorBody>();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('rejects a missing, empty or unknown-mode body with VALIDATION_FAILED', async () => {
    for (const payload of [
      {},
      { name: '' },
      { name: 'x'.repeat(201) },
      { name: 'Valid', workflowMode: 'automatic' },
      // Note: an *unknown* property is not in this list. Fastify's default ajv configuration
      // is `removeAdditional: true`, so `additionalProperties: false` strips the field rather
      // than rejecting the request — the same behaviour every other route in this Backend has.
    ]) {
      const response = await request('POST', '/api/v1/projects', payload);

      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('rejects a whitespace-only name that passed the schema', async () => {
    const response = await request('POST', '/api/v1/projects', { name: '   ' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details).toMatchObject({ field: 'name' });
  });
});

describe('GET /api/v1/projects/{id}', () => {
  it('fetches a Project', async () => {
    const created = await createProject({ name: 'Fetchable' });

    const response = await request('GET', `/api/v1/projects/${created.body.id}`);

    expect(response.statusCode).toBe(200);
    expect(response.json<{ data: ProjectBody }>().data.id).toBe(created.body.id);
  });

  it('answers NOT_FOUND for an unknown id and VALIDATION_FAILED for a non-uuid', async () => {
    const missing = await request('GET', `/api/v1/projects/${newId()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json<ErrorBody>().error.code).toBe('NOT_FOUND');

    const malformed = await request('GET', '/api/v1/projects/not-a-uuid');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/projects — list, filters and cursor pagination (F5.3)', () => {
  it('excludes archived Projects by default and returns only them with ?archived=true', async () => {
    const live = await createProject({ name: 'Live' });
    const archived = await createProject({ name: 'Archived' });
    await request('PATCH', `/api/v1/projects/${archived.body.id}`, {
      archivedAt: '2026-08-12T10:00:00.000Z',
    });

    const byDefault = await request('GET', '/api/v1/projects');
    expect(byDefault.json<{ data: ProjectBody[] }>().data.map((row) => row.id)).toEqual([
      live.body.id,
    ]);

    const archivedOnly = await request('GET', '/api/v1/projects?archived=true');
    expect(archivedOnly.json<{ data: ProjectBody[] }>().data.map((row) => row.id)).toEqual([
      archived.body.id,
    ]);
  });

  it('walks pages by opaque cursor without repeating or dropping a row', async () => {
    const created: string[] = [];
    for (const name of ['One', 'Two', 'Three', 'Four', 'Five']) {
      created.push((await createProject({ name })).body.id);
    }
    // UUIDv7 ids are time-ordered and the default sort is ascending by id (§1.2).
    const expected = [...created].sort();

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url: string =
        cursor === null
          ? '/api/v1/projects?limit=2'
          : `/api/v1/projects?limit=2&cursor=${encodeURIComponent(cursor)}`;
      const response = await request('GET', url);
      const page = response.json<{
        data: ProjectBody[];
        meta: { nextCursor: string | null; limit: number };
      }>();

      expect(response.statusCode).toBe(200);
      expect(page.meta.limit).toBe(2);
      expect(page.data.length).toBeLessThanOrEqual(2);

      seen.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);

    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  it('rejects a foreign cursor with INVALID_CURSOR', async () => {
    const response = await request('GET', '/api/v1/projects?cursor=not-a-real-cursor');

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('INVALID_CURSOR');
  });
});

describe('PATCH /api/v1/projects/{id}', () => {
  it('updates name and description', async () => {
    const created = await createProject({ name: 'Before' });

    const response = await request('PATCH', `/api/v1/projects/${created.body.id}`, {
      name: 'After',
      description: 'now with a description',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{ data: ProjectBody }>().data;
    expect(body.name).toBe('After');
    expect(body.description).toBe('now with a description');
  });

  it('sets and then clears the workflowMode override — null means inherit', async () => {
    const created = await createProject({ name: 'Inheriting' });
    expect(created.body.workflowMode).toBeNull();

    const set = await request('PATCH', `/api/v1/projects/${created.body.id}`, {
      workflowMode: 'manual',
    });
    expect(set.json<{ data: ProjectBody }>().data.workflowMode).toBe('manual');

    // §4: "workflowMode: null clears the override" — it does not mean "leave it alone".
    const cleared = await request('PATCH', `/api/v1/projects/${created.body.id}`, {
      workflowMode: null,
    });
    expect(cleared.json<{ data: ProjectBody }>().data.workflowMode).toBeNull();

    const row = await testDatabase()
      .db.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, created.body.id));
    expect(row[0]?.workflowMode).toBeNull();

    // A PATCH that does not mention workflowMode leaves the override untouched.
    await request('PATCH', `/api/v1/projects/${created.body.id}`, { workflowMode: 'assisted' });
    const untouched = await request('PATCH', `/api/v1/projects/${created.body.id}`, {
      name: 'Renamed',
    });
    expect(untouched.json<{ data: ProjectBody }>().data.workflowMode).toBe('assisted');
  });

  it('archives and un-archives through archivedAt, keeping the status column in step', async () => {
    const created = await createProject({ name: 'Archivable' });

    const archived = await request('PATCH', `/api/v1/projects/${created.body.id}`, {
      archivedAt: '2026-08-12T10:00:00.000Z',
    });
    expect(archived.json<{ data: ProjectBody }>().data.archivedAt).toBe('2026-08-12T10:00:00.000Z');

    let row = await testDatabase()
      .db.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, created.body.id));
    expect(row[0]?.status).toBe('archived');

    const restored = await request('PATCH', `/api/v1/projects/${created.body.id}`, {
      archivedAt: null,
    });
    expect(restored.json<{ data: ProjectBody }>().data.archivedAt).toBeNull();

    row = await testDatabase()
      .db.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, created.body.id));
    expect(row[0]?.status).toBe('active');
  });

  it('rejects an archivedAt that is not a timestamp', async () => {
    const created = await createProject({ name: 'Bad archive' });

    const response = await request('PATCH', `/api/v1/projects/${created.body.id}`, {
      archivedAt: 'yesterday',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details).toMatchObject({ field: 'archivedAt' });
  });

  it('rejects a rename onto an existing name, and NOT_FOUNDs an unknown id', async () => {
    await createProject({ name: 'Taken' });
    const other = await createProject({ name: 'Free' });

    const clash = await request('PATCH', `/api/v1/projects/${other.body.id}`, { name: 'taken' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json<ErrorBody>().error.code).toBe('CONFLICT');

    const missing = await request('PATCH', `/api/v1/projects/${newId()}`, { name: 'Nothing' });
    expect(missing.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/projects/{id}', () => {
  it('deletes an unreferenced Project and answers 204 with no body', async () => {
    const created = await createProject({ name: 'Disposable' });

    const response = await request('DELETE', `/api/v1/projects/${created.body.id}`);

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect((await request('GET', `/api/v1/projects/${created.body.id}`)).statusCode).toBe(404);

    const entries = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.entityId, created.body.id));
    expect(entries.map((entry) => entry.action)).toContain('project.deleted');
  });

  it('refuses while a Session references it (FK is RESTRICT — TDS 03 §3.9)', async () => {
    const { projectId } = await seedProject('Busy');
    await seedSession({ projectId, userId });

    const response = await request('DELETE', `/api/v1/projects/${projectId}`);

    expect(response.statusCode).toBe(409);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.details).toMatchObject({ sessions: 1 });
  });

  it('refuses while a Repository references it rather than silently unassigning it', async () => {
    const { projectId } = await seedProject('Owns a repo');
    await seedRepository(projectId);

    const response = await request('DELETE', `/api/v1/projects/${projectId}`);

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorBody>().error.details).toMatchObject({ repositories: 1 });

    // The FK is ON DELETE SET NULL, so the guard is the only thing standing between the
    // operator and a repository quietly losing its Project.
    const repositories = await testDatabase().db.select().from(schema.repositories);
    expect(repositories[0]?.projectId).toBe(projectId);
  });

  it('answers NOT_FOUND for an unknown id', async () => {
    const response = await request('DELETE', `/api/v1/projects/${newId()}`);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });
});
