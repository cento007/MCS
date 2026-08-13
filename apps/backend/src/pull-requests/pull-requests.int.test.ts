import { newId, schema } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedRepository,
  seedUser,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import type { PullRequestDetailResource, PullRequestResource } from './serialize.js';

/**
 * The three §5.3 PullRequest routes end to end, against a real database.
 *
 * What needs a database here: the `opened_at DESC NULLS LAST, id DESC` ordering and the keyset
 * predicate that has to agree with it — including the rows GitHub gave no `created_at`, which
 * are the ones a naive cursor either loses or repeats forever.
 */

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let projectId: string;
let repositoryId: string;
let otherRepositoryId: string;

interface Page {
  readonly data: readonly PullRequestResource[];
  readonly meta: { readonly nextCursor: string | null; readonly limit: number };
}

interface ErrorBody {
  readonly error: { code: string; message: string; details: unknown; requestId: string };
}

function auth(): Record<string, string> {
  return { cookie: `${SESSION_COOKIE_NAME}=${cookie}` };
}

async function get(url: string): Promise<Awaited<ReturnType<FastifyInstance['inject']>>> {
  return app.inject({ method: 'GET', url, headers: auth() });
}

async function list(url: string): Promise<Page> {
  const response = await get(url);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
}

let nextNumber = 1;

interface SeedPullRequestInput {
  readonly openedAt: Date | null;
  readonly repositoryId?: string;
  readonly state?: 'open' | 'merged' | 'closed' | 'draft';
  readonly title?: string;
  readonly description?: string | null;
  readonly reviewedAt?: Date | null;
  readonly mergedAt?: Date | null;
}

/** Rows written directly: the sync's upsert has its own coverage; this suite reads. */
async function seedPullRequest(input: SeedPullRequestInput): Promise<string> {
  const id = newId();
  const number = nextNumber;
  nextNumber += 1;

  await testDatabase()
    .db.insert(schema.pullRequests)
    .values({
      id,
      repositoryId: input.repositoryId ?? repositoryId,
      number,
      title: input.title ?? `Pull request #${String(number)}`,
      description: input.description ?? null,
      state: input.state ?? 'open',
      author: 'cento007',
      headBranch: 'DEV',
      baseBranch: 'main',
      url: `https://github.com/cento007/MCS/pull/${String(number)}`,
      openedAt: input.openedAt,
      reviewedAt: input.reviewedAt ?? null,
      mergedAt: input.mergedAt ?? null,
      closedAt: null,
    });
  return id;
}

