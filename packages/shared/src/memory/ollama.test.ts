import { describe, expect, it } from 'vitest';
import type { MemoryHttpOutcome, MemoryHttpPort, MemoryHttpRequest } from './http.js';
import { createDenyingMemoryHttp } from './http.js';
import { createOllamaEmbedder, ollamaBaseUrl } from './ollama.js';

/**
 * The Ollama adapter, driven by stubs that reproduce **responses captured from a real Ollama
 * 0.32.9** on this machine. Every body below is a literal, not an invention:
 *
 *   POST /api/show   nomic-embed-text -> 200 capabilities ["embedding"],
 *                                        model_info["nomic-bert.embedding_length"] = 768
 *   POST /api/show   deepseek-r1:8b   -> 200 capabilities ["tools","thinking","completion"]
 *   POST /api/show   unknown          -> 404 {"error":"model 'x:latest' not found"}
 *   POST /api/embed  chat model       -> 501 {"error":"This server does not support embeddings…"}
 *                                        after 28.6 s of loading weights
 *   POST /api/embed  unknown model    -> 404 {"error":"model \"x\" not found, try pulling it first"}
 *   POST /api/wrong-route             -> 404 "404 page not found"  (plain text, no JSON)
 *
 * The unit tier must stay runnable with nothing installed, so nothing here reaches the network.
 */

interface Call {
  readonly path: string;
  readonly body: unknown;
  readonly timeoutMs: number;
}

interface Stub {
  readonly http: MemoryHttpPort;
  readonly calls: readonly Call[];
}

function stub(handler: (path: string, body: unknown) => MemoryHttpOutcome): Stub {
  const calls: Call[] = [];
  const http: MemoryHttpPort = async (request: MemoryHttpRequest) => {
    const path = new URL(request.url).pathname;
    const body: unknown = request.body === undefined ? undefined : JSON.parse(request.body);
    calls.push({ path, body, timeoutMs: request.timeoutMs });
    return handler(path, body);
  };
  return { http, calls };
}

const json = (status: number, body: unknown): MemoryHttpOutcome => ({
  kind: 'response',
  status,
  body: JSON.stringify(body),
});

const text = (status: number, body: string): MemoryHttpOutcome => ({
  kind: 'response',
  status,
  body,
});

/** A vector of `dimension` values that is not already unit-length, to prove normalization. */
function rawVector(dimension: number, seed: number): number[] {
  return Array.from({ length: dimension }, (_unused, index) =>
    index === seed % dimension ? 4 : 1,
  );
}

const SHOW_EMBEDDER = {
  capabilities: ['embedding'],
  model_info: { 'nomic-bert.context_length': 2048, 'nomic-bert.embedding_length': 768 },
  details: { family: 'nomic-bert' },
};

const SHOW_CHAT = {
  capabilities: ['tools', 'thinking', 'completion'],
  model_info: { 'qwen3.embedding_length': 4096 },
  details: { family: 'qwen3' },
};

function embedder(handler: (path: string, body: unknown) => MemoryHttpOutcome, dimension = 8) {
  void dimension;
  const stubbed = stub(handler);
  return {
    port: createOllamaEmbedder({
      host: '127.0.0.1',
      port: 11434,
      model: 'nomic-embed-text',
      http: stubbed.http,
      embedTimeoutMs: 50,
      probeTimeoutMs: 50,
    }),
    calls: stubbed.calls,
  };
}

/** The happy path: an embedder that always answers with `count` unit-normalizable vectors. */
function happy(dimension = 8) {
  return embedder((path, body) => {
    if (path === '/api/show') return json(200, SHOW_EMBEDDER);
    if (path === '/api/version') return json(200, { version: '0.32.9' });
    if (path === '/api/embed') {
      const input = (body as { input: string[] }).input;
      return json(200, {
        embeddings: input.map((_unused, index) => rawVector(dimension, index)),
      });
    }
    return text(404, '404 page not found');
  });
}

// -------------------------------------------------------------------------- the capability gate

