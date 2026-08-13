import {
  createFakeEmbedder,
  createInMemoryVectorStore,
  type EmbeddingPort,
  newId,
  schema,
  settingKey,
} from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cookieValueFrom,
  createTestApp,
  type SeededUser,
  seedAdr,
  seedProject,
  seedRepository,
  seedSession,
  seedUser,
  setSetting,
  type TestApp,
  testDatabase,
  truncateAll,
} from '../../../test/integration/harness.js';
import type { BuildAppOptions } from '../../app.js';
import { SESSION_COOKIE_NAME } from '../../auth/cookie.js';
import type { WorkingTreeStatus } from '../../repositories/git.js';

/**
 * `POST /sessions/{id}/export` and `POST /sessions/{id}/context-package` end to end — TDS 04
 * §6.7 through the real Fastify app, the real guard and a real database.
 *
 * What only this tier can prove:
 *
 *  - the bounds are enforced **by PostgreSQL**: `left()` cuts a 30 000-character message before
 *    it crosses the wire, and the count that reports the cut is computed there too;
 *  - `messages.tool_payload` never reaches either document, against real JSONB rather than a
 *    fixture — the canary in these tests is a credential-shaped string in a tool result;
 *  - the related-context section degrades honestly against the **real** `MemorySearchService`
 *    and the real `MemoryRuntime`. Not configured, stamp mismatch and a retrieval that overruns
 *    its budget are three different sentences, and each is reached by putting the system into
 *    that state rather than by stubbing the answer;
 *  - `git` is never run: the working-tree probe is injected, so this suite is as green on a
 *    machine with no checkout as on one with.
 *
 * **No Qdrant and no Ollama.** The store is `createInMemoryVectorStore` and the embedder is
 * `createFakeEmbedder`, so this tier creates no collection anywhere and makes no outbound call —
 * the harness installs a denying transport underneath to make that a guarantee.
 */

const MODEL = 'fake-embed-text';
const DIMENSION = 64;

let built: TestApp | undefined;
let app: FastifyInstance;
let cookie: string;
let credentials: SeededUser;
let projectId: string;
let userId: string;

interface ExportBody {
  format: string;
  filename: string;
  content: string;
}

interface PackageBody {
  content: string;
  tokenEstimate: number;
  bytes: number;
  generatedAt: string;
  relatedContext: {
    resultCount: number;
    gapReason: string | null;
    gapDetail: string | null;
    embeddingModel: string | null;
  };
}

/** A working tree the test dictates, so no `git` process is ever spawned. */
const CLEAN_TREE: WorkingTreeStatus = {
  isGitWorkingTree: true,
  currentBranch: 'DEV',
  detachedHead: false,
  headSha: 'abc1234def5678901234567890abcdef12345678',
  uncommittedFiles: 12,
  ahead: 2,
  behind: 0,
  unavailableReason: null,
  detail: null,
};

function probeReturning(status: WorkingTreeStatus) {
  return async () => status;
}

/**
 * Build (or rebuild) the app and log in.
 *
 * Rebuilding rather than mutating is what lets one test file cover "memory is not configured"
 * and "memory is configured but stamped by another model" — the runtime resolves once per
 * process and caches a ready state deliberately (`memory/runtime.ts`). The seeded account is
 * *not* re-created: `bootstrapLocalUser` refuses to overwrite an existing one, which is the
 * behaviour that makes it safe on a real install.
 */
async function useApp(overrides: Partial<BuildAppOptions> = {}): Promise<void> {
  if (built !== undefined) {
    await built.sessions.registry.stop();
    await built.app.close();
  }

  built = createTestApp({
    cookieSecure: false,
    sessionExportProbe: probeReturning(CLEAN_TREE),
    ...overrides,
  });
  app = built.app;

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: credentials.username, password: credentials.password },
  });
  cookie = cookieValueFrom(response.headers['set-cookie'], SESSION_COOKIE_NAME);
}

async function post(url: string, payload?: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url,
    headers: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    ...(payload === undefined ? {} : { payload }),
  });
}

async function exportSession(sessionId: string): Promise<ExportBody> {
  const response = await post(`/api/v1/sessions/${sessionId}/export`);
  expect(response.statusCode).toBe(200);
  return response.json<{ data: ExportBody }>().data;
}

