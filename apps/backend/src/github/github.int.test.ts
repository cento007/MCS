import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EventEnvelope, schema } from '@mc/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  seedProject,
  seedSession,
  seedUser,
  type TestApp,
  testDatabase,
  testQueue,
  truncateAll,
} from '../../test/integration/harness.js';
import { SESSION_COOKIE_NAME } from '../auth/cookie.js';
import { runGit } from '../repositories/git.js';
import {
  createDenyingGithubHttp,
  type GithubHttpOutcome,
  type GithubHttpPort,
  type GithubHttpRequest,
} from './http.js';

/**
 * The GitHub integration end to end — TDS 04 §5.1's two routes, the sync service, the polling
 * producer and the event catalog (§15.2 #13–#20), through the real Fastify app, a real
 * database, a real pg-boss queue, and **real git working trees** in the OS temp root.
 *
 * **No test in this file reaches the network.** Every case injects a `GithubHttpPort` double,
 * and the harness's *default* port throws — so the first test below proves that a case which
 * forgot to inject fails locally instead of quietly talking to api.github.com. That is the
 * direct remedy for the earlier defect where an override was accepted at the call site and
 * never forwarded to the module that constructs the transport.
 */

const GIT_TEST_TIMEOUT_MS = 30_000;
/** Deliberately distinctive so the redaction assertions cannot pass by accident. */
const TOKEN = 'ghp_INTEGRATION_TEST_TOKEN_0123456789abcd';

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;
let projectId: string;
let events: EventEnvelope[];

const temporaryPaths: string[] = [];
let recorded: GithubHttpRequest[] = [];

// --------------------------------------------------------------------------- http doubles

type Route = (request: GithubHttpRequest) => GithubHttpOutcome | undefined;

function routingPort(...routes: Route[]): GithubHttpPort {
  return (request) => {
    recorded.push(request);
    for (const route of routes) {
      const outcome = route(request);
      if (outcome !== undefined) return Promise.resolve(outcome);
    }
    return Promise.resolve({
      kind: 'response',
      status: 404,
      headers: RATE_HEADERS,
      body: JSON.stringify({ message: 'Not Found' }),
    });
  };
}

const RATE_HEADERS = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999' };

function json(status: number, body: unknown, headers = RATE_HEADERS): GithubHttpOutcome {
  return { kind: 'response', status, headers, body: JSON.stringify(body) };
}

function route(
  match: string | RegExp,
  outcome: GithubHttpOutcome | (() => GithubHttpOutcome),
): Route {
  return (request) => {
    const url = new URL(request.url);
    const target = `${url.pathname}${url.search}`;
    const hit = typeof match === 'string' ? target.startsWith(match) : match.test(target);
    if (!hit) return undefined;
    return typeof outcome === 'function' ? outcome() : outcome;
  };
}

/** Everything api.github.com returns for a healthy `cento007/MCS`. */
function healthyGithub(
  options: {
    defaultBranch?: string;
    commits?: readonly ReturnType<typeof commitFixture>[];
    pulls?: readonly Record<string, unknown>[];
    reviews?: readonly Record<string, unknown>[];
  } = {},
): GithubHttpPort {
  const commits = options.commits ?? [];
  const pulls = options.pulls ?? [];
  const reviews = options.reviews ?? [];

  return routingPort(
    // The single-commit (detail) endpoint: `/commits/{sha}` — the only source of `files[]`.
    (request) => {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/repos/cento007/MCS/commits/')) return undefined;
      const sha = url.pathname.split('/').pop() ?? '';
      const found = commits.find((commit) => commit.summary.sha === sha);
      return found === undefined
        ? json(404, { message: 'No commit found' })
        : json(200, found.detail);
    },
    route(
      '/repos/cento007/MCS/commits?',
      json(
        200,
        commits.map((commit) => commit.summary),
      ),
    ),
    route(/^\/repos\/cento007\/MCS\/pulls\/\d+\/reviews/, json(200, reviews)),
    route('/repos/cento007/MCS/pulls?', json(200, pulls)),
    route(
      '/repos/cento007/MCS',
      json(200, {
        full_name: 'cento007/MCS',
        default_branch: options.defaultBranch ?? 'main',
        private: true,
        html_url: 'https://github.com/cento007/MCS',
        archived: false,
      }),
    ),
  );
}

function commitFixture(input: {
  sha: string;
  message: string;
  committedAt: string;
  authorName?: string;
  files?: { filename: string; status: string; additions: number; deletions: number }[];
}) {
  const summary = {
    sha: input.sha,
    commit: {
      message: input.message,
      author: {
        name: input.authorName ?? 'Operator',
        email: 'op@example.test',
        date: input.committedAt,
      },
      committer: {
        name: input.authorName ?? 'Operator',
        email: 'op@example.test',
        date: input.committedAt,
      },
    },
    author: { login: 'cento007' },
  };
  return {
    summary,
    detail: {
      ...summary,
      files: input.files ?? [
        { filename: 'README.md', status: 'modified', additions: 1, deletions: 0 },
      ],
    },
  };
}

// ------------------------------------------------------------------------------- fixtures

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

let templateRepository: string | null = null;

/** A real working tree with one commit, built once and copied per use (spawns are slow). */
async function repositoryTemplate(): Promise<string> {
  if (templateRepository !== null) return templateRepository;

  const directory = temporaryDirectory('mc-gh-template-');
  await git(['init', '--initial-branch=main'], directory);
  await git(['config', 'user.email', 'tests@mission-control.invalid'], directory);
  await git(['config', 'user.name', 'Mission Control Tests'], directory);
  await git(['config', 'commit.gpgsign', 'false'], directory);
  writeFileSync(join(directory, 'README.md'), '# fixture\n');
  await git(['add', '.'], directory);
  await git(['commit', '-m', 'initial'], directory);

  templateRepository = directory;
  return directory;
}