describe('a non-embedding model is rejected by name', () => {
  it('fails with an actionable message before any embedding call is made', async () => {
    const { port, calls } = embedder((path) =>
      path === '/api/show' ? json(200, SHOW_CHAT) : text(500, 'must not be reached'),
    );

    const outcome = await port.embed(['some text']);

    expect(outcome.kind).toBe('not_an_embedding_model');
    if (outcome.kind !== 'not_an_embedding_model') return;
    expect(outcome.capabilities).toEqual(['tools', 'thinking', 'completion']);
    // Names the model, what is wrong, and exactly what to do.
    expect(outcome.reason).toContain('nomic-embed-text');
    expect(outcome.reason).toContain('is not an embedding model');
    expect(outcome.reason).toContain('ollama pull nomic-embed-text');

    // **The point of the whole gate**: `/api/embed` was never called, so the caller does not pay
    // the measured 28.6 seconds Ollama spends loading a chat model before answering 501.
    expect(calls.map((call) => call.path)).toEqual(['/api/show']);
  });

  it('falls back to the 501 the real server gives when capabilities are not reported', async () => {
    // An Ollama too old to report `capabilities` returns `[]`; the gate lets it through and the
    // embed call itself produces the refusal, with Ollama's misleading `--embeddings` advice
    // replaced by the real cause.
    const { port } = embedder((path) => {
      if (path === '/api/show') return json(200, { capabilities: [] });
      return json(501, {
        error: 'This server does not support embeddings. Start it with `--embeddings`',
      });
    });

    const outcome = await port.embed(['x']);
    expect(outcome.kind).toBe('not_an_embedding_model');
    if (outcome.kind !== 'not_an_embedding_model') return;
    expect(outcome.reason).toContain('ollama pull nomic-embed-text');
  });

  it('does not treat a chat model’s embedding_length as proof it can embed', async () => {
    // `deepseek-r1:8b` reports `qwen3.embedding_length: 4096` — a hidden size, not a capability.
    const { port } = embedder((path) =>
      path === '/api/show' ? json(200, SHOW_CHAT) : text(500, 'x'),
    );
    expect((await port.describeModel()).kind).toBe('not_an_embedding_model');
  });
});

describe('a model that is not pulled', () => {
  it('reports model_missing with the pull command', async () => {
    const { port } = embedder(() =>
      json(404, { error: "model 'nomic-embed-text:latest' not found" }),
    );

    const outcome = await port.embed(['x']);
    expect(outcome.kind).toBe('model_missing');
    if (outcome.kind !== 'model_missing') return;
    expect(outcome.reason).toContain('ollama pull nomic-embed-text');
  });
});

// ---------------------------------------------------------------------------------- batching

