import {
  createFailingEmbedder,
  createFakeEmbedder,
  createOllamaEmbedder,
  createQdrantVectorStore,
  DEFAULT_MEMORY_COLLECTION,
  type EmbeddingFailure,
  type EmbeddingStamp,
  MEMORY_SCHEMA_VERSION,
  type MemoryHttpOutcome,
  type MemoryHttpPort,
  STAMP_METADATA_KEYS,
  type VectorStorePort,
} from '@mc/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  type ExecutorDeps,
  testClaudeCode,
  testGithub,
  testObsidian,
  testOllama,
  testQdrant,
  testTelegram,
} from './executors.js';
import {
  type CommandProbeOutcome,
  type HttpProbeOutcome,
  type MemoryPortFactory,
  type PathProbeOutcome,
  redactSecret,
  withTimeout,
} from './ports.js';

/**
 * The §7.4 executors against stubbed transports — **no network, no filesystem, no child
 * process** (TDS 07 §1). Three paths per executor, because all three are things an operator
 * hits: it works, it says no, and it never answers at all.
 *
 * The timeout cases matter most. `POST /sessions/{id}/start` once hung for 45 s behind an
 * unbounded call; a stub that never resolves is how that regression is prevented from here on,
 * and it only works because the bound is enforced in this process rather than by the far end.
 */

const NEVER = new Promise<never>(() => undefined);

function deps(overrides: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    http: overrides.http ?? (() => NEVER),
    path: overrides.path ?? (() => NEVER),
    command: overrides.command ?? (() => NEVER),
    memory: overrides.memory ?? memory(),
    // A monotone fake clock: `latencyMs` becomes deterministic without waiting for anything.
    clock: overrides.clock ?? fakeClock(),
    ...(overrides.timeouts === undefined ? {} : { timeouts: overrides.timeouts }),
  };
}

/**
 * The default memory factory **refuses**, loudly.
 *
 * A factory that quietly built the real adapters would give a unit tier that passes against
 * whatever happens to be listening on `:6333` and `:11434` on the developer's machine, and goes
 * red on a machine that has neither — which is the one property `pnpm test` must keep.
 */
function memory(overrides: Partial<MemoryPortFactory> = {}): MemoryPortFactory {
  return {
    embedder:
      overrides.embedder ??
      (() => {
        throw new Error('the embedder must not be built in this test');
      }),
    store:
      overrides.store ??
      (() => {
        throw new Error('the vector store must not be built in this test');
      }),
  };
}

function fakeClock(step = 25) {
  let now = 1_770_000_000_000;
  return {
    now(): number {
      const value = now;
      now += step;
      return value;
    },
  };
}

function http(outcome: HttpProbeOutcome): ExecutorDeps['http'] {
  return () => Promise.resolve(outcome);
}

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return http({ kind: 'response', status, headers, body: JSON.stringify(body) });
}

// ------------------------------------------------------------------------------------ github

