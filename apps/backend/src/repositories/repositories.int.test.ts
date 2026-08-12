import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventEnvelope, newId, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { runGit } from './git.js';

/**
 * `/api/v1/repositories/*` end to end — TDS 04 §5.1 plus the three routes this Backend adds
 * (register, remove, working-tree status), through the real Fastify app, a real database, and
 * a **real git repository** created in the OS temp root.
 */

const GIT_TEST_TIMEOUT_MS = 30_000;

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;
let projectId: string;

const temporaryPaths: string[] = [];

interface RepositoryBody {
  id: string;
  projectId: string | null;
  name: string;
  localPath: string;
  remoteUrl: string | null;
  visibility: string;
  defaultBranch: string;
  lastSyncedAt: string | null;
  syncStatus: string;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StatusBody {
  repositoryId: string;
  localPath: string;
  isGitWorkingTree: boolean;
  currentBranch: string | null;
  detachedHead: boolean;
  headSha: string | null;
  uncommittedFiles: number | null;
  ahead: number | null;
  behind: number | null;
  unavailableReason: string | null;
  detail: string | null;
  checkedAt: string;
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

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(directory);
  return directory;
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const outcome = await runGit(args, cwd, { timeoutMs: GIT_TEST_TIMEOUT_MS });
  if (!outcome.ok) {
    throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr || outcome.stdout}`);
  }
}

/** A real working tree on `main` with one commit — the fixture the status route reads. */
async function createRepositoryOnDisk(): Promise<string> {
  const directory = temporaryDirectory('mc-repo-int-');

  await git(['init', '--initial-branch=main'], directory);
  await git(['config', 'user.email', 'tests@mission-control.invalid'], directory);
  await git(['config', 'user.name', 'Mission Control Tests'], directory);
  await git(['config', 'commit.gpgsign', 'false'], directory);

  writeFileSync(join(directory, 'README.md'), '# fixture\n');
  await git(['add', '.'], directory);
  await git(['commit', '-m', 'initial'], directory);

  return directory;
}

/**
 * Built once per file, then **copied** per use.
 *
 * Six `git` spawns cost seconds apiece on Windows, and this file needs a dozen repositories;
 * building each one from scratch turned a 20-second suite into a 100-second one. A directory
 * copy of an initialised repository is an independent repository — tests here delete their
 * fixture and switch its branches, and none of that reaches another test.
 */
let templateRepository: string | null = null;

async function freshRepositoryOnDisk(): Promise<string> {
  templateRepository ??= await createRepositoryOnDisk();
  const directory = temporaryDirectory('mc-repo-copy-');
  cpSync(templateRepository, directory, { recursive: true });
  return directory;
}

async function registerRepository(
  payload: Record<string, unknown>,
): Promise<{ status: number; body: RepositoryBody }> {
  const response = await request('POST', '/api/v1/repositories', payload);
  return { status: response.statusCode, body: response.json<{ data: RepositoryBody }>().data };
}

beforeEach(async () => {
  await truncateAll();

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());

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

afterAll(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('auth (TDS 04 §1.4 — authenticated by default)', () => {
  it('rejects every repository route without a credential', async () => {
    for (const [method, url] of [
      ['GET', '/api/v1/repositories'],
      ['POST', '/api/v1/repositories'],
      ['GET', `/api/v1/repositories/${newId()}`],
      ['PATCH', `/api/v1/repositories/${newId()}`],
      ['DELETE', `/api/v1/repositories/${newId()}`],
      ['GET', `/api/v1/repositories/${newId()}/status`],
    ] as const) {
      const response = await app.inject({ method, url });

      expect(response.statusCode, `${method} ${url}`).toBe(401);
      expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
    }
  });
});

describe('POST /api/v1/repositories — registration by local path', () => {
  it(
    'registers a real working tree, names it from the directory, and starts at sync_status never',
    async () => {
      const directory = await freshRepositoryOnDisk();

      const { status, body } = await registerRepository({ localPath: directory, projectId });

      expect(status).toBe(201);
      expect(body.localPath).toBe(directory);
      expect(body.name).toBe(directory.split(/[\\/]/).pop());
      expect(body.projectId).toBe(projectId);
      // Phase 1 touches no remote: claiming anything else would make the badge a lie.
      expect(body.syncStatus).toBe('never');
      expect(body.lastSyncedAt).toBeNull();
      expect(body.lastSyncError).toBeNull();
      expect(body.remoteUrl).toBeNull();
      expect(body.visibility).toBe('unknown');
      expect(body.defaultBranch).toBe('main');
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'emits repository.discovered (§15.2 #13) and writes an audit row',
    async () => {
      const directory = await freshRepositoryOnDisk();

      const events: EventEnvelope[] = [];
      const unsubscribe = built.bus.on('repository.discovered', (event) => {
        events.push(event);
      });

      const { body } = await registerRepository({ localPath: directory });
      unsubscribe();

      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('repository.discovered');
      expect(events[0]?.payload).toEqual({ repositoryId: body.id });
      expect(events[0]?.source).toBe('backend');

      const entries = await testDatabase()
        .db.select()
        .from(schema.auditLogEntries)
        .where(eq(schema.auditLogEntries.entityId, body.id));
      expect(entries[0]?.action).toBe('repository.registered');
      expect(entries[0]?.actorId).toBe(userId);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it('rejects a path that does not exist', async () => {
    const missing = join(temporaryDirectory('mc-repo-missing-'), 'nowhere');

    const response = await request('POST', '/api/v1/repositories', { localPath: missing });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorBody>();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toMatchObject({ field: 'localPath', reason: 'path_missing' });
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('rejects a file', async () => {
    const directory = temporaryDirectory('mc-repo-file-');
    const file = join(directory, 'repo.txt');
    writeFileSync(file, 'not a directory\n');

    const response = await request('POST', '/api/v1/repositories', { localPath: file });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details).toMatchObject({
      field: 'localPath',
      reason: 'not_a_directory',
    });
  });

  it(
    'rejects a directory that is not a git working tree',
    async () => {
      const directory = temporaryDirectory('mc-repo-plain-');

      const response = await request('POST', '/api/v1/repositories', { localPath: directory });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.code).toBe('VALIDATION_FAILED');
      expect(response.json<ErrorBody>().error.details).toMatchObject({ field: 'localPath' });

      // Nothing was stored: the whole point is that a bad path never becomes a row.
      const rows = await testDatabase().db.select().from(schema.repositories);
      expect(rows).toHaveLength(0);
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it('rejects a relative path (F8.1: absolute native paths only)', async () => {
    const response = await request('POST', '/api/v1/repositories', { localPath: 'relative/path' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.details).toMatchObject({ field: 'localPath' });
  });

  it(
    'rejects a second registration of the same path with CONFLICT',
    async () => {
      const directory = await freshRepositoryOnDisk();
      const first = await registerRepository({ localPath: directory });

      const response = await request('POST', '/api/v1/repositories', {
        // Trailing separator: the same directory, so normalisation has to catch it.
        localPath: `${directory}${join('a', 'b').includes('\\') ? '\\' : '/'}`,
      });

      expect(response.statusCode).toBe(409);
      const body = response.json<ErrorBody>();
      expect(body.error.code).toBe('CONFLICT');
      expect(body.error.details).toMatchObject({ repositoryId: first.body.id });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'rejects an unknown projectId before touching the filesystem',
    async () => {
      const directory = await freshRepositoryOnDisk();

      const response = await request('POST', '/api/v1/repositories', {
        localPath: directory,
        projectId: newId(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.details).toMatchObject({ field: 'projectId' });
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe('GET /api/v1/repositories — list, filter and cursor pagination (F5.3)', () => {
  it(
    'filters by projectId and walks pages by opaque cursor',
    async () => {
      const assigned: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const directory = await freshRepositoryOnDisk();
        assigned.push((await registerRepository({ localPath: directory, projectId })).body.id);
      }
      const unassignedDirectory = await freshRepositoryOnDisk();
      const unassigned = await registerRepository({ localPath: unassignedDirectory });

      const all = await request('GET', '/api/v1/repositories');
      expect(all.json<{ data: RepositoryBody[] }>().data).toHaveLength(4);

      const filtered = await request('GET', `/api/v1/repositories?projectId=${projectId}`);
      expect(
        filtered
          .json<{ data: RepositoryBody[] }>()
          .data.map((row) => row.id)
          .sort(),
      ).toEqual([...assigned].sort());
      expect(filtered.json<{ data: RepositoryBody[] }>().data.map((row) => row.id)).not.toContain(
        unassigned.body.id,
      );

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const url: string =
          cursor === null
            ? '/api/v1/repositories?limit=2'
            : `/api/v1/repositories?limit=2&cursor=${encodeURIComponent(cursor)}`;
        const page = (await request('GET', url)).json<{
          data: RepositoryBody[];
          meta: { nextCursor: string | null; limit: number };
        }>();

        seen.push(...page.data.map((row) => row.id));
        cursor = page.meta.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 10);

      expect(seen).toEqual([...assigned, unassigned.body.id].sort());
      expect(new Set(seen).size).toBe(4);
    },
    GIT_TEST_TIMEOUT_MS * 2,
  );
});

describe('GET / PATCH / DELETE /api/v1/repositories/{id}', () => {
  it(
    'fetches, reassigns, unassigns, renames and removes',
    async () => {
      const directory = await freshRepositoryOnDisk();
      const created = await registerRepository({ localPath: directory });
      expect(created.body.projectId).toBeNull();

      const fetched = await request('GET', `/api/v1/repositories/${created.body.id}`);
      expect(fetched.statusCode).toBe(200);
      expect(fetched.json<{ data: RepositoryBody }>().data.localPath).toBe(directory);

      const assigned = await request('PATCH', `/api/v1/repositories/${created.body.id}`, {
        projectId,
        name: 'Renamed',
        defaultBranch: 'DEV',
      });
      expect(assigned.statusCode).toBe(200);
      const assignedBody = assigned.json<{ data: RepositoryBody }>().data;
      expect(assignedBody.projectId).toBe(projectId);
      expect(assignedBody.name).toBe('Renamed');
      expect(assignedBody.defaultBranch).toBe('DEV');

      // `null` unassigns — the state discovery leaves a Repository in (TDS 03 §3.6).
      const unassigned = await request('PATCH', `/api/v1/repositories/${created.body.id}`, {
        projectId: null,
      });
      expect(unassigned.json<{ data: RepositoryBody }>().data.projectId).toBeNull();

      const removed = await request('DELETE', `/api/v1/repositories/${created.body.id}`);
      expect(removed.statusCode).toBe(204);
      expect(removed.body).toBe('');
      expect((await request('GET', `/api/v1/repositories/${created.body.id}`)).statusCode).toBe(
        404,
      );
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it('answers NOT_FOUND for unknown ids on every route', async () => {
    const id = newId();

    for (const [method, url] of [
      ['GET', `/api/v1/repositories/${id}`],
      ['PATCH', `/api/v1/repositories/${id}`],
      ['DELETE', `/api/v1/repositories/${id}`],
      ['GET', `/api/v1/repositories/${id}/status`],
    ] as const) {
      const response = await request(
        method,
        url,
        method === 'PATCH' ? { name: 'Nothing' } : undefined,
      );

      expect(response.statusCode, `${method} ${url}`).toBe(404);
      expect(response.json<ErrorBody>().error.code).toBe('NOT_FOUND');
    }
  });

  it(
    'rejects assigning to an unknown Project',
    async () => {
      const { projectId: otherProject } = await seedProject('Other');
      const directory = await freshRepositoryOnDisk();
      const created = await registerRepository({ localPath: directory, projectId: otherProject });

      const response = await request('PATCH', `/api/v1/repositories/${created.body.id}`, {
        projectId: newId(),
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorBody>().error.details).toMatchObject({ field: 'projectId' });
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'refuses to remove a Repository a Session still references',
    async () => {
      const directory = await freshRepositoryOnDisk();
      const created = await registerRepository({ localPath: directory, projectId });
      await seedSession({ projectId, userId, repositoryId: created.body.id });

      const response = await request('DELETE', `/api/v1/repositories/${created.body.id}`);

      expect(response.statusCode).toBe(409);
      expect(response.json<ErrorBody>().error.details).toMatchObject({ sessions: 1 });

      // The FK is ON DELETE SET NULL, so without the guard the Session would have quietly
      // lost its repositoryId.
      const rows = await testDatabase().db.select().from(schema.repositories);
      expect(rows).toHaveLength(1);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});

describe('GET /api/v1/repositories/{id}/status — the working tree right now (WC11)', () => {
  it(
    'reports the current branch and dirty count, and tracks both as the tree changes',
    async () => {
      const directory = await freshRepositoryOnDisk();
      const created = await registerRepository({ localPath: directory, projectId });

      const clean = (await request('GET', `/api/v1/repositories/${created.body.id}/status`)).json<{
        data: StatusBody;
      }>().data;

      expect(clean.isGitWorkingTree).toBe(true);
      expect(clean.currentBranch).toBe('main');
      expect(clean.uncommittedFiles).toBe(0);
      expect(clean.unavailableReason).toBeNull();
      expect(clean.repositoryId).toBe(created.body.id);
      expect(clean.localPath).toBe(directory);
      expect(clean.checkedAt).toMatch(/Z$/);

      writeFileSync(join(directory, 'README.md'), '# fixture\nchanged\n');
      writeFileSync(join(directory, 'new-file.ts'), 'export {};\n');

      const dirty = (await request('GET', `/api/v1/repositories/${created.body.id}/status`)).json<{
        data: StatusBody;
      }>().data;
      expect(dirty.uncommittedFiles).toBe(2);
      expect(dirty.currentBranch).toBe('main');

      await git(['checkout', '-b', 'DEV'], directory);

      const branched = (
        await request('GET', `/api/v1/repositories/${created.body.id}/status`)
      ).json<{ data: StatusBody }>().data;
      // The launch modal compares this against the branch the operator picked (WS5 §5.4.1);
      // `defaultBranch` on the Repository row still says `main`, which is exactly why the
      // disclosure cannot be computed from the stored record.
      expect(branched.currentBranch).toBe('DEV');
      expect(branched.uncommittedFiles).toBe(2);
    },
    GIT_TEST_TIMEOUT_MS * 2,
  );

  it(
    'answers 200 with a reason when the path has stopped being readable — not a 500',
    async () => {
      const directory = await freshRepositoryOnDisk();
      const created = await registerRepository({ localPath: directory, projectId });

      rmSync(directory, { recursive: true, force: true });

      const response = await request('GET', `/api/v1/repositories/${created.body.id}/status`);

      expect(response.statusCode).toBe(200);
      const body = response.json<{ data: StatusBody }>().data;
      expect(body.isGitWorkingTree).toBe(false);
      expect(body.unavailableReason).toBe('path_missing');
      expect(body.uncommittedFiles).toBeNull();
      expect(body.currentBranch).toBeNull();
    },
    GIT_TEST_TIMEOUT_MS,
  );

  it(
    'returns a bounded read model — { data } with no pagination meta (§1.2)',
    async () => {
      const directory = await freshRepositoryOnDisk();
      const created = await registerRepository({ localPath: directory, projectId });

      const response = await request('GET', `/api/v1/repositories/${created.body.id}/status`);

      expect(Object.keys(response.json<Record<string, unknown>>())).toEqual(['data']);
    },
    GIT_TEST_TIMEOUT_MS,
  );
});