/** A copy of the template with `origin` set to `remote` (or no origin when `null`). */
async function workingTree(remote: string | null, prefix = 'mc-gh-repo-'): Promise<string> {
  const template = await repositoryTemplate();
  const directory = temporaryDirectory(prefix);
  cpSync(template, directory, { recursive: true });
  if (remote !== null) await git(['remote', 'add', 'origin', remote], directory);
  return directory;
}

async function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
) {
  return app.inject({
    method,
    url,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function saveGithubSettings(body: Record<string, unknown>): Promise<void> {
  const response = await request('PUT', '/api/v1/settings/integrations/github', body);
  expect(response.statusCode).toBe(200);
}

async function login(): Promise<void> {
  const user = await seedUser();
  userId = user.id;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(response.headers['set-cookie'], SESSION_COOKIE_NAME);
}

async function registerRepository(localPath: string): Promise<string> {
  const response = await request('POST', '/api/v1/repositories', { localPath, projectId });
  expect(response.statusCode).toBe(201);
  return (response.json() as { data: { id: string } }).data.id;
}

function repositoryRow(id: string) {
  return testDatabase()
    .db.select()
    .from(schema.repositories)
    .where(eq(schema.repositories.id, id))
    .then((rows) => rows[0]);
}

function commitRows(repositoryId: string) {
  return testDatabase()
    .db.select()
    .from(schema.commits)
    .where(eq(schema.commits.repositoryId, repositoryId));
}

function pullRequestRows(repositoryId: string) {
  return testDatabase()
    .db.select()
    .from(schema.pullRequests)
    .where(eq(schema.pullRequests.repositoryId, repositoryId));
}

function eventsOfType(type: string): EventEnvelope[] {
  return events.filter((event) => event.type === type);
}

/** Poll until `condition` holds. The queue's floor is 500 ms in the harness. */
async function waitFor(condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition did not hold within the timeout');
}

// ------------------------------------------------------------------------------- lifecycle

/**
 * What api.github.com is currently pretending to be.
 *
 * Indirection rather than rebuilding the app between polls, and that is not a style choice:
 * `testConfig()` mints a fresh `MC_ENCRYPTION_KEY` per app, so a second app cannot decrypt the
 * token the first one sealed. Swapping the *port* keeps one app, one key, and one database
 * across the "poll, something changed on GitHub, poll again" sequences that this file is mostly
 * made of — which is also closer to what actually happens in production.
 */
let github: GithubHttpPort = createDenyingGithubHttp('an un-stubbed case');

function setGithub(port: GithubHttpPort): void {
  github = port;
}

/**
 * Build the app over the file's database and the **real** pg-boss queue.
 *
 * The real queue matters here and nowhere else in this file: the poll chain's whole
 * restart-safety property is "priming twice yields one job", and the no-op queue would make
 * that assertion vacuously true by persisting nothing.
 *
 * Passing no port at all builds the app with the harness's own default, which throws — that is
 * what the first test in this file exercises.
 */
async function build(http?: GithubHttpPort): Promise<void> {
  if (http !== undefined) setGithub(http);

  built = createTestApp({
    queue: await testQueue(),
    ...(http === undefined ? {} : { githubHttp: (request) => github(request) }),
    githubLimits: {
      commitsPerSync: 10,
      commitDetails: 10,
      pullRequestsPerSync: 10,
      reviewFetches: 5,
    },
  });
  app = built.app;
  events = [];
  built.bus.subscribeAll((event) => {
    events.push(event);
  });
}

beforeAll(async () => {
  await repositoryTemplate();
}, 120_000);

beforeEach(async () => {
  await truncateAll();
  recorded = [];
});

afterEach(async () => {
  await built?.github?.stop();
});

afterAll(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

// =============================================================================== the tests

describe('the test harness cannot reach the network', () => {
  beforeEach(async () => {
    await build();
    await login();
    ({ projectId } = await seedProject());
  });

  it('installs a denying GitHub port by default, so a forgotten stub fails loudly here', async () => {
    const localPath = await workingTree('https://github.com/cento007/MCS.git');
    const repositoryId = await registerRepository(localPath);
    await saveGithubSettings({ token: TOKEN });

    // Not "it silently succeeded against api.github.com" — it refuses, naming the URL.
    await expect(built.github.sync.sync(repositoryId)).rejects.toThrow(
      /Outbound GitHub request blocked in the integration harness/,
    );
  });

  it('makes no outbound call at all for discovery, which is local-only', async () => {
    const localPath = await workingTree('https://github.com/cento007/MCS.git');
    await saveGithubSettings({ discoveryRoots: [localPath] });

    const response = await request('POST', '/api/v1/repositories/discover');

    expect(response.statusCode).toBe(200);
    expect(recorded).toHaveLength(0);
  });
});

describe('POST /api/v1/repositories/discover', () => {
  beforeEach(async () => {
    await build(healthyGithub());
    await login();
    ({ projectId } = await seedProject());
  });

  it('refuses with INTEGRATION_NOT_CONFIGURED when no roots are configured (§5.1)', async () => {
    const response = await request('POST', '/api/v1/repositories/discover');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: 'INTEGRATION_NOT_CONFIGURED', details: { integration: 'github' } },
    });
  });

  it('registers GitHub working trees and reports every skip with its reason', async () => {
    const root = temporaryDirectory('mc-gh-root-');

    const mine = join(root, 'mcs');
    cpSync(await workingTree('git@github.com:cento007/MCS.git'), mine, { recursive: true });

    const elsewhere = join(root, 'gitlab-thing');
    cpSync(await workingTree('https://gitlab.com/group/project.git'), elsewhere, {
      recursive: true,
    });

    const noRemote = join(root, 'no-remote');
    cpSync(await workingTree(null), noRemote, { recursive: true });

    const already = join(root, 'already');
    cpSync(await workingTree('https://github.com/cento007/other.git'), already, {
      recursive: true,
    });
    const alreadyId = await registerRepository(already);

    // A plain directory: not a candidate at all, and deliberately not reported as a skip —
    // one entry per non-repository directory under a root would bury the four answers below.
    writeFileSync(join(temporaryDirectory('mc-gh-plain-'), 'file.txt'), 'x');

    await saveGithubSettings({ discoveryRoots: [root] });
    // The manual registration above emitted its own `repository.discovered`; this test is about
    // the events *discovery* produces.
    events = [];

    const response = await request('POST', '/api/v1/repositories/discover');
    expect(response.statusCode).toBe(200);

    const report = (response.json() as { data: Record<string, unknown> }).data;

    expect(report['roots']).toEqual([{ path: root, status: 'scanned', found: 4, detail: null }]);
    expect(report['workflowMode']).toBe('manual');
    expect(report['capability']).toBe('read_only');
    expect(report['truncated']).toBe(false);

    const registered = report['registered'] as {
      repository: Record<string, unknown>;
      owner: string;
      repo: string;
    }[];
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ owner: 'cento007', repo: 'MCS' });
    expect(registered[0]?.repository).toMatchObject({
      localPath: mine,
      name: 'MCS',
      // Canonical and credential-free, rebuilt from the parsed coordinates.
      remoteUrl: 'https://github.com/cento007/MCS',
      // Discovery makes no GitHub call, so it does not claim to know these yet.
      visibility: 'unknown',
      defaultBranch: 'main',
      syncStatus: 'never',
      lastSyncedAt: null,
      projectId: null,
    });

    const skipped = report['skipped'] as {
      localPath: string;
      reason: string;
      repositoryId: string | null;
    }[];
    const byPath = new Map(skipped.map((entry) => [entry.localPath, entry]));

    expect(byPath.get(elsewhere)).toMatchObject({ reason: 'remote_not_github' });
    expect(byPath.get(noRemote)).toMatchObject({ reason: 'no_remote' });
    expect(byPath.get(already)).toMatchObject({
      reason: 'already_registered',
      repositoryId: alreadyId,
    });

    expect(eventsOfType('repository.discovered')).toHaveLength(1);
    expect(eventsOfType('repository.discovered')[0]?.payload).toEqual({
      repositoryId: registered[0]?.repository['id'],
    });
  });

  it('is idempotent: a second run registers nothing and emits nothing', async () => {
    const root = temporaryDirectory('mc-gh-root-');
    cpSync(await workingTree('https://github.com/cento007/MCS.git'), join(root, 'mcs'), {
      recursive: true,
    });
    await saveGithubSettings({ discoveryRoots: [root] });

    await request('POST', '/api/v1/repositories/discover');
    const firstCount = (await testDatabase().db.select().from(schema.repositories)).length;
    events = [];

    const second = await request('POST', '/api/v1/repositories/discover');
    const report = (second.json() as { data: Record<string, unknown> }).data;

    expect(report['registered']).toEqual([]);
    expect(report['skipped']).toHaveLength(1);
    expect((report['skipped'] as { reason: string }[])[0]?.reason).toBe('already_registered');
    expect((await testDatabase().db.select().from(schema.repositories)).length).toBe(firstCount);
    expect(events).toHaveLength(0);
  });

  it('takes a root that is itself a working tree, and audits the registration', async () => {
    const localPath = await workingTree('https://github.com/cento007/MCS.git');
    await saveGithubSettings({ discoveryRoots: [localPath] });

    const response = await request('POST', '/api/v1/repositories/discover');
    const report = (response.json() as { data: Record<string, unknown> }).data;

    expect((report['roots'] as { status: string }[])[0]?.status).toBe('scanned_as_repository');
    expect(report['registered']).toHaveLength(1);

    const audit = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.action, 'repository.discovered'));

    expect(audit).toHaveLength(1);
    expect(audit[0]?.actorId).toBe(userId);
    expect(audit[0]?.after).toMatchObject({ source: 'discovery', name: 'MCS' });
  });

  it('reports a root that does not exist without failing the run', async () => {
    const missing = join(tmpdir(), 'mc-gh-does-not-exist-9f3e');
    const localPath = await workingTree('https://github.com/cento007/MCS.git');
    await saveGithubSettings({ discoveryRoots: [missing, localPath] });

    const response = await request('POST', '/api/v1/repositories/discover');
    const report = (response.json() as { data: Record<string, unknown> }).data;

    expect((report['roots'] as { status: string }[]).map((root) => root.status)).toEqual([
      'path_missing',
      'scanned_as_repository',
    ]);
    expect(report['registered']).toHaveLength(1);
  });
});