describe('github (§7.4 — identity call)', () => {
  it('reports the authenticated account and the token scopes', async () => {
    const result = await testGithub(
      deps({ http: response(200, { login: 'cento007' }, { 'x-oauth-scopes': 'repo, read:org' }) }),
      { token: 'ghp_valid' },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Authenticated as cento007');
    expect(result.detail).toEqual({ account: 'cento007', scopes: ['repo', 'read:org'] });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('sends the PAT as a bearer token and nothing else', async () => {
    const probe = vi.fn<ExecutorDeps['http']>(async () => ({
      kind: 'response',
      status: 200,
      headers: {},
      body: '{"login":"cento007"}',
    }));

    await testGithub(deps({ http: probe }), { token: 'ghp_valid' });

    const request = probe.mock.calls[0]?.[0];
    expect(request?.url).toBe('https://api.github.com/user');
    expect(request?.headers?.['authorization']).toBe('Bearer ghp_valid');
    expect(request?.timeoutMs).toBe(5_000);
  });

  it('answers a rejected token as data, with the fix in the message', async () => {
    const result = await testGithub(deps({ http: response(401, { message: 'Bad credentials' }) }), {
      token: 'ghp_revoked',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('personal access token');
    expect(result.detail).toMatchObject({ reason: 'unauthorized' });
  });

  it('completes when the transport never does', async () => {
    const result = await testGithub(deps({ http: () => Promise.resolve({ kind: 'timeout' }) }), {
      token: 'ghp_valid',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out after 5000 ms');
    expect(result.detail).toMatchObject({ reason: 'timeout', timeoutMs: 5_000 });
  });

  it('reports an unreachable host without blaming the token', async () => {
    const result = await testGithub(
      deps({
        http: () => Promise.resolve({ kind: 'unreachable', reason: 'getaddrinfo ENOTFOUND' }),
      }),
      { token: 'ghp_valid' },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not reach api.github.com');
    expect(result.message).toContain('ENOTFOUND');
  });

  it('never echoes the token, even when the far end does', async () => {
    const result = await testGithub(
      deps({ http: response(403, { message: 'token ghp_leaky is not allowed' }) }),
      { token: 'ghp_leaky' },
    );

    expect(JSON.stringify(result)).not.toContain('ghp_leaky');
    expect(result.message).toContain('«redacted»');
  });
});

// ---------------------------------------------------------------------------------- telegram

describe('telegram (§7.4 — getMe)', () => {
  it('reports the bot and states that no message was sent', async () => {
    const result = await testTelegram(
      deps({ http: response(200, { ok: true, result: { username: 'mc_bot', id: 42 } }) }),
      { botToken: '123:ABC', chatId: '-100123' },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('Bot @mc_bot reachable');
    expect(result.message).toContain('no test message sent');
    expect(result.detail).toMatchObject({ botUsername: 'mc_bot', testMessageSent: false });
  });

  it('says when there is no chat id to deliver to', async () => {
    const result = await testTelegram(
      deps({ http: response(200, { ok: true, result: { username: 'mc_bot' } }) }),
      { botToken: '123:ABC', chatId: null },
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('no chat ID configured');
    expect(result.detail).toMatchObject({ chatIdConfigured: false });
  });

  it('rejects a bad token as data', async () => {
    const result = await testTelegram(
      deps({ http: response(401, { ok: false, description: 'Unauthorized' }) }),
      { botToken: '123:BAD', chatId: null },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).toContain('BotFather');
  });

  it('completes on a stalled transport', async () => {
    const result = await testTelegram(deps({ http: () => Promise.resolve({ kind: 'timeout' }) }), {
      botToken: '123:ABC',
      chatId: null,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out');
  });

  it('never leaks the bot token, which travels in the URL', async () => {
    // The failure mode this guards: undici quotes the request URL in its error, and the URL
    // *is* `https://api.telegram.org/bot‹TOKEN›/getMe`.
    const result = await testTelegram(
      deps({
        http: () =>
          Promise.resolve({
            kind: 'unreachable',
            reason: 'request to https://api.telegram.org/bot123456:SECRETVALUE/getMe failed',
          }),
      }),
      { botToken: '123456:SECRETVALUE', chatId: null },
    );

    expect(JSON.stringify(result)).not.toContain('SECRETVALUE');
    expect(result.message).toContain('«redacted»');
  });
});

// ---------------------------------------------------------------------------------- obsidian

function path(outcome: PathProbeOutcome): ExecutorDeps['path'] {
  return () => Promise.resolve(outcome);
}

describe('obsidian (§7.4 — vault path)', () => {
  it('passes when the path is a readable, writable directory', async () => {
    const result = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: true,
          isDirectory: true,
          readable: true,
          writable: true,
        }),
      }),
      { vaultPath: 'D:\\Vaults\\Engineering' },
    );

    expect(result.ok).toBe(true);
    expect(result.detail).toMatchObject({ path: 'D:\\Vaults\\Engineering', isDirectory: true });
  });

  it('distinguishes missing, not-a-directory and not-writable', async () => {
    const missing = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: false,
          isDirectory: false,
          readable: false,
          writable: false,
        }),
      }),
      { vaultPath: 'D:\\nope' },
    );
    const file = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: true,
          isDirectory: false,
          readable: true,
          writable: true,
        }),
      }),
      { vaultPath: 'D:\\vault.md' },
    );
    const readOnly = await testObsidian(
      deps({
        path: path({
          kind: 'stat',
          exists: true,
          isDirectory: true,
          readable: true,
          writable: false,
        }),
      }),
      { vaultPath: 'D:\\Vaults\\Locked' },
    );

    expect(missing.message).toContain('does not exist');
    expect(file.message).toContain('is a file');
    // Two-way sync writes into the vault, so read-only is a failure and not a warning.
    expect(readOnly.ok).toBe(false);
    expect(readOnly.message).toContain('not writable');
  });

  it('completes when the filesystem stalls — a disconnected share must not hang the request', async () => {
    const result = await testObsidian(deps({ path: () => Promise.resolve({ kind: 'timeout' }) }), {
      vaultPath: '\\\\nas\\vault',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out');
    expect(result.message).toContain('network share');
  });
});