beforeEach(async () => {
  await truncateAll();
  nextNumber = 1;

  const user = await seedUser();
  ({ projectId } = await seedProject());
  repositoryId = await seedRepository(projectId, { localPath: 'D:/tmp/mc-prs-a' });
  otherRepositoryId = await seedRepository(projectId, { localPath: 'D:/tmp/mc-prs-b' });

  built = createTestApp({ cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

describe('GET /api/v1/repositories/{id}/pull-requests', () => {
  it('lists newest-opened first, not insertion order', async () => {
    const newest = await seedPullRequest({ openedAt: new Date('2026-08-12T10:00:00.000Z') });
    const older = await seedPullRequest({ openedAt: new Date('2026-06-01T10:00:00.000Z') });
    const oldest = await seedPullRequest({ openedAt: new Date('2024-01-01T10:00:00.000Z') });

    const page = await list(`/api/v1/repositories/${repositoryId}/pull-requests`);

    expect(page.data.map((pr) => pr.id)).toEqual([newest, older, oldest]);
  });

  it('sorts an undated pull request last rather than first', async () => {
    const undated = await seedPullRequest({ openedAt: null });
    const dated = await seedPullRequest({ openedAt: new Date('2024-01-01T10:00:00.000Z') });

    const page = await list(`/api/v1/repositories/${repositoryId}/pull-requests`);

    expect(page.data.map((pr) => pr.id)).toEqual([dated, undated]);
  });

  it('walks to exhaustion with no overlap and no drop, including undated rows', async () => {
    const shared = new Date('2026-08-12T10:00:00.000Z');
    const ids = new Set<string>();
    for (let index = 0; index < 6; index += 1) ids.add(await seedPullRequest({ openedAt: shared }));
    // Two rows GitHub gave no `created_at`: they sort after everything, and the cursor has to
    // be able to point *at* one of them and resume.
    ids.add(await seedPullRequest({ openedAt: null }));
    ids.add(await seedPullRequest({ openedAt: null }));
    ids.add(await seedPullRequest({ openedAt: new Date('2026-08-12T11:00:00.000Z') }));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Page = await list(
        `/api/v1/repositories/${repositoryId}/pull-requests?limit=2${
          cursor === null ? '' : `&cursor=${cursor}`
        }`,
      );
      seen.push(...page.data.map((pr) => pr.id));
      cursor = page.meta.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(seen).toHaveLength(ids.size);
    expect(new Set(seen).size).toBe(ids.size);
    expect(new Set(seen)).toEqual(ids);
    // The undated rows are the tail, not the head.
    expect(seen.slice(-2).length).toBe(2);
  });

  it('filters by ?state=, including `draft` (GitHub truth, A3)', async () => {
    const open = await seedPullRequest({ openedAt: new Date('2026-08-12T10:00:00.000Z') });
    const draft = await seedPullRequest({
      openedAt: new Date('2026-08-12T09:00:00.000Z'),
      state: 'draft',
    });
    const merged = await seedPullRequest({
      openedAt: new Date('2026-08-11T09:00:00.000Z'),
      state: 'merged',
      mergedAt: new Date('2026-08-11T12:00:00.000Z'),
    });

    const base = `/api/v1/repositories/${repositoryId}/pull-requests`;
    expect((await list(`${base}?state=open`)).data.map((pr) => pr.id)).toEqual([open]);
    expect((await list(`${base}?state=draft`)).data.map((pr) => pr.id)).toEqual([draft]);
    expect((await list(`${base}?state=merged`)).data.map((pr) => pr.id)).toEqual([merged]);
    expect((await list(`${base}?state=closed`)).data).toEqual([]);
  });

  it('rejects a state outside the four GitHub-truth values', async () => {
    const response = await get(`/api/v1/repositories/${repositoryId}/pull-requests?state=rejected`);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });

  it('scopes to the Repository in the path', async () => {
    await seedPullRequest({ openedAt: new Date('2026-08-12T10:00:00.000Z') });
    await seedPullRequest({
      openedAt: new Date('2026-08-12T11:00:00.000Z'),
      repositoryId: otherRepositoryId,
    });

    expect((await list(`/api/v1/repositories/${repositoryId}/pull-requests`)).data).toHaveLength(1);
  });

  it('404s for a Repository that does not exist', async () => {
    const response = await get(`/api/v1/repositories/${newId()}/pull-requests`);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('does not accept ?repositoryId= on the nested route — one source for the scope', async () => {
    const response = await get(
      `/api/v1/repositories/${repositoryId}/pull-requests?repositoryId=${otherRepositoryId}`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details).toMatchObject({
      unknownParameters: ['repositoryId'],
    });
  });
});

describe('GET /api/v1/pull-requests', () => {
  it('spans repositories and filters by ?repositoryId=', async () => {
    const here = await seedPullRequest({ openedAt: new Date('2026-08-12T10:00:00.000Z') });
    const there = await seedPullRequest({
      openedAt: new Date('2026-08-12T11:00:00.000Z'),
      repositoryId: otherRepositoryId,
    });

    expect((await list('/api/v1/pull-requests')).data.map((pr) => pr.id)).toEqual([there, here]);
    expect(
      (await list(`/api/v1/pull-requests?repositoryId=${repositoryId}`)).data.map((pr) => pr.id),
    ).toEqual([here]);
  });

  it('combines ?repositoryId= with ?state=', async () => {
    const open = await seedPullRequest({ openedAt: new Date('2026-08-12T10:00:00.000Z') });
    await seedPullRequest({ openedAt: new Date('2026-08-12T09:00:00.000Z'), state: 'closed' });
    await seedPullRequest({
      openedAt: new Date('2026-08-12T11:00:00.000Z'),
      repositoryId: otherRepositoryId,
    });

    const page = await list(`/api/v1/pull-requests?repositoryId=${repositoryId}&state=open`);

    expect(page.data.map((pr) => pr.id)).toEqual([open]);
  });

  it('404s a ?repositoryId= that names nothing, exactly as the nested route does', async () => {
    const response = await get(`/api/v1/pull-requests?repositoryId=${newId()}`);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('400s INVALID_CURSOR for a foreign cursor', async () => {
    const response = await get('/api/v1/pull-requests?cursor=bm90LWEtY3Vyc29y');

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('INVALID_CURSOR');
  });

  it('rejects an unknown query parameter by name', async () => {
    const response = await get('/api/v1/pull-requests?stat=open');

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toMatchObject({ unknownParameters: ['stat'] });
  });

  it('omits the PR body from list items', async () => {
    await seedPullRequest({
      openedAt: new Date('2026-08-12T10:00:00.000Z'),
      description: 'A long body nobody renders in a list.',
    });

    const [pr] = (await list('/api/v1/pull-requests')).data;

    expect(pr).toBeDefined();
    expect(Object.keys(pr as PullRequestResource)).not.toContain('description');
  });
});

describe('GET /api/v1/pull-requests/{id}', () => {
  it('serves the §5.3 resource with the renamed fields, plus `description`', async () => {
    const id = await seedPullRequest({
      openedAt: new Date('2026-08-12T09:00:00.000Z'),
      reviewedAt: new Date('2026-08-12T11:30:00.000Z'),
      state: 'draft',
      title: 'Serve the rows the sync writes',
      description: 'Closes the read gap.',
    });

    const response = await get(`/api/v1/pull-requests/${id}`);

    expect(response.statusCode).toBe(200);
    const pr = response.json<{ data: PullRequestDetailResource }>().data;

    expect(pr).toMatchObject({
      id,
      repositoryId,
      title: 'Serve the rows the sync writes',
      description: 'Closes the read gap.',
      state: 'draft',
      authorLogin: 'cento007',
      sourceBranch: 'DEV',
      targetBranch: 'main',
      openedAt: '2026-08-12T09:00:00.000Z',
      reviewedAt: '2026-08-12T11:30:00.000Z',
      mergedAt: null,
      closedAt: null,
    });
    expect(typeof pr.number).toBe('number');
    expect(pr.url).toContain('/pull/');
  });

  it('404s for an unknown id', async () => {
    const response = await get(`/api/v1/pull-requests/${newId()}`);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('400s a malformed id', async () => {
    const response = await get('/api/v1/pull-requests/not-a-uuid');

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });
});