describe('POST /api/v1/repositories/{id}/sync', () => {
  let localPath: string;
  let repositoryId: string;

  async function setUp(http: GithubHttpPort, options: { token?: boolean } = {}): Promise<void> {
    await build(http);
    await login();
    ({ projectId } = await seedProject());
    localPath = await workingTree('https://github.com/cento007/MCS.git');
    repositoryId = await registerRepository(localPath);
    if (options.token !== false) await saveGithubSettings({ token: TOKEN });
    events = [];
  }

  it('records commits and pull requests, updates the row, and emits §15.2 events', async () => {
    const commits = [
      commitFixture({
        sha: 'a'.repeat(40),
        message: 'Older change',
        committedAt: '2026-08-12T09:00:00Z',
      }),
      commitFixture({
        sha: 'b'.repeat(40),
        message: 'Newer change',
        committedAt: '2026-08-12T10:00:00Z',
        files: [{ filename: 'src/index.ts', status: 'added', additions: 12, deletions: 0 }],
      }),
    ];

    await setUp(
      healthyGithub({
        // GitHub returns newest first.
        commits: [commits[1] as (typeof commits)[0], commits[0] as (typeof commits)[0]],
        pulls: [
          {
            number: 42,
            title: 'Add the GitHub integration',
            body: 'Closes #1',
            state: 'open',
            draft: false,
            user: { login: 'cento007' },
            head: { ref: 'feature/github' },
            base: { ref: 'main' },
            html_url: 'https://github.com/cento007/MCS/pull/42',
            created_at: '2026-08-10T10:00:00Z',
            updated_at: '2026-08-12T10:00:00Z',
            merged_at: null,
            closed_at: null,
          },
        ],
        reviews: [],
      }),
    );

    const outcome = await built.github.sync.sync(repositoryId);

    expect(outcome).toMatchObject({ status: 'ok', newCommits: 2, newPullRequests: 1 });

    const rows = await commitRows(repositoryId);
    expect(rows).toHaveLength(2);
    const newest = rows.find((row) => row.sha === 'b'.repeat(40));
    expect(newest).toMatchObject({
      message: 'Newer change',
      authorName: 'Operator',
      authorEmail: 'op@example.test',
      branch: 'main',
      sessionId: null,
    });
    expect(newest?.files).toEqual([
      { path: 'src/index.ts', status: 'added', additions: 12, deletions: 0 },
    ]);

    const pulls = await pullRequestRows(repositoryId);
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toMatchObject({
      number: 42,
      state: 'open',
      author: 'cento007',
      headBranch: 'feature/github',
      baseBranch: 'main',
      reviewedAt: null,
    });

    const repository = await repositoryRow(repositoryId);
    expect(repository).toMatchObject({
      syncStatus: 'ok',
      lastSyncError: null,
      visibility: 'private',
      defaultBranch: 'main',
      remoteUrl: 'https://github.com/cento007/MCS',
      lastPolledSha: 'b'.repeat(40),
    });
    expect(repository?.lastSyncedAt).not.toBeNull();

    expect(eventsOfType('commit.recorded')).toHaveLength(2);
    expect(eventsOfType('pull_request.opened')).toHaveLength(1);
    expect(eventsOfType('repository.synced')[0]?.payload).toEqual({
      repositoryId,
      newCommits: 2,
      newPullRequests: 1,
    });
  });

  it('is idempotent: the second run writes no rows and emits nothing', async () => {
    const commit = commitFixture({
      sha: 'c'.repeat(40),
      message: 'Only change',
      committedAt: '2026-08-12T10:00:00Z',
    });

    await setUp(
      healthyGithub({
        commits: [commit],
        pulls: [
          {
            number: 7,
            title: 'A pull request',
            state: 'open',
            draft: false,
            user: { login: 'cento007' },
            head: { ref: 'feature' },
            base: { ref: 'main' },
            html_url: 'https://github.com/cento007/MCS/pull/7',
            created_at: '2026-08-10T10:00:00Z',
            updated_at: '2026-08-12T10:00:00Z',
            merged_at: null,
            closed_at: null,
          },
        ],
      }),
    );

    await built.github.sync.sync(repositoryId);
    const firstSyncedAt = (await repositoryRow(repositoryId))?.lastSyncedAt;
    events = [];

    const second = await built.github.sync.sync(repositoryId);

    expect(second).toMatchObject({ status: 'ok', newCommits: 0, newPullRequests: 0 });
    expect(await commitRows(repositoryId)).toHaveLength(1);
    expect(await pullRequestRows(repositoryId)).toHaveLength(1);
    // Emitting `commit.recorded` for every commit on every poll is what would make the
    // Dashboard useless; a no-op poll is silent.
    expect(events).toHaveLength(0);
    // …but `last_synced_at` still advances, because §7.7 derives the poll's `lastRunAt` from it.
    const repository = await repositoryRow(repositoryId);
    expect(repository?.lastSyncedAt?.getTime()).toBeGreaterThanOrEqual(
      firstSyncedAt?.getTime() ?? 0,
    );
  });

  it('skips the commit walk entirely when the branch head has not moved', async () => {
    const commit = commitFixture({
      sha: 'd'.repeat(40),
      message: 'Only change',
      committedAt: '2026-08-12T10:00:00Z',
    });
    await setUp(healthyGithub({ commits: [commit] }));

    await built.github.sync.sync(repositoryId);
    const firstCallCount = recorded.length;
    recorded = [];

    await built.github.sync.sync(repositoryId);

    // Second run: repository + commits page + pulls page. No commit *detail* requests, because
    // `last_polled_sha` proves there is nothing new.
    expect(recorded).toHaveLength(3);
    expect(firstCallCount).toBeGreaterThan(3);
  });

  describe('failures are recorded as data, never thrown', () => {
    it('rate-limit exhaustion → failed, with an error the operator can act on', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 1_800;
      await setUp(
        routingPort(
          route(/.*/, {
            kind: 'response',
            status: 403,
            headers: {
              'x-ratelimit-limit': '5000',
              'x-ratelimit-remaining': '0',
              'x-ratelimit-reset': String(resetAt),
            },
            body: JSON.stringify({ message: 'API rate limit exceeded for user ID 1.' }),
          }),
        ),
      );

      const outcome = await built.github.sync.sync(repositoryId);

      expect(outcome).toMatchObject({ status: 'failed', failureKind: 'rate_limited' });

      const repository = await repositoryRow(repositoryId);
      expect(repository?.syncStatus).toBe('failed');
      expect(repository?.lastSyncError).toContain('rate limit exhausted');
      expect(repository?.lastSyncError).toContain('resets at');
      // `last_synced_at` is the last *successful* sync (§3.6) and must not advance on failure.
      expect(repository?.lastSyncedAt).toBeNull();

      expect(eventsOfType('repository.sync_failed')).toHaveLength(1);
      expect(eventsOfType('repository.sync_failed')[0]?.payload).toMatchObject({ repositoryId });

      // One request. The client did not retry into the closed window.
      expect(recorded).toHaveLength(1);
    });

    it('does not re-emit an identical failure on the next poll', async () => {
      await setUp(routingPort(route(/.*/, json(404, { message: 'Not Found' }))));

      await built.github.sync.sync(repositoryId);
      expect(eventsOfType('repository.sync_failed')).toHaveLength(1);
      events = [];

      await built.github.sync.sync(repositoryId);
      expect(events).toHaveLength(0);
    });

    it('a 404 on a deleted remote → failed, naming the repository and the likely cause', async () => {
      await setUp(routingPort(route(/.*/, json(404, { message: 'Not Found' }))));

      const outcome = await built.github.sync.sync(repositoryId);

      expect(outcome).toMatchObject({ status: 'failed', failureKind: 'not_found' });
      const repository = await repositoryRow(repositoryId);
      expect(repository?.lastSyncError).toContain('cento007/MCS');
      expect(repository?.lastSyncError).toContain('renamed, deleted, or made private');
    });

    it('a rejected token → failed with the 401 fix, not a retry loop', async () => {
      await setUp(routingPort(route(/.*/, json(401, { message: 'Bad credentials' }))));

      await built.github.sync.sync(repositoryId);

      const repository = await repositoryRow(repositoryId);
      expect(repository?.lastSyncError).toContain('401');
      expect(recorded).toHaveLength(1);
    });

    it('a repository whose origin is not on github.com → failed, naming the host only', async () => {
      await build(healthyGithub());
      await login();
      ({ projectId } = await seedProject());
      const elsewhere = await workingTree('https://user:ghp_LEAKY@gitlab.com/group/project.git');
      const id = await registerRepository(elsewhere);
      await saveGithubSettings({ token: TOKEN });

      const outcome = await built.github.sync.sync(id);

      expect(outcome).toMatchObject({ status: 'failed', failureKind: 'remote_not_github' });
      const repository = await repositoryRow(id);
      expect(repository?.lastSyncError).toContain('gitlab.com');
      // The remote URL carries a credential; only the host is ever reported.
      expect(repository?.lastSyncError).not.toContain('ghp_LEAKY');
      expect(recorded).toHaveLength(0);
    });

    it('a working tree that vanished → failed, without touching GitHub', async () => {
      await setUp(healthyGithub());
      // Clear the cached remote so the sync has to consult the (now missing) working tree.
      await testDatabase()
        .db.update(schema.repositories)
        .set({ remoteUrl: null })
        .where(eq(schema.repositories.id, repositoryId));
      rmSync(localPath, { recursive: true, force: true });

      const outcome = await built.github.sync.sync(repositoryId);

      expect(outcome).toMatchObject({ status: 'failed' });
      expect((await repositoryRow(repositoryId))?.lastSyncError).toMatch(
        /no longer a git working tree|no "origin" remote/,
      );
      expect(recorded).toHaveLength(0);
    });
  });

  describe('when no token is configured', () => {
    it('answers 409 INTEGRATION_NOT_CONFIGURED rather than 401-looping', async () => {
      await setUp(healthyGithub(), { token: false });

      const response = await request('POST', `/api/v1/repositories/${repositoryId}/sync`);

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: {
          code: 'INTEGRATION_NOT_CONFIGURED',
          details: { missing: ['integrations.github.token'] },
        },
      });
      expect(recorded).toHaveLength(0);
    });

    it('the job skips without marking the repository failed', async () => {
      await setUp(healthyGithub(), { token: false });

      const outcome = await built.github.sync.sync(repositoryId);

      expect(outcome).toMatchObject({ status: 'skipped', reason: 'not_configured' });
      // Mission Control declined to ask; that is not a failure OF the repository.
      const repository = await repositoryRow(repositoryId);
      expect(repository?.syncStatus).toBe('never');
      expect(repository?.lastSyncError).toBeNull();
      expect(events).toHaveLength(0);
    });
  });

  it('answers 404 for an unknown repository', async () => {
    await setUp(healthyGithub());
    const response = await request(
      'POST',
      '/api/v1/repositories/00000000-0000-7000-8000-000000000000/sync',
    );
    expect(response.statusCode).toBe(404);
  });

  it('returns 202 with a real pg-boss job id and audits the request', async () => {
    await build(healthyGithub());
    await login();
    ({ projectId } = await seedProject());
    localPath = await workingTree('https://github.com/cento007/MCS.git');
    repositoryId = await registerRepository(localPath);
    await saveGithubSettings({ token: TOKEN });

    const response = await request('POST', `/api/v1/repositories/${repositoryId}/sync`);

    expect(response.statusCode).toBe(202);
    const body = response.json() as { data: { jobId: string } };
    expect(body.data.jobId).toMatch(/^[0-9a-f-]{36}$/);

    const audit = await testDatabase()
      .db.select()
      .from(schema.auditLogEntries)
      .where(eq(schema.auditLogEntries.action, 'repository.sync_requested'));

    expect(audit).toHaveLength(1);
    expect(audit[0]?.after).toMatchObject({ jobId: body.data.jobId, trigger: 'user' });
  });

  it('the enqueued job is actually consumed and the sync lands', async () => {
    // The 202 above is only honest if something runs the job. This drives the whole path:
    // route -> pg-boss -> the `repository.sync` consumer -> `sync_status: 'ok'`.
    await setUp(
      healthyGithub({
        commits: [
          commitFixture({
            sha: '9'.repeat(40),
            message: 'Consumed by the job',
            committedAt: '2026-08-12T10:00:00Z',
          }),
        ],
      }),
    );
    await built.github.start();

    const response = await request('POST', `/api/v1/repositories/${repositoryId}/sync`);
    expect(response.statusCode).toBe(202);

    await waitFor(async () => (await repositoryRow(repositoryId))?.syncStatus === 'ok');

    expect(await commitRows(repositoryId)).toHaveLength(1);
  });

  it('does not run two syncs of the same repository at once', async () => {
    // The guard that matters: `POST /sync` and a poll tick are different entry points into the
    // same work, and a repository being synced twice concurrently would race its own inserts.
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });

    const slow = healthyGithub();
    await setUp(async (input) => {
      await gate;
      return slow(input);
    });

    const first = built.github.sync.sync(repositoryId);
    // Give the first call a turn to enter the in-flight set.
    await Promise.resolve();

    const second = await built.github.sync.sync(repositoryId);
    expect(second).toMatchObject({ status: 'skipped', reason: 'in_flight' });
    expect(built.github.sync.isSyncing(repositoryId)).toBe(true);

    release();
    await first;
    expect(built.github.sync.isSyncing(repositoryId)).toBe(false);
  });
});

