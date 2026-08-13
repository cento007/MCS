import { newId, schema } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
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
import type { CommitDetailResource, CommitResource } from './serialize.js';

/**
 * `GET /api/v1/repositories/{id}/commits` and `GET /api/v1/commits/{id}` end to end — TDS 04
 * §5.2, against a real database.
 *
 * Two properties are the reason this tier exists rather than a unit test with a fake store:
 *
 *  1. **Pagination over a shared `committed_at`.** The composite `(committedAt, id)` cursor is
 *     only correct if the ORDER BY and the keyset predicate agree, and no in-memory double can
 *     prove that — PostgreSQL's collation of `id` decides it. A batch of commits stamped with
 *     one instant (a rebase, a scripted import) is the case that breaks a naive cursor.
 *  2. **`files[]` on the single fetch and nowhere else** (§5.2/§6.10.1), which is a fact about
 *     two routes, not about one serializer.
 */

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;
let projectId: string;
let repositoryId: string;
let otherRepositoryId: string;

interface Page {
  readonly data: readonly CommitResource[];
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

async function list(query = '', repository = repositoryId): Promise<Page> {
  const response = await get(`/api/v1/repositories/${repository}/commits${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
}

interface SeedCommitInput {
  readonly committedAt: Date;
  readonly repositoryId?: string;
  readonly sessionId?: string | null;
  readonly branch?: string | null;
  readonly files?: { path: string; status: string; additions: number; deletions: number }[];
  readonly message?: string;
}

/** Rows written directly: the sync has its own coverage, and this suite is about reading. */
async function seedCommit(input: SeedCommitInput): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.commits)
    .values({
      id,
      repositoryId: input.repositoryId ?? repositoryId,
      sessionId: input.sessionId ?? null,
      // Unique per row (`ux_commits_repository_sha`) and shaped like a real sha
      // (`ck_commits_sha`): 40 lower-case hex characters.
      sha: id.replaceAll('-', '').padEnd(40, '0').slice(0, 40),
      authorName: 'Operator',
      authorEmail: 'operator@example.invalid',
      message: input.message ?? 'seeded commit',
      branch: input.branch ?? 'main',
      files: input.files ?? [],
      committedAt: input.committedAt,
    });
  return id;
}

beforeEach(async () => {
  await truncateAll();

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());
  repositoryId = await seedRepository(projectId, { localPath: 'D:/tmp/mc-commits-a' });
  otherRepositoryId = await seedRepository(projectId, { localPath: 'D:/tmp/mc-commits-b' });

  built = createTestApp({ cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

describe('GET /api/v1/repositories/{id}/commits', () => {
  it('lists newest `committedAt` first, not insertion order', async () => {
    // Inserted oldest-last, which is exactly what a backfill sync does: id order and
    // committed_at order disagree, and only one of them is the answer.
    const newest = await seedCommit({ committedAt: new Date('2026-08-12T10:00:00.000Z') });
    const middle = await seedCommit({ committedAt: new Date('2026-08-11T10:00:00.000Z') });
    const oldest = await seedCommit({ committedAt: new Date('2019-01-01T10:00:00.000Z') });

    const page = await list();

    expect(page.data.map((commit) => commit.id)).toEqual([newest, middle, oldest]);
  });

  it('scopes to the Repository in the path', async () => {
    await seedCommit({ committedAt: new Date('2026-08-12T10:00:00.000Z') });
    await seedCommit({
      committedAt: new Date('2026-08-12T11:00:00.000Z'),
      repositoryId: otherRepositoryId,
    });

    expect((await list()).data).toHaveLength(1);
    expect((await list('', otherRepositoryId)).data).toHaveLength(1);
  });

  it('walks to exhaustion with no overlap and no drop across a shared committed_at', async () => {
    // One instant, nine commits — a rebase, or a scripted import. Without the `id` tiebreak in
    // the cursor these hide each other across every page boundary.
    const shared = new Date('2026-08-12T10:00:00.000Z');
    const ids = new Set<string>();
    for (let index = 0; index < 9; index += 1) ids.add(await seedCommit({ committedAt: shared }));
    // Plus two rows on either side of it, so the page boundaries also straddle a real change.
    ids.add(await seedCommit({ committedAt: new Date('2026-08-12T11:00:00.000Z') }));
    ids.add(await seedCommit({ committedAt: new Date('2026-08-12T09:00:00.000Z') }));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const page: Page = await list(`?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`);
      seen.push(...page.data.map((commit) => commit.id));
      cursor = page.meta.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(20);
    } while (cursor !== null);

    expect(seen).toHaveLength(ids.size);
    expect(new Set(seen).size).toBe(ids.size);
    expect(new Set(seen)).toEqual(ids);
  });

  it('walks ascending order to exhaustion just as cleanly', async () => {
    const shared = new Date('2026-08-12T10:00:00.000Z');
    const ids = new Set<string>();
    for (let index = 0; index < 5; index += 1) ids.add(await seedCommit({ committedAt: shared }));

    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const page: Page = await list(
        `?limit=2&order=asc${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      seen.push(...page.data.map((commit) => commit.id));
      cursor = page.meta.nextCursor;
    } while (cursor !== null);

    expect(new Set(seen)).toEqual(ids);
    // Ascending is the exact reverse of descending over the same rows.
    const descending = (await list('?limit=200')).data.map((commit) => commit.id);
    expect(seen).toEqual([...descending].reverse());
  });