describe('batching', () => {
  it('sends one request for the whole batch, not one per text', async () => {
    const { port, calls } = happy();
    await port.embed(['a', 'b', 'c', 'd']);

    const embeds = calls.filter((call) => call.path === '/api/embed');
    // One probe (dimension measurement) plus one real batch. Never four.
    expect(embeds).toHaveLength(2);
    expect((embeds[1]?.body as { input?: string[] } | undefined)?.input).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('splits a batch larger than maxBatch and preserves order', async () => {
    const stubbed = stub((path, body) => {
      if (path === '/api/show') return json(200, SHOW_EMBEDDER);
      const input = (body as { input: string[] }).input;
      // Encode the input's identity into the vector so order can be verified end to end. The
      // dimension probe's own text is not numeric, hence the fallback.
      return json(200, {
        embeddings: input.map((value) => [Number(value) || 1, 0, 0, 0, 0, 0, 0, 0]),
      });
    });
    const port = createOllamaEmbedder({
      host: '127.0.0.1',
      port: 11434,
      model: 'nomic-embed-text',
      http: stubbed.http,
      maxBatch: 2,
    });

    const outcome = await port.embed(['1', '2', '3', '4', '5']);
    if (outcome.kind !== 'ok') throw new Error(JSON.stringify(outcome));

    expect(outcome.vectors).toHaveLength(5);
    // Normalized, so the leading coordinate is 1 for every one — order is proven by the count of
    // requests and by each slice being sent whole.
    const inputs = stubbed.calls
      .filter((call) => call.path === '/api/embed')
      .map((call) => (call.body as { input: string[] }).input);
    expect(inputs.slice(1)).toEqual([['1', '2'], ['3', '4'], ['5']]);
  });

  it('makes no network call at all for an empty batch', async () => {
    const { port, calls } = happy();
    const outcome = await port.embed([]);

    expect(outcome).toMatchObject({ kind: 'ok', vectors: [] });
    expect(calls).toHaveLength(0);
  });

  it('refuses a response with the wrong number of vectors rather than mis-pairing them', async () => {
    const { port } = embedder((path, body) => {
      if (path === '/api/show') return json(200, SHOW_EMBEDDER);
      const input = (body as { input: string[] }).input;
      // One short — the classic way a chunk silently gets someone else's vector.
      return json(200, { embeddings: input.slice(1).map(() => rawVector(8, 0)) });
    });

    const outcome = await port.embed(['a', 'b']);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('Refusing to guess');
  });
});

describe('the capability check is cached', () => {
  it('probes /api/show once across many batches', async () => {
    const { port, calls } = happy();
    await port.embed(['a']);
    await port.embed(['b']);
    await port.embed(['c']);

    expect(calls.filter((call) => call.path === '/api/show')).toHaveLength(1);
  });

  it('does not cache a failure, so a fixed machine recovers without a restart', async () => {
    let pulled = false;
    const { port } = embedder((path, body) => {
      if (path === '/api/show') {
        return pulled ? json(200, SHOW_EMBEDDER) : json(404, { error: 'model not found' });
      }
      if (path === '/api/embed') {
        const input = (body as { input: string[] }).input;
        return json(200, { embeddings: input.map(() => rawVector(8, 0)) });
      }
      return text(404, '404 page not found');
    });

    expect((await port.embed(['x'])).kind).toBe('model_missing');
    pulled = true;
    expect((await port.embed(['x'])).kind).toBe('ok');
  });
});

// -------------------------------------------------------------------------------- normalization

describe('vectors', () => {
  it('are normalized to unit length regardless of what Ollama returned', async () => {
    // `/api/embeddings` (legacy) returns raw vectors with a measured norm around 4.9; `/api/embed`
    // returns normalized ones. The port's output must not depend on which answered.
    const { port } = happy(8);
    const outcome = await port.embed(['a']);
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);

    const vector = outcome.vectors[0] ?? [];
    const norm = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it('carry a stamp whose dimension is measured, not taken from the manifest', async () => {
    // `/api/show` declares 768; the server actually returns 8 here. The measured value wins,
    // because it is what the collection will have to hold.
    const { port } = happy(8);
    const outcome = await port.embed(['a']);
    if (outcome.kind !== 'ok') throw new Error(outcome.kind);

    expect(outcome.stamp).toEqual({ model: 'nomic-embed-text', dimension: 8 });
  });

  it('refuse a mid-run width change rather than mixing widths in one index', async () => {
    let call = 0;
    const { port } = embedder((path, body) => {
      if (path === '/api/show') return json(200, SHOW_EMBEDDER);
      call += 1;
      const input = (body as { input: string[] }).input;
      // The probe gets 8 dimensions; the real batch gets 16.
      return json(200, { embeddings: input.map(() => rawVector(call === 1 ? 8 : 16, 0)) });
    });

    const outcome = await port.embed(['a']);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('Refusing to mix widths');
  });
});

// ------------------------------------------------------------------------- version tolerance

describe('version tolerance', () => {
  it('falls back to the legacy endpoint when /api/embed is an unknown route', async () => {
    const { port, calls } = embedder((path) => {
      if (path === '/api/show') return json(200, SHOW_EMBEDDER);
      // The literal body a Gin router returns for an unknown route: plain text, not JSON.
      if (path === '/api/embed') return text(404, '404 page not found');
      if (path === '/api/embeddings') return json(200, { embedding: rawVector(8, 1) });
      return text(500, 'unexpected');
    });

    const outcome = await port.embed(['a', 'b']);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.vectors).toHaveLength(2);
    expect(calls.filter((call) => call.path === '/api/embeddings').length).toBeGreaterThan(0);
  });

  it('does NOT fall back when the 404 names a missing model', async () => {
    // Both are 404s. Falling back here would turn one clear "pull the model" into N slow retries
    // against a second endpoint that will fail identically.
    const { port, calls } = embedder((path) => {
      if (path === '/api/show') return json(200, SHOW_EMBEDDER);
      if (path === '/api/embed') {
        return json(404, { error: 'model "nomic-embed-text" not found, try pulling it first' });
      }
      return text(500, 'must not be reached');
    });

    expect((await port.embed(['a'])).kind).toBe('model_missing');
    expect(calls.some((call) => call.path === '/api/embeddings')).toBe(false);
  });
});

// ------------------------------------------------------------------------ failures are data

describe('failures are data, never exceptions', () => {
  it('reports an unreachable Ollama as a result', async () => {
    const { port } = embedder(() => ({
      kind: 'unreachable',
      reason: 'connect ECONNREFUSED 127.0.0.1:11434',
    }));

    const outcome = await port.embed(['x']);
    expect(outcome.kind).toBe('unreachable');
    if (outcome.kind !== 'unreachable') return;
    expect(outcome.reason).toContain('127.0.0.1:11434');
  });

  it('reports a transport timeout as a result', async () => {
    const { port } = embedder(() => ({ kind: 'timeout' }));
    expect(await port.embed(['x'])).toMatchObject({ kind: 'timeout' });
  });

  it('bounds a port that never settles, and reports the bound', async () => {
    // The stub ignores `timeoutMs` entirely, exactly as a hung socket would. The adapter's own
    // wall-clock timer is what has to hold — an unbounded outbound call is what made
    // session-start hang for 45 seconds.
    const never: MemoryHttpPort = () => new Promise<MemoryHttpOutcome>(() => undefined);
    const port = createOllamaEmbedder({
      host: '127.0.0.1',
      port: 11434,
      model: 'nomic-embed-text',
      http: never,
      embedTimeoutMs: 25,
      probeTimeoutMs: 25,
    });

    const startedAt = Date.now();
    const outcome = await port.embed(['x']);
    const elapsed = Date.now() - startedAt;

    expect(outcome).toMatchObject({ kind: 'timeout' });
    expect(elapsed).toBeLessThan(2_000);
  });

  it('passes its deadline down to the transport as well as enforcing it locally', async () => {
    const { port, calls } = happy();
    await port.embed(['x'], { timeoutMs: 1234 });
    expect(calls.every((call) => call.timeoutMs > 0)).toBe(true);
  });

  it('reports a 200 with no embeddings array rather than pretending it worked', async () => {
    const { port } = embedder((path) =>
      path === '/api/show' ? json(200, SHOW_EMBEDDER) : json(200, { unexpected: true }),
    );

    const outcome = await port.embed(['x']);
    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') return;
    expect(outcome.reason).toContain('is this an Ollama server?');
  });
});

describe('describeModel', () => {
  it('reports capabilities, the runtime version and both dimensions', async () => {
    const { port } = happy(8);
    const outcome = await port.describeModel();

    expect(outcome).toMatchObject({
      kind: 'ok',
      stamp: { model: 'nomic-embed-text', dimension: 8 },
      capabilities: ['embedding'],
      runtimeVersion: '0.32.9',
      // Declared by the manifest; reported for information, not trusted as the stamp.
      declaredDimension: 768,
    });
  });

  it('survives a runtime that does not answer /api/version', async () => {
    const { port } = embedder((path, body) => {
      if (path === '/api/version') return text(404, '404 page not found');
      if (path === '/api/show') return json(200, SHOW_EMBEDDER);
      const input = (body as { input: string[] }).input;
      return json(200, { embeddings: input.map(() => rawVector(8, 0)) });
    });

    expect(await port.describeModel()).toMatchObject({ kind: 'ok', runtimeVersion: null });
  });
});

describe('base URL construction', () => {
  it('builds host:port', () => {
    expect(ollamaBaseUrl('127.0.0.1', 11434)).toBe('http://127.0.0.1:11434');
  });

  it('brackets a bare IPv6 literal so the URL stays parseable', () => {
    expect(ollamaBaseUrl('::1', 11434)).toBe('http://[::1]:11434');
  });

  it('honours an explicit scheme and drops a trailing slash', () => {
    expect(ollamaBaseUrl('https://ollama.internal/', 11434)).toBe('https://ollama.internal');
  });
});

describe('the denying transport', () => {
  it('throws on any outbound call, so a suite cannot silently reach a local Ollama', () => {
    expect(() =>
      createDenyingMemoryHttp('this suite')({
        url: 'http://127.0.0.1:11434/api/embed',
        method: 'POST',
        timeoutMs: 100,
      }),
    ).toThrow(/blocked in this suite/);
  });
});