async function contextPackage(sessionId: string): Promise<PackageBody> {
  const response = await post(`/api/v1/sessions/${sessionId}/context-package`);
  expect(response.statusCode).toBe(200);
  return response.json<{ data: PackageBody }>().data;
}

async function seedMessages(
  sessionId: string,
  rows: readonly {
    ordinal: number;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content?: string;
    toolName?: string;
    toolFilePath?: string;
    toolPayload?: Record<string, unknown>;
  }[],
): Promise<void> {
  await testDatabase()
    .db.insert(schema.messages)
    .values(
      rows.map((row) => ({
        id: newId(),
        sessionId,
        ordinal: row.ordinal,
        role: row.role,
        content: row.content ?? '',
        ...(row.toolName === undefined ? {} : { toolName: row.toolName }),
        ...(row.toolFilePath === undefined ? {} : { toolFilePath: row.toolFilePath }),
        ...(row.toolPayload === undefined ? {} : { toolPayload: row.toolPayload }),
      })),
    );
}

beforeEach(async () => {
  await truncateAll();
  built = undefined;
  credentials = await seedUser();
  userId = credentials.id;
  ({ projectId } = await seedProject());
  await useApp();
});

afterEach(async () => {
  await built?.sessions.registry.stop();
  await built?.app.close();
  built = undefined;
  await truncateAll();
});

describe('auth and preconditions', () => {
  it('rejects both routes without a credential', async () => {
    for (const url of [
      `/api/v1/sessions/${newId()}/export`,
      `/api/v1/sessions/${newId()}/context-package`,
    ]) {
      const response = await app.inject({ method: 'POST', url });
      expect(response.statusCode, url).toBe(401);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('UNAUTHORIZED');
    }
  });

  it('404s for a session that does not exist', async () => {
    const response = await post(`/api/v1/sessions/${newId()}/export`);
    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOT_FOUND');
  });

  it('409s for a session that has never started — §6.7 "nothing to export"', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'created' });

    for (const suffix of ['export', 'context-package']) {
      const response = await post(`/api/v1/sessions/${sessionId}/${suffix}`);
      expect(response.statusCode, suffix).toBe(409);
      const error = response.json<{ error: { code: string; details: { state: string } } }>().error;
      expect(error.code).toBe('CONFLICT');
      // Distinguishable from a missing Session, which is why the state is in the details.
      expect(error.details.state).toBe('created');
    }
  });

  it('rejects a format it does not implement rather than silently returning Markdown', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });

    const response = await post(`/api/v1/sessions/${sessionId}/export`, { format: 'json' });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown body field on both routes', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });

    for (const suffix of ['export', 'context-package']) {
      const response = await post(`/api/v1/sessions/${sessionId}/${suffix}`, {
        fromat: 'markdown',
      });
      expect(response.statusCode, suffix).toBe(400);
      expect(
        response.json<{ error: { details: { unknownFields: string[] } } }>().error.details
          .unknownFields,
      ).toEqual(['fromat']);
    }
  });
});