describe('commit → Session attribution', () => {
  let localPath: string;
  let repositoryId: string;

  async function setUpWithCommits(
    commits: readonly ReturnType<typeof commitFixture>[],
  ): Promise<void> {
    await build(healthyGithub({ commits: [...commits].reverse() }));
    await login();
    ({ projectId } = await seedProject());
    localPath = await workingTree('https://github.com/cento007/MCS.git');
    repositoryId = await registerRepository(localPath);
    await saveGithubSettings({ token: TOKEN });
    events = [];
  }

  it('links a commit made inside a Session’s window, on its branch, in its repository', async () => {
    const commit = commitFixture({
      sha: 'e'.repeat(40),
      message: 'Made by the session',
      committedAt: '2026-08-13T10:30:00Z',
    });
    await setUpWithCommits([commit]);

    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      state: 'completed',
      workingDir: localPath,
      startedAt: new Date('2026-08-13T10:00:00Z'),
    });
    await testDatabase()
      .db.update(schema.sessions)
      .set({ branch: 'main', completedAt: new Date('2026-08-13T11:00:00Z') })
      .where(eq(schema.sessions.id, sessionId));

    const outcome = await built.github.sync.sync(repositoryId);

    expect(outcome).toMatchObject({ status: 'ok', attributedCommits: 1 });
    expect((await commitRows(repositoryId))[0]?.sessionId).toBe(sessionId);

    // `commit.recorded` carries the Session id, which is what puts it on `session:{id}` too.
    expect(eventsOfType('commit.recorded')[0]?.payload).toMatchObject({ sessionId });
  });

  it('DECLINES to attribute when the Session was on another branch', async () => {
    const commit = commitFixture({
      sha: 'f'.repeat(40),
      message: 'Not the session’s',
      committedAt: '2026-08-13T10:30:00Z',
    });
    await setUpWithCommits([commit]);

    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      state: 'completed',
      workingDir: localPath,
      startedAt: new Date('2026-08-13T10:00:00Z'),
    });
    await testDatabase()
      .db.update(schema.sessions)
      .set({ branch: 'feature/other', completedAt: new Date('2026-08-13T11:00:00Z') })
      .where(eq(schema.sessions.id, sessionId));

    const outcome = await built.github.sync.sync(repositoryId);

    // A wrong attribution is worse than a null.
    expect(outcome).toMatchObject({ status: 'ok', attributedCommits: 0 });
    expect((await commitRows(repositoryId))[0]?.sessionId).toBeNull();
  });

  it('DECLINES when two Sessions on the same branch could both own the commit', async () => {
    const commit = commitFixture({
      sha: '1'.repeat(40),
      message: 'Ambiguous',
      committedAt: '2026-08-13T10:30:00Z',
    });
    await setUpWithCommits([commit]);

    for (const _index of [0, 1]) {
      const sessionId = await seedSession({
        projectId,
        userId,
        repositoryId,
        state: 'completed',
        workingDir: localPath,
        startedAt: new Date('2026-08-13T10:00:00Z'),
      });
      await testDatabase()
        .db.update(schema.sessions)
        .set({ branch: 'main', completedAt: new Date('2026-08-13T11:00:00Z') })
        .where(eq(schema.sessions.id, sessionId));
    }

    await built.github.sync.sync(repositoryId);

    expect((await commitRows(repositoryId))[0]?.sessionId).toBeNull();
  });

  it('DECLINES for a commit outside the Session’s lifetime', async () => {
    const commit = commitFixture({
      sha: '2'.repeat(40),
      message: 'After the session ended',
      committedAt: '2026-08-13T11:30:00Z',
    });
    await setUpWithCommits([commit]);

    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      state: 'completed',
      workingDir: localPath,
      startedAt: new Date('2026-08-13T10:00:00Z'),
    });
    await testDatabase()
      .db.update(schema.sessions)
      .set({ branch: 'main', completedAt: new Date('2026-08-13T11:00:00Z') })
      .where(eq(schema.sessions.id, sessionId));

    await built.github.sync.sync(repositoryId);

    expect((await commitRows(repositoryId))[0]?.sessionId).toBeNull();
  });

  it('never rewrites an attribution a later sync would decide differently', async () => {
    const commit = commitFixture({
      sha: '3'.repeat(40),
      message: 'Recorded before any session existed',
      committedAt: '2026-08-13T10:30:00Z',
    });
    await setUpWithCommits([commit]);

    await built.github.sync.sync(repositoryId);
    expect((await commitRows(repositoryId))[0]?.sessionId).toBeNull();

    // A Session created afterwards, whose window covers the commit, must not retroactively
    // claim it: `session_id` is written once, at insert.
    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      state: 'completed',
      workingDir: localPath,
      startedAt: new Date('2026-08-13T10:00:00Z'),
    });
    await testDatabase()
      .db.update(schema.sessions)
      .set({ branch: 'main', completedAt: new Date('2026-08-13T11:00:00Z') })
      .where(eq(schema.sessions.id, sessionId));
    // Force the commit walk to run again.
    await testDatabase()
      .db.update(schema.repositories)
      .set({ lastPolledSha: null })
      .where(eq(schema.repositories.id, repositoryId));

    await built.github.sync.sync(repositoryId);

    expect((await commitRows(repositoryId))[0]?.sessionId).toBeNull();
  });
});