  it('stops on a null nextCursor rather than on an empty page', async () => {
    await seedCommit({ committedAt: new Date('2026-08-12T10:00:00.000Z') });

    const page = await list('?limit=2');

    expect(page.data).toHaveLength(1);
    expect(page.meta.nextCursor).toBeNull();
    expect(page.meta.limit).toBe(2);
  });

  it('never carries `files[]` — that is the single-commit fetch (§5.2)', async () => {
    await seedCommit({
      committedAt: new Date('2026-08-12T10:00:00.000Z'),
      files: [{ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1 }],
    });

    const [commit] = (await list()).data;

    expect(commit).toBeDefined();
    expect(Object.keys(commit as CommitResource)).not.toContain('files');
    // The aggregates it does carry are derived from that array.
    expect(commit?.filesChanged).toBe(1);
    expect(commit?.additions).toBe(4);
    expect(commit?.deletions).toBe(1);
  });

  it('filters by ?sessionId=', async () => {
    const sessionId = await seedSession({ projectId, userId, repositoryId });
    const linked = await seedCommit({
      committedAt: new Date('2026-08-12T10:00:00.000Z'),
      sessionId,
    });
    await seedCommit({ committedAt: new Date('2026-08-12T11:00:00.000Z') });

    const page = await list(`?sessionId=${sessionId}`);

    expect(page.data.map((commit) => commit.id)).toEqual([linked]);
    expect(page.data[0]?.sessionId).toBe(sessionId);
  });

  it('filters by ?branch=', async () => {
    const onDev = await seedCommit({
      committedAt: new Date('2026-08-12T10:00:00.000Z'),
      branch: 'DEV',
    });
    await seedCommit({ committedAt: new Date('2026-08-12T11:00:00.000Z'), branch: 'main' });

    expect((await list('?branch=DEV')).data.map((commit) => commit.id)).toEqual([onDev]);
  });

  it('404s for a Repository that does not exist, instead of an empty page', async () => {
    const response = await get(`/api/v1/repositories/${newId()}/commits`);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('400s INVALID_CURSOR for a foreign cursor', async () => {
    const response = await get(
      `/api/v1/repositories/${repositoryId}/commits?cursor=bm90LWEtY3Vyc29y`,
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('INVALID_CURSOR');
  });

  it('rejects an unknown query parameter by name rather than ignoring it', async () => {
    const response = await get(`/api/v1/repositories/${repositoryId}/commits?session=whatever`);

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toMatchObject({ unknownParameters: ['session'] });
  });
});

describe('GET /api/v1/commits/{id}', () => {
  it('carries `files[]` with per-file status and line counts', async () => {
    const id = await seedCommit({
      committedAt: new Date('2026-08-12T10:00:00.000Z'),
      message: 'Serve the rows the sync writes',
      files: [
        { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2 },
        { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
        { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 30 },
      ],
    });

    const response = await get(`/api/v1/commits/${id}`);

    expect(response.statusCode).toBe(200);
    const commit = response.json<{ data: CommitDetailResource }>().data;

    expect(commit.id).toBe(id);
    expect(commit.repositoryId).toBe(repositoryId);
    expect(commit.message).toBe('Serve the rows the sync writes');
    expect(commit.committedAt).toBe('2026-08-12T10:00:00.000Z');
    expect(commit.files).toEqual([
      { path: 'src/a.ts', status: 'modified', additions: 10, deletions: 2 },
      { path: 'src/b.ts', status: 'added', additions: 5, deletions: 0 },
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 30 },
    ]);
    expect(commit.filesChanged).toBe(3);
    expect(commit.additions).toBe(15);
    expect(commit.deletions).toBe(32);
  });

  it('serves an empty `files[]` for a commit the sync recorded without detail', async () => {
    const id = await seedCommit({ committedAt: new Date('2026-08-12T10:00:00.000Z') });

    const response = await get(`/api/v1/commits/${id}`);
    const commit = response.json<{ data: CommitDetailResource }>().data;

    expect(commit.files).toEqual([]);
    expect(commit.filesChanged).toBe(0);
  });

  it('404s for an unknown id', async () => {
    const response = await get(`/api/v1/commits/${newId()}`);

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
  });

  it('400s a malformed id — the path pattern, not a database lookup', async () => {
    const response = await get('/api/v1/commits/not-a-uuid');

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v1/sessions/{id}/commits (§6.10.1) after the consolidation', () => {
  it('serves the same resource, from the same store, with the same cursor', async () => {
    const sessionId = await seedSession({ projectId, userId, repositoryId });
    const shared = new Date('2026-08-12T10:00:00.000Z');
    const ids = new Set<string>();
    for (let index = 0; index < 5; index += 1) {
      ids.add(await seedCommit({ committedAt: shared, sessionId }));
    }
    await seedCommit({ committedAt: shared });

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(
        `/api/v1/sessions/${sessionId}/commits?limit=2${cursor === null ? '' : `&cursor=${cursor}`}`,
      );
      expect(response.statusCode).toBe(200);
      const page = response.json<Page>();
      seen.push(...page.data.map((commit) => commit.id));
      cursor = page.meta.nextCursor;
    } while (cursor !== null);

    expect(new Set(seen)).toEqual(ids);

    // And the Session-scoped list is the same shape as the Repository-scoped one: no `files[]`.
    const viaRepository = (await list(`?sessionId=${sessionId}&limit=200`)).data;
    expect(new Set(viaRepository.map((commit) => commit.id))).toEqual(ids);
    for (const commit of viaRepository) expect(Object.keys(commit)).not.toContain('files');
  });
});