// ------------------------------------------------------------------------------- claude code

function command(outcome: CommandProbeOutcome): ExecutorDeps['command'] {
  return () => Promise.resolve(outcome);
}

describe('claude-code (§7.4 — CLI version probe)', () => {
  it('reports the version from a configured path', async () => {
    const probe = vi.fn<ExecutorDeps['command']>(async () => ({
      kind: 'exit',
      code: 0,
      stdout: '2.1.4 (Claude Code)\n',
      stderr: '',
    }));

    const result = await testClaudeCode(deps({ command: probe }), {
      cliPath: 'C:\\Users\\op\\claude.exe',
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe('Claude Code CLI 2.1.4 (Claude Code)');
    expect(result.detail).toMatchObject({
      source: 'setting',
      executable: 'C:\\Users\\op\\claude.exe',
    });
    expect(probe).toHaveBeenCalledWith('C:\\Users\\op\\claude.exe', ['--version'], 10_000);
  });

  it('falls back to PATH when no path is configured, and says so', async () => {
    // `''` is the documented "use the binary the SDK ships with" (§7.2) — testing PATH is what
    // the runtime would actually do, so refusing with INTEGRATION_NOT_CONFIGURED would be a
    // refusal to answer a question that has an answer.
    const probe = vi.fn<ExecutorDeps['command']>(async () => ({
      kind: 'exit',
      code: 0,
      stdout: '2.1.4',
      stderr: '',
    }));

    const result = await testClaudeCode(deps({ command: probe }), { cliPath: '' });

    expect(result.ok).toBe(true);
    expect(result.detail).toMatchObject({ source: 'path_lookup', executable: 'claude' });
    expect(probe).toHaveBeenCalledWith('claude', ['--version'], 10_000);
  });

  it('reports a missing executable differently for a set path and for PATH', async () => {
    const configured = await testClaudeCode(deps({ command: command({ kind: 'not_found' }) }), {
      cliPath: 'C:\\wrong\\claude.exe',
    });
    const unconfigured = await testClaudeCode(deps({ command: command({ kind: 'not_found' }) }), {
      cliPath: '',
    });

    expect(configured.message).toBe('No executable at that path');
    expect(unconfigured.message).toContain('on PATH');
  });

  it('reports a nonzero exit with the CLI\u2019s own stderr, capped', async () => {
    const result = await testClaudeCode(
      deps({ command: command({ kind: 'exit', code: 1, stdout: '', stderr: 'boom\n' }) }),
      { cliPath: 'claude' },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('exited 1');
    expect(result.detail).toMatchObject({ stderr: 'boom' });
  });

  it('completes when the CLI never exits', async () => {
    // Belt and braces: the port carries `execFile`'s own timeout AND the executor races it, so
    // a probe double that ignores the timeout still cannot hang the request. The bound is
    // shortened here so the assertion costs milliseconds rather than the real ten seconds.
    const result = await testClaudeCode(
      { ...deps({ command: () => NEVER }), timeouts: { commandMs: 20 } },
      { cliPath: 'claude' },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('did not answer within 20 ms');
  });
});

// -------------------------------------------------------------------------- qdrant and ollama

/**
 * These two are driven through the **real** `@mc/shared/memory` adapters over a stubbed
 * `MemoryHttpPort`, not through hand-written fakes of the adapters. That is the point: the
 * executors exist to reuse the client the rest of Phase 3 runs on, so the assertions are about
 * the message an operator actually reads, produced by the code that actually talks to the
 * service. The response shapes below were captured from a real Ollama 0.32.9 and Qdrant 1.19.0.
 */

const MODEL = 'nomic-embed-text';
const DIMENSION = 768;
const QDRANT_KEY = 'qdrant-api-key-do-not-leak-1234567890';

interface MemoryCall {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function memoryStub(handler: (call: MemoryCall) => MemoryHttpOutcome): {
  http: MemoryHttpPort;
  calls: MemoryCall[];
} {
  const calls: MemoryCall[] = [];
  const http: MemoryHttpPort = async (request) => {
    const call: MemoryCall = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: { ...request.headers },
      body: request.body === undefined ? undefined : JSON.parse(request.body),
    };
    calls.push(call);
    return handler(call);
  };
  return { http, calls };
}

function embedderOver(http: MemoryHttpPort): MemoryPortFactory['embedder'] {
  return (target) =>
    createOllamaEmbedder({ host: target.host, port: target.port, model: target.model, http });
}

function storeOver(http: MemoryHttpPort): MemoryPortFactory['store'] {
  return (target) =>
    createQdrantVectorStore({
      host: target.host,
      port: target.port,
      apiKey: target.apiKey,
      http,
    });
}

/**
 * Where Ollama is not what is under test, the embedder is `@mc/shared`'s own fake rather than a
 * hand-rolled object literal — the fake is maintained beside `EmbeddingPort`, so a field added
 * to the port later shows up as a change to *its* behaviour instead of as a compile error in
 * this file, which teaches nobody anything.
 */
function healthyEmbedder(
  stamp: EmbeddingStamp = { model: MODEL, dimension: DIMENSION },
): MemoryPortFactory['embedder'] {
  return () => createFakeEmbedder({ model: stamp.model, dimension: stamp.dimension });
}

function failingEmbedder(failure: EmbeddingFailure): MemoryPortFactory['embedder'] {
  return (target) => createFailingEmbedder(failure, target.model);
}

const json = (status: number, body: unknown): MemoryHttpOutcome => ({
  kind: 'response',
  status,
  body: JSON.stringify(body),
});

// ------------------------------------------------------------------------------------ ollama

/** `POST /api/show` as Ollama 0.32.9 answers it — capabilities, and no weights loaded. */
function showBody(capabilities: readonly string[], family = 'nomic-bert') {
  return {
    capabilities: [...capabilities],
    model_info: { [`${family}.embedding_length`]: DIMENSION },
  };
}

const UNIT_VECTOR = Array.from({ length: DIMENSION }, (_, index) => (index === 0 ? 1 : 0));

function ollamaHttp(show: MemoryHttpOutcome, embed?: MemoryHttpOutcome) {
  return memoryStub((call) => {
    if (call.path === '/api/version') return json(200, { version: '0.32.9' });
    if (call.path === '/api/show') return show;
    if (call.path === '/api/embed') return embed ?? json(200, { embeddings: [UNIT_VECTOR] });
    return json(404, { error: 'unexpected route' });
  });
}

describe('ollama (§7.4 — the model is an embedder, not merely present)', () => {
  it('reports the measured dimension and the runtime version', async () => {
    const { http } = ollamaHttp(json(200, showBody(['embedding'])));

    const result = await testOllama(deps({ memory: memory({ embedder: embedderOver(http) }) }), {
      host: '127.0.0.1',
      port: 11434,
      model: MODEL,
    });

    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      '"nomic-embed-text" is an embedding model — 768 dimensions (Ollama 0.32.9)',
    );
    // The dimension is the number that has to match the collection, so it is in `detail` as a
    // number rather than only inside prose.
    expect(result.detail).toMatchObject({
      model: MODEL,
      dimension: DIMENSION,
      declaredDimension: DIMENSION,
      capabilities: ['embedding'],
      endpoint: 'http://127.0.0.1:11434',
    });
  });

  it('says "not running" without blaming the model name', async () => {
    const result = await testOllama(
      deps({
        memory: memory({
          embedder: embedderOver(async () => ({
            kind: 'unreachable',
            reason: 'fetch failed: connect ECONNREFUSED 127.0.0.1:11434',
          })),
        }),
      }),
      { host: '127.0.0.1', port: 11434, model: MODEL },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not reach http://127.0.0.1:11434');
    expect(result.message).toContain('ollama serve');
    expect(result.detail).toMatchObject({ reason: 'unreachable' });
  });

  it('says "not pulled" with the exact command that fixes it', async () => {
    const { http } = ollamaHttp(
      json(404, { error: 'model "mxbai-embed-large" not found, try pulling it first' }),
    );

    const result = await testOllama(deps({ memory: memory({ embedder: embedderOver(http) }) }), {
      host: '127.0.0.1',
      port: 11434,
      model: 'mxbai-embed-large',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Ollama has no model named "mxbai-embed-large"');
    expect(result.message).toContain('ollama pull mxbai-embed-large');
    expect(result.detail).toMatchObject({ reason: 'model_missing' });
  });

  it('catches a chat model by capability, without ever asking it to embed', async () => {
    // The whole reason this check exists. Measured on this machine: `POST /api/embed` against
    // `deepseek-r1:8b` answers 501 after **28.6 s**, because Ollama loads eight billion
    // parameters before discovering it has no embedding head; `POST /api/show` settles the same
    // question in 16 ms. So the assertion that matters is not just the message — it is that
    // `/api/embed` was never called.
    const { http, calls } = ollamaHttp(
      json(200, showBody(['tools', 'thinking', 'completion'], 'qwen3')),
    );

    const result = await testOllama(deps({ memory: memory({ embedder: embedderOver(http) }) }), {
      host: '127.0.0.1',
      port: 11434,
      model: 'deepseek-r1:8b',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('is not an embedding model');
    expect(result.message).toContain('[tools, thinking, completion]');
    expect(result.message).toContain('nomic-embed-text');
    expect(result.detail).toMatchObject({
      reason: 'not_an_embedding_model',
      capabilities: ['tools', 'thinking', 'completion'],
    });
    expect(calls.map((call) => call.path)).not.toContain('/api/embed');
  });

  it('completes against a transport that ignores its deadline', async () => {
    // The real adapter over an HTTP port that never answers and never aborts: the deadline this
    // executor hands down is enforced by a timer in this process, not by the far end's manners.
    const result = await testOllama(
      deps({
        memory: memory({ embedder: embedderOver(() => NEVER) }),
        timeouts: { memoryMs: 20 },
      }),
      { host: '127.0.0.1', port: 11434, model: MODEL },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out after 20 ms');
    expect(result.detail).toMatchObject({ reason: 'timeout', timeoutMs: 20 });
  });

  it('completes when the port itself never settles', async () => {
    // One level up from the previous case: a port with **no timer of its own** still cannot hold
    // the request, because `boundedCheck` races the whole check. That is the bound that survives
    // someone swapping the adapter out later.
    const result = await testOllama(
      deps({
        memory: memory({
          embedder: () => ({ model: MODEL, embed: () => NEVER, describeModel: () => NEVER }),
        }),
        timeouts: { memoryMs: 20 },
      }),
      { host: '127.0.0.1', port: 11434, model: MODEL },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out after 20 ms');
  });
});

// ------------------------------------------------------------------------------------ qdrant

/** `GET /collections/{n}` in the exact nesting Qdrant 1.19 returns. */
function collectionBody(input: {
  readonly points?: number;
  readonly size?: number | null;
  readonly stamp?: EmbeddingStamp | null;
  readonly schemaVersion?: number;
}) {
  const stamp = input.stamp === undefined ? { model: MODEL, dimension: DIMENSION } : input.stamp;
  const size = input.size === undefined ? DIMENSION : input.size;

  return {
    points_count: input.points ?? 0,
    config: {
      params: { vectors: size === null ? {} : { size, distance: 'Cosine' } },
      metadata:
        stamp === null
          ? {}
          : {
              [STAMP_METADATA_KEYS.schemaVersion]: input.schemaVersion ?? MEMORY_SCHEMA_VERSION,
              [STAMP_METADATA_KEYS.model]: stamp.model,
              [STAMP_METADATA_KEYS.dimension]: stamp.dimension,
              [STAMP_METADATA_KEYS.stampedAt]: '2026-08-13T09:00:00.000Z',
            },
    },
  };
}

const qdrantOk = (result: unknown): MemoryHttpOutcome =>
  json(200, { result, status: 'ok', time: 0.001 });

const qdrantError = (status: number, message: string): MemoryHttpOutcome =>
  json(status, { status: { error: message }, time: 0.001 });

function qdrantInput(overrides: Partial<Parameters<typeof testQdrant>[1]> = {}) {
  return {
    host: '127.0.0.1',
    port: 6333,
    apiKey: null,
    model: MODEL,
    ollamaHost: '127.0.0.1',
    ollamaPort: 11434,
    ...overrides,
  };
}

describe('qdrant (§7.4 — reachable, and the stamp still means what settings mean)', () => {
  it('passes when the collection stamp matches, and never writes to prove it', async () => {
    const { http, calls } = memoryStub(() =>
      qdrantOk(collectionBody({ points: 1_240, stamp: { model: MODEL, dimension: DIMENSION } })),
    );

    const result = await testQdrant(
      deps({ memory: memory({ store: storeOver(http), embedder: healthyEmbedder() }) }),
      qdrantInput(),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toBe(
      'Qdrant is reachable; "mc_memory" holds 1240 points stamped nomic-embed-text (768d), ' +
        'which matches settings.',
    );
    expect(result.detail).toMatchObject({
      collection: DEFAULT_MEMORY_COLLECTION,
      pointCount: 1_240,
      collectionModel: MODEL,
      expectedDimension: DIMENSION,
      stampVerified: true,
      indexed: true,
    });
    // A diagnostic must not change what it diagnoses: `ensureCollection` would PATCH a stamp
    // and CREATE a missing collection, so this executor uses the pure `verifyStamp` instead.
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('passes an absent collection as "nothing indexed yet", without waking a model', async () => {
    const { http } = memoryStub(() =>
      qdrantError(404, "Not found: Collection `mc_memory` doesn't exist!"),
    );

    const result = await testQdrant(
      // The embedder factory throws if built, and a first-run check must not build it: waking a
      // model to report that nothing has been indexed is seconds of work to learn nothing.
      // The tight bound is so that a regression fails in milliseconds — `boundedCheck` turns a
      // throw inside the check into the same "did not complete" answer a stall gives, which is
      // right in production and slow in a test.
      deps({ memory: memory({ store: storeOver(http) }), timeouts: { memoryMs: 500 } }),
      qdrantInput(),
    );

    expect(result.ok).toBe(true);
    expect(result.message).toContain('does not exist yet, so nothing is indexed');
    expect(result.detail).toMatchObject({ exists: false, indexed: false });
  });

  it('fails a model mismatch, naming both values and both ways out', async () => {
    const { http } = memoryStub(() =>
      qdrantOk(
        collectionBody({ points: 12, stamp: { model: 'mxbai-embed-large', dimension: DIMENSION } }),
      ),
    );

    const result = await testQdrant(
      deps({ memory: memory({ store: storeOver(http), embedder: healthyEmbedder() }) }),
      qdrantInput(),
    );

    // Reachable, healthy, answering — and **not** a pass. This is the condition under which
    // search returns confident nonsense, and it is invisible on every other surface.
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Embedding model mismatch');
    expect(result.message).toContain('mxbai-embed-large (768d)');
    expect(result.message).toContain('nomic-embed-text (768d)');
    expect(result.message).toContain('re-index');
    expect(result.detail).toMatchObject({
      reason: 'stamp_mismatch',
      mismatch: 'model',
      foundModel: 'mxbai-embed-large',
      expectedModel: MODEL,
    });
  });

  it('fails a dimension mismatch on the width Qdrant enforces itself', async () => {
    // A hand-made 1024-wide collection carrying the right model name. The metadata stamp agrees;
    // the width does not, and the width is the half that survives on any Qdrant version.
    const { http } = memoryStub(() =>
      qdrantOk(
        collectionBody({ points: 3, size: 1_024, stamp: { model: MODEL, dimension: 1_024 } }),
      ),
    );

    const result = await testQdrant(
      deps({ memory: memory({ store: storeOver(http), embedder: healthyEmbedder() }) }),
      qdrantInput(),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Embedding dimension mismatch');
    expect(result.message).toContain('created for 1024 dimensions');
    expect(result.detail).toMatchObject({ mismatch: 'dimension', foundDimension: 1_024 });
  });

  it('refuses a non-empty unstamped collection and adopts an empty one', async () => {
    const populated = memoryStub(() => qdrantOk(collectionBody({ points: 9, stamp: null }))).http;
    const empty = memoryStub(() => qdrantOk(collectionBody({ points: 0, stamp: null }))).http;

    const refused = await testQdrant(
      deps({ memory: memory({ store: storeOver(populated), embedder: healthyEmbedder() }) }),
      qdrantInput(),
    );
    const adoptable = await testQdrant(
      deps({ memory: memory({ store: storeOver(empty), embedder: healthyEmbedder() }) }),
      qdrantInput(),
    );

    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('carries no Mission Control stamp and already holds points');
    // Nothing in an empty collection can be wrong, so this is a pass that says what will happen.
    expect(adoptable.ok).toBe(true);
    expect(adoptable.message).toContain('the first index run stamps it nomic-embed-text (768d)');
  });

  it('still catches a model mismatch when Ollama is down', async () => {
    // The dimension needs a live embedder; the *name* does not — and the name is the half an
    // operator changes by editing one field. Losing that guard exactly when Ollama is down
    // would lose it at the worst moment.
    const { http } = memoryStub(() =>
      qdrantOk(
        collectionBody({ points: 5, stamp: { model: 'mxbai-embed-large', dimension: 768 } }),
      ),
    );

    const result = await testQdrant(
      deps({
        memory: memory({
          store: storeOver(http),
          embedder: failingEmbedder({ kind: 'unreachable', reason: 'Could not reach Ollama' }),
        }),
      }),
      qdrantInput(),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Embedding model mismatch');
    expect(result.detail).toMatchObject({ reason: 'stamp_mismatch', mismatch: 'model' });
  });

  it('does not claim a pass when the stamp could not be verified', async () => {
    const { http } = memoryStub(() => qdrantOk(collectionBody({ points: 1 })));

    const result = await testQdrant(
      deps({
        memory: memory({
          store: storeOver(http),
          embedder: failingEmbedder({ kind: 'timeout', timeoutMs: 1_500 }),
        }),
      }),
      qdrantInput(),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('holds 1 point');
    expect(result.message).toContain('could not be verified');
    expect(result.detail).toMatchObject({ reason: 'stamp_unverified', embedderReason: 'timeout' });
  });

  it('reports an unreachable server and a rejected API key differently', async () => {
    const dead = await testQdrant(
      deps({
        memory: memory({
          store: storeOver(async () => ({
            kind: 'unreachable',
            reason: 'fetch failed: connect ECONNREFUSED 127.0.0.1:6399',
          })),
        }),
      }),
      qdrantInput({ port: 6399 }),
    );
    const rejected = await testQdrant(
      deps({
        memory: memory({
          store: storeOver(memoryStub(() => qdrantError(401, 'Must provide an API key')).http),
        }),
      }),
      qdrantInput({ apiKey: QDRANT_KEY }),
    );

    expect(dead.ok).toBe(false);
    expect(dead.message).toContain('Could not reach Qdrant at http://127.0.0.1:6399');
    expect(dead.message).toContain('Is the Qdrant service running?');
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain('Qdrant rejected the API key (401)');
    expect(rejected.message).toContain('integrations.qdrant.apiKey');
  });

  it('completes against a transport that ignores its deadline', async () => {
    const result = await testQdrant(
      deps({ memory: memory({ store: storeOver(() => NEVER) }), timeouts: { memoryMs: 20 } }),
      qdrantInput(),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out after 20 ms');
    expect(result.detail).toMatchObject({ reason: 'timeout', timeoutMs: 20 });
  });

  it('completes when the port itself never settles', async () => {
    const hanging: VectorStorePort = {
      collection: DEFAULT_MEMORY_COLLECTION,
      ensureCollection: () => NEVER,
      resetCollection: () => NEVER,
      describeCollection: () => NEVER,
      upsert: () => NEVER,
      search: () => NEVER,
      deleteByFilter: () => NEVER,
    };

    const result = await testQdrant(
      deps({ memory: memory({ store: () => hanging }), timeouts: { memoryMs: 20 } }),
      qdrantInput(),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Timed out after 20 ms');
  });

  it('never lets the API key out, however hard the far end pushes it back', async () => {
    // Three ways a credential leaks in practice: a transport error quoting a URL, a server
    // echoing the header it rejected, and a `detail` field somebody added later. The assertion
    // is on the **serialized** result, so it keeps holding when the shape changes.
    const echoing = memoryStub((call) =>
      qdrantError(500, `api-key ${call.headers['api-key'] ?? ''} was rejected upstream`),
    );

    const echoed = await testQdrant(
      deps({ memory: memory({ store: storeOver(echoing.http) }) }),
      qdrantInput({ apiKey: QDRANT_KEY }),
    );
    const quoted = await testQdrant(
      deps({
        memory: memory({
          store: storeOver(async () => ({
            kind: 'unreachable',
            reason: `request to http://${QDRANT_KEY}@127.0.0.1:6333/collections failed`,
          })),
        }),
      }),
      qdrantInput({ apiKey: QDRANT_KEY }),
    );

    // The key really did reach the wire — this is a redaction test, not an absence test.
    expect(echoing.calls[0]?.headers['api-key']).toBe(QDRANT_KEY);
    expect(JSON.stringify(echoed)).not.toContain(QDRANT_KEY);
    expect(JSON.stringify(quoted)).not.toContain(QDRANT_KEY);
    expect(echoed.message).toContain('«redacted»');
    expect(quoted.message).toContain('«redacted»');
  });
});

// ------------------------------------------------------------------------------------ shared

describe('bounds and redaction', () => {
  it('withTimeout resolves the fallback when the work never settles', async () => {
    expect(await withTimeout(NEVER, 5, 'fallback')).toBe('fallback');
  });

  it('withTimeout resolves the fallback when the work rejects', async () => {
    expect(await withTimeout(Promise.reject(new Error('nope')), 1_000, 'fallback')).toBe(
      'fallback',
    );
  });

  it('redactSecret removes every occurrence and ignores trivially short values', () => {
    expect(redactSecret('a TOKEN and TOKEN again', 'TOKEN')).toBe(
      'a «redacted» and «redacted» again',
    );
    expect(redactSecret('nothing to do', null)).toBe('nothing to do');
    // A 3-character "secret" would redact half the message; that is noise, not protection.
    expect(redactSecret('abc def', 'abc')).toBe('abc def');
  });
});