describe('pull request state and lifecycle events', () => {
  let repositoryId: string;

  function pull(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      number: 42,
      title: 'Add the GitHub integration',
      body: 'Closes #1',
      state: 'open',
      draft: false,
      user: { login: 'cento007' },
      head: { ref: 'feature/github' },
      base: { ref: 'main' },
      html_url: 'https://github.com/cento007/MCS/pull/42',
      created_at: '2026-08-10T10:00:00Z',
      updated_at: '2026-08-12T10:00:00Z',
      merged_at: null,
      closed_at: null,
      ...overrides,
    };
  }

  it('stores GitHub truth and emits one event on first sight of a merged PR', async () => {
    await build(
      healthyGithub({
        pulls: [
          pull({
            state: 'closed',
            merged_at: '2026-08-11T10:00:00Z',
            closed_at: '2026-08-11T10:00:00Z',
          }),
        ],
      }),
    );
    await login();
    ({ projectId } = await seedProject());
    repositoryId = await registerRepository(
      await workingTree('https://github.com/cento007/MCS.git'),
    );
    await saveGithubSettings({ token: TOKEN });
    events = [];

    await built.github.sync.sync(repositoryId);

    const rows = await pullRequestRows(repositoryId);
    // `merged`, not `closed`: A3's GitHub truth, and `ck_pull_requests_state` admits both.
    expect(rows[0]?.state).toBe('merged');
    expect(rows[0]?.mergedAt).not.toBeNull();

    // One event, describing what is true now — not `opened` followed by `merged`.
    expect(eventsOfType('pull_request.merged')).toHaveLength(1);
    expect(eventsOfType('pull_request.opened')).toHaveLength(0);
  });

  it('records reviewed_at when a review appears, and emits `pull_request.reviewed` then', async () => {
    // First poll: an open PR with no reviews yet.
    await build(healthyGithub({ pulls: [pull({})], reviews: [] }));
    await login();
    ({ projectId } = await seedProject());
    repositoryId = await registerRepository(
      await workingTree('https://github.com/cento007/MCS.git'),
    );
    await saveGithubSettings({ token: TOKEN });
    events = [];

    await built.github.sync.sync(repositoryId);

    expect((await pullRequestRows(repositoryId))[0]?.reviewedAt).toBeNull();
    expect(eventsOfType('pull_request.opened')).toHaveLength(1);
    expect(eventsOfType('pull_request.reviewed')).toHaveLength(0);

    // Second poll: somebody reviewed it. Nothing else about the PR changed — which is exactly
    // why the review fetch is not gated on the PR having "moved".
    setGithub(
      healthyGithub({
        pulls: [pull({})],
        reviews: [
          { state: 'PENDING', submitted_at: '2026-08-11T09:00:00Z' },
          { state: 'APPROVED', submitted_at: '2026-08-11T10:00:00Z' },
        ],
      }),
    );
    events = [];

    await built.github.sync.sync(repositoryId);

    const rows = await pullRequestRows(repositoryId);
    // PENDING is a draft only its author can see; the first *submitted* review is the fact.
    expect(rows[0]?.reviewedAt?.toISOString()).toBe('2026-08-11T10:00:00.000Z');
    // `reviewed` is an event, never a stored state — the row still says `open` (A3).
    expect(rows[0]?.state).toBe('open');
    expect(eventsOfType('pull_request.reviewed')).toHaveLength(1);

    // Third poll: the review is already known, so no further event and no further request.
    events = [];
    recorded = [];
    await built.github.sync.sync(repositoryId);
    expect(eventsOfType('pull_request.reviewed')).toHaveLength(0);
    expect(recorded.some((request) => request.url.includes('/reviews'))).toBe(false);
  });

  it('emits `pull_request.closed` with reason `rejected` for a closed, unmerged PR', async () => {
    await build(healthyGithub({ pulls: [pull({})] }));
    await login();
    ({ projectId } = await seedProject());
    repositoryId = await registerRepository(
      await workingTree('https://github.com/cento007/MCS.git'),
    );
    await saveGithubSettings({ token: TOKEN });
    await built.github.sync.sync(repositoryId);

    // The same PR, now closed on GitHub.
    setGithub(
      healthyGithub({ pulls: [pull({ state: 'closed', closed_at: '2026-08-13T10:00:00Z' })] }),
    );
    events = [];

    await built.github.sync.sync(repositoryId);

    expect((await pullRequestRows(repositoryId))[0]?.state).toBe('closed');
    expect(eventsOfType('pull_request.closed')[0]?.payload).toMatchObject({
      repositoryId,
      reason: 'rejected',
    });
  });
});