describe('POST /sessions/{id}/export', () => {
  it('exports a started session with no messages, honestly', async () => {
    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'running',
      title: 'Nothing happened yet',
    });

    const body = await exportSession(sessionId);

    expect(body.format).toBe('markdown');
    expect(body.filename).toMatch(
      /^session-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-Nothing-happened-yet\.md$/,
    );
    expect(body.content).toContain('_This session recorded no messages._');
    expect(body.content).toContain('\n## Files touched\n');
    expect(body.content).toContain('_Nothing recorded._');
  });

  it('exports a tool-heavy session without a single tool payload', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: 'Tools' });
    await seedMessages(sessionId, [
      { ordinal: 0, role: 'user', content: 'read the config' },
      {
        ordinal: 1,
        role: 'tool',
        toolName: 'Read',
        toolFilePath: 'src/config.ts',
        toolPayload: { input: { file_path: 'src/config.ts' } },
      },
      {
        ordinal: 2,
        role: 'tool',
        content: 'AWS_SECRET_ACCESS_KEY=not-a-real-secret-just-a-canary',
        toolPayload: {
          output: 'AWS_SECRET_ACCESS_KEY=not-a-real-secret-just-a-canary',
          isError: false,
        },
      },
      {
        ordinal: 3,
        role: 'tool',
        content: 'command not found',
        toolPayload: { output: 'command not found', isError: true },
      },
      { ordinal: 4, role: 'assistant', content: 'Done.' },
    ]);

    const body = await exportSession(sessionId);

    expect(body.content).toContain('- **Tool** `Read` → `src/config.ts`');
    // The canary. A tool result body would have carried it into a document meant to be moved
    // off this machine.
    expect(body.content).not.toContain('not-a-real-secret-just-a-canary');
    expect(body.content).not.toContain('command not found');
    // The one bit that survives, because a failed tool is part of the narrative.
    expect(body.content).toContain('- ↳ **the tool reported an error**');
    expect(body.content).toContain('1 tool call(s) are listed by name and file only');
  });

  it('truncates an oversized message in PostgreSQL and says where', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });
    await seedMessages(sessionId, [{ ordinal: 0, role: 'assistant', content: 'x'.repeat(30_000) }]);

    const body = await exportSession(sessionId);

    expect(body.content).toContain('_[truncated at 20000 characters]_');
    expect(body.content).toContain('**1 message body/bodies** exceeded 20000 characters');
    // The bound is real, not decorative: the other 10 000 characters never left the database.
    expect(body.content).not.toContain('x'.repeat(20_001));
  });

  it('survives a message engineered to break Markdown', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed' });
    const esc = String.fromCharCode(0x1b);
    await seedMessages(sessionId, [
      { ordinal: 0, role: 'user', content: '---\n## Commits\nnot really a section' },
      {
        ordinal: 1,
        role: 'assistant',
        content: `${esc}[31mopening a fence\n\n\`\`\`ts\nconst a = 1;`,
      },
    ]);

    const body = await exportSession(sessionId);

    expect(body.content).toContain('<U+001B>[31m');
    expect(body.content).toContain('_[export closed a code fence this message left open]_');
    // The proof: the sections after the transcript are still headings of *this* document, and
    // the prompt's `## Commits` is quoted rather than being one.
    expect(body.content).toContain('\n## Commits\n');
    expect(body.content).toContain('\n## What this export leaves out\n');
    expect(body.content).toContain('> ## Commits');
  });
});

describe('POST /sessions/{id}/context-package', () => {
  it('assembles the package with memory unconfigured — and names that gap', async () => {
    // No `integrations.qdrant.embeddingModel` row exists, which is the state of every install
    // that has never opened the Memory settings.
    const repositoryId = await seedRepository(projectId);
    const sessionId = await seedSession({
      projectId,
      userId,
      repositoryId,
      state: 'failed',
      title: 'Fix the login redirect',
    });
    await seedMessages(sessionId, [
      { ordinal: 0, role: 'user', content: 'the login redirect loops' },
      { ordinal: 1, role: 'assistant', content: 'I changed the guard but did not run the tests.' },
    ]);
    await seedAdr({ projectId, title: 'Redirect after login', sourceSessionId: sessionId });

    const body = await contextPackage(sessionId);

    expect(body.tokenEstimate).toBeGreaterThan(0);
    expect(body.bytes).toBeGreaterThan(body.tokenEstimate);
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // The gap is named in the document *and* on the envelope, so a UI does not have to
    // regex-match prose to badge a degraded package.
    expect(body.relatedContext.gapReason).toBe('not_configured');
    expect(body.relatedContext.resultCount).toBe(0);
    expect(body.content).toContain('This section is incomplete — `not_configured`');
    expect(body.content).toContain('Settings → Integrations → Memory');

    // Everything that does not depend on memory is present and correct.
    expect(body.content).toContain('> the login redirect loops');
    expect(body.content).toContain('I changed the guard but did not run the tests.');
    expect(body.content).toContain('- **Uncommitted entries:** 12');
    expect(body.content).toContain('**ADR-0001** — Redirect after login');
    expect(body.content).toContain('only the pointer is here');
  });

  it('says there is no working tree when the session names no Repository', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: 'Loose' });

    const body = await contextPackage(sessionId);

    expect(body.content).toContain('names no Repository, so there is no working tree');
  });

  it('reports git’s own reason when the working tree cannot be read', async () => {
    await useApp({
      sessionExportProbe: probeReturning({
        isGitWorkingTree: false,
        currentBranch: null,
        detachedHead: false,
        headSha: null,
        uncommittedFiles: null,
        ahead: null,
        behind: null,
        unavailableReason: 'path_missing',
        detail: null,
      }),
    });

    const repositoryId = await seedRepository(projectId);
    const sessionId = await seedSession({ projectId, userId, repositoryId, state: 'completed' });

    const body = await contextPackage(sessionId);

    expect(body.content).toContain('- **Could not be read:** path_missing');
    expect(body.content).not.toContain('Uncommitted entries');
  });

  it('invents nothing at all for a session with only a title', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: 'Bare' });

    const body = await contextPackage(sessionId);

    expect(body.content).toContain('_This session recorded no operator prompts._');
    expect(body.content).toContain('_This session recorded no assistant message._');
    expect(body.content).toContain(
      '_This session touched no files that Mission Control recorded._',
    );
    expect(body.content).toContain('_No commits are attributed to this session._');
    expect(body.content).toContain('_No ADR has been recorded from this session._');
  });

  it('keeps the opening and the most recent prompts, and counts the middle', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: 'Long' });
    await seedMessages(
      sessionId,
      Array.from({ length: 20 }, (_unused, index) => ({
        ordinal: index,
        role: 'user' as const,
        content: `prompt ${String(index)}`,
      })),
    );

    const body = await contextPackage(sessionId);

    expect(body.content).toContain('> prompt 0');
    expect(body.content).toContain('> prompt 19');
    // 20 prompts, a 12-wide window: 3 from the front, 9 from the back, 8 named as omitted.
    expect(body.content).toContain('_8 prompt(s) between the opening and the most recent');
    expect(body.content).not.toContain('> prompt 5');
  });

  it('carries no tool payload either', async () => {
    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: 'Tools' });
    await seedMessages(sessionId, [
      { ordinal: 0, role: 'user', content: 'run the build' },
      {
        ordinal: 1,
        role: 'tool',
        toolName: 'Bash',
        toolPayload: {
          input: { command: 'export TOKEN=not-a-real-secret-just-a-canary && build' },
        },
      },
    ]);

    const body = await contextPackage(sessionId);

    expect(body.content).not.toContain('not-a-real-secret-just-a-canary');
    // The compact form that replaces it: which tools ran, and how often.
    expect(body.content).toContain('**Tools used:** `Bash` ×1');
  });
});