describe('the polling producer', () => {
  let repositoryId: string;

  beforeEach(async () => {
    await build(healthyGithub());
    await login();
    ({ projectId } = await seedProject());
    repositoryId = await registerRepository(
      await workingTree('https://github.com/cento007/MCS.git'),
    );
  });

  it('does nothing and schedules nothing when syncIntervalMinutes is 0 (manual only)', async () => {
    await saveGithubSettings({ token: TOKEN, syncIntervalMinutes: 0 });

    const summary = await built.github.poller.tick();

    expect(summary).toMatchObject({ ran: false, reason: 'manual_only', nextTickAt: null });
    expect(recorded).toHaveLength(0);
    expect(await pendingPollJobs()).toBe(0);
  });

  it('skips without touching any repository when no token is saved', async () => {
    await saveGithubSettings({ syncIntervalMinutes: 15 });

    const summary = await built.github.poller.tick();

    expect(summary).toMatchObject({ ran: false, reason: 'not_configured' });
    expect(recorded).toHaveLength(0);
    expect((await repositoryRow(repositoryId))?.syncStatus).toBe('never');
    // It still reschedules, so configuring a token later starts polling without a restart.
    expect(summary.nextTickAt).not.toBeNull();
  });

  it('syncs due repositories and schedules exactly one next tick', async () => {
    await saveGithubSettings({ token: TOKEN, syncIntervalMinutes: 15 });

    const summary = await built.github.poller.tick();

    expect(summary).toMatchObject({ ran: true, reason: 'ok', considered: 1 });
    expect(summary.outcomes[0]).toMatchObject({ status: 'ok', repositoryId });
    expect((await repositoryRow(repositoryId))?.syncStatus).toBe('ok');
    expect(await pendingPollJobs()).toBe(1);
  });

  it('priming repeatedly cannot stack up the chain (the restart case)', async () => {
    await saveGithubSettings({ token: TOKEN, syncIntervalMinutes: 15 });

    await built.github.poller.prime();
    await built.github.poller.prime();
    await built.github.poller.prime();

    // The deterministic tick id collapses them: one job, not three pollers.
    expect(await pendingPollJobs()).toBe(1);
  });

  it('does not sync a repository that is already being synced', async () => {
    await saveGithubSettings({ token: TOKEN, syncIntervalMinutes: 15 });

    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });

    // Hold a sync mid-flight by gating the port the app already has.
    const slow = healthyGithub();
    setGithub(async (input) => {
      await gate;
      return slow(input);
    });

    const inFlight = built.github.sync.sync(repositoryId);
    await Promise.resolve();

    const summary = await built.github.poller.tick();

    expect(summary.outcomes[0]).toMatchObject({ status: 'skipped', reason: 'in_flight' });

    release();
    await inFlight;
  });
});