describe('the related-context section against a real memory runtime', () => {
  /** Configure memory the way an operator would, and point it at install-free fakes. */
  async function configureMemory(options: {
    embedder?: EmbeddingPort;
    store?: ReturnType<typeof createInMemoryVectorStore>;
    memoryBudgetMs?: number;
  }): Promise<void> {
    await setSetting('integrations', settingKey('integrations.qdrant.embeddingModel'), MODEL);

    await useApp({
      memoryClients: () => ({
        embedder: options.embedder ?? createFakeEmbedder({ model: MODEL, dimension: DIMENSION }),
        store: options.store ?? createInMemoryVectorStore({ collection: 'mc_memory_test' }),
      }),
      ...(options.memoryBudgetMs === undefined
        ? {}
        : { sessionExportMemoryBudgetMs: options.memoryBudgetMs }),
    });
  }

  it('finds related work in other sessions and excludes this session’s own chunks', async () => {
    const store = createInMemoryVectorStore({ collection: 'mc_memory_test' });
    await configureMemory({ store });

    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Fix the login redirect',
    });
    const otherSessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Earlier work on the auth guard',
    });

    // Two chunks with the same vector, so both clear the floor and only the ownership filter
    // separates them. That is the property under test.
    const embedder = createFakeEmbedder({ model: MODEL, dimension: DIMENSION });
    const embedded = await embedder.embed(['Fix the login redirect', 'Fix the login redirect']);
    if (embedded.kind !== 'ok') throw new Error('the fake embedder failed');

    const ids = [newId(), newId()] as const;
    const owners = [sessionId, otherSessionId] as const;

    await testDatabase()
      .db.insert(schema.memoryItems)
      .values(
        ids.map((id, index) => ({
          id,
          tier: 'session' as const,
          projectId,
          sessionId: owners[index] as string,
          sourceType: 'session' as const,
          sourceId: owners[index] as string,
          chunkOrdinal: 0,
          content:
            index === 0
              ? 'this session talking about itself'
              : 'the auth guard redirected to /login on every render',
          contentHash: (index === 0 ? 'a' : 'b').repeat(64),
          embeddingModel: MODEL,
          embeddingDimension: DIMENSION,
          qdrantPointId: id,
        })),
      );

    await store.ensureCollection({ model: MODEL, dimension: DIMENSION });
    await store.upsert(
      ids.map((id, index) => ({
        id,
        vector: embedded.vectors[index] as number[],
        payload: {
          kind: 'chunk' as const,
          memoryItemId: id,
          tier: 'session' as const,
          projectId,
          sessionId: owners[index] as string,
          agentId: null,
          sourceType: 'session' as const,
          sourceId: owners[index] as string,
          sourceRef: null,
          chunkOrdinal: 0,
          embeddingModel: MODEL,
          embeddingDimension: DIMENSION,
        },
      })),
    );

    const body = await contextPackage(sessionId);

    expect(body.relatedContext.gapReason).toBeNull();
    expect(body.relatedContext.resultCount).toBe(1);
    expect(body.relatedContext.embeddingModel).toBe(MODEL);
    expect(body.content).toContain('Earlier work on the auth guard');
    // Its own chunk is dropped, counted and named — not silently absent.
    expect(body.content).not.toContain('this session talking about itself');
    expect(body.content).toContain("1 further match(es) were this session's own transcript");
  });

  it('refuses to search a collection built by a different model, and says so', async () => {
    // The collection was stamped by the model that built it…
    const store = createInMemoryVectorStore({
      collection: 'mc_memory_test',
      existingStamp: { model: MODEL, dimension: DIMENSION },
      existingPointCount: 3,
    });

    // …and the operator has since pointed the setting at a different one.
    await configureMemory({
      store,
      embedder: createFakeEmbedder({ model: 'mxbai-embed-large', dimension: 1024 }),
    });

    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Fix the login redirect',
    });

    const body = await contextPackage(sessionId);

    expect(body.relatedContext.gapReason).toBe('stamp_mismatch');
    expect(body.content).toContain('This section is incomplete — `stamp_mismatch`');
    expect(body.content).toContain('not comparable');
    expect(body.content).toContain('Rebuild the index');
    // Refused, not degraded: mismatched vectors would return confident nonsense.
    expect(body.relatedContext.resultCount).toBe(0);
    // And the rest of the package is whole.
    expect(body.content).toContain('\n## Where this left off\n');
    expect(body.content).toContain('\n## Working tree, as of now\n');
  });

  it('gives up on a retrieval that runs past its budget, and still produces the package', async () => {
    // Resolves its stamp instantly (so the runtime becomes `ready`) and then stalls on the
    // query embedding — the shape of a real Ollama loading a cold model.
    const slow: EmbeddingPort = {
      model: MODEL,
      async describeModel() {
        return {
          kind: 'ok',
          stamp: { model: MODEL, dimension: DIMENSION },
          capabilities: ['embedding'],
          runtimeVersion: null,
          declaredDimension: DIMENSION,
          contextTokens: 2048,
        };
      },
      async embed() {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        return { kind: 'timeout', timeoutMs: 3_000 };
      },
    };

    await configureMemory({ embedder: slow, memoryBudgetMs: 50 });

    const sessionId = await seedSession({
      projectId,
      userId,
      state: 'completed',
      title: 'Fix the login redirect',
    });

    const started = Date.now();
    const body = await contextPackage(sessionId);

    // The request did not wait for the embedder: the bound is enforced, not merely declared.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(body.relatedContext.gapReason).toBe('timed_out');
    expect(body.content).toContain('This section is incomplete — `timed_out`');
    expect(body.content).toContain('\n## Files this session touched\n');
  });

  it('says there was nothing to search with when the session has no title and no prompt', async () => {
    await configureMemory({});

    const sessionId = await seedSession({ projectId, userId, state: 'completed', title: null });

    const body = await contextPackage(sessionId);

    expect(body.relatedContext.gapReason).toBe('no_query');
    expect(body.content).toContain('this is not an empty result');
  });
});