describe('the token never reaches storage, events or the audit log', () => {
  it('survives a GitHub response that echoes the token back', async () => {
    await build(
      routingPort(
        route(/.*/, {
          kind: 'response',
          status: 422,
          headers: RATE_HEADERS,
          body: JSON.stringify({ message: `Token ${TOKEN} is not valid for this resource` }),
        }),
      ),
    );
    await login();
    ({ projectId } = await seedProject());
    const repositoryId = await registerRepository(
      await workingTree('https://github.com/cento007/MCS.git'),
    );
    await saveGithubSettings({ token: TOKEN });
    events = [];

    await built.github.sync.sync(repositoryId);

    const repository = await repositoryRow(repositoryId);
    expect(repository?.lastSyncError).toContain('«redacted»');
    expect(repository?.lastSyncError).not.toContain(TOKEN);

    // Everything that leaves the process, scanned in one go.
    const auditRows = await testDatabase().db.select().from(schema.auditLogEntries);
    const apiResponse = await request('GET', `/api/v1/repositories/${repositoryId}`);
    const settingsResponse = await request('GET', '/api/v1/settings/integrations');

    const serialized = JSON.stringify({
      repository,
      events,
      auditRows,
      api: apiResponse.json(),
      settings: settingsResponse.json(),
    });

    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('INTEGRATION_TEST_TOKEN');
    // The settings read still reports the credential exists, without exposing it (§7.1).
    expect(settingsResponse.json()).toMatchObject({
      data: { github: { token: { isSet: true } } },
    });
  });
});

/**
 * Poll jobs pg-boss has not delivered yet.
 *
 * Reads pg-boss's vendored schema directly, which application code must never do (TDS 03 §7.1)
 * — but this is the only way to assert the property that matters about the chain: that priming
 * it repeatedly yields **one** job and not one per call.
 */
async function pendingPollJobs(): Promise<number> {
  const result = await testDatabase().db.execute<{ count: string }>(
    sql`SELECT count(*)::text AS count FROM pgboss.job
        WHERE name = 'github.poll' AND state IN ('created', 'retry', 'active')`,
  );
  return Number(result.rows[0]?.count ?? 0);
}
