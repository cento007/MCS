import { describe, expect, it, vi } from 'vitest';
import { GithubClient } from './client.js';
import { createDenyingGithubHttp, type GithubHttpOutcome, type GithubHttpPort } from './http.js';

/**
 * The client's failure taxonomy, with no network and no database.
 *
 * Every case here is a condition an operator will actually hit, and the assertion is always the
 * same shape: **a stated `kind` and a message someone can act on** — never a throw, never a
 * generic "sync failed", and never a retry.
 */

const REF = { owner: 'cento007', repo: 'MCS' };
const TOKEN = 'ghp_test_token_value_0123456789';
const NOW = new Date('2026-08-13T09:00:00.000Z');

function stub(...outcomes: GithubHttpOutcome[]): {
  port: GithubHttpPort;
  requests: { url: string; headers: Record<string, string> }[];
} {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let index = 0;

  const port: GithubHttpPort = (request) => {
    requests.push({ url: request.url, headers: { ...request.headers } });
    const outcome = outcomes[Math.min(index, outcomes.length - 1)];
    index += 1;
    /* c8 ignore next */
    if (outcome === undefined) throw new Error('stub exhausted');
    return Promise.resolve(outcome);
  };

  return { port, requests };
}

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): GithubHttpOutcome {
  return { kind: 'response', status, headers, body: JSON.stringify(body) };
}

function client(port: GithubHttpPort): GithubClient {
  return new GithubClient({ http: port, token: TOKEN, now: () => NOW });
}

describe('GithubClient transport', () => {
  it('sends the token as a bearer header and never in the URL', async () => {
    const { port, requests } = stub(response(200, { full_name: 'cento007/MCS' }));

    await client(port).getRepository(REF);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://api.github.com/repos/cento007/MCS');
    expect(requests[0]?.url).not.toContain(TOKEN);
    expect(requests[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.headers['user-agent']).toBe('mission-control');
    expect(requests[0]?.headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('percent-encodes a branch name so it cannot become URL syntax', async () => {
    const { port, requests } = stub(response(200, []));

    await client(port).listCommits(REF, { branch: 'feature/a?b#c', perPage: 10 });

    expect(requests[0]?.url).toContain('sha=feature%2Fa%3Fb%23c');
  });

  it('clamps per_page to GitHub’s own maximum', async () => {
    const { port, requests } = stub(response(200, []));

    await client(port).listCommits(REF, { branch: 'main', perPage: 5_000 });

    expect(requests[0]?.url).toContain('per_page=100');
  });

  it('returns the parsed body on 200', async () => {
    const { port } = stub(response(200, { default_branch: 'main' }));

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toEqual({ default_branch: 'main' });
  });
});

describe('GithubClient failures are data, never throws', () => {
  it('reports an exhausted primary rate limit without retrying', async () => {
    const resetAt = Math.floor(NOW.getTime() / 1000) + 900;
    const { port, requests } = stub({
      kind: 'response',
      status: 403,
      headers: {
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetAt),
      },
      body: JSON.stringify({ message: 'API rate limit exceeded' }),
    });

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('rate_limited');
    expect(result.failure.status).toBe(403);
    expect(result.failure.message).toContain('rate limit exhausted');
    expect(result.failure.message).toContain('0 of 5000 remaining');
    expect(result.failure.retryAfterAt).toBe(new Date(resetAt * 1000).toISOString());
    // One request. Not two, not five with backoff.
    expect(requests).toHaveLength(1);
  });

  it('recognises a 429 with the same headers', async () => {
    const { port } = stub({
      kind: 'response',
      status: 429,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786000000' },
      body: '{}',
    });

    const result = await client(port).getRepository(REF);
    expect(result.ok === false && result.failure.kind).toBe('rate_limited');
  });

  it('distinguishes a secondary rate limit (retry-after, budget not exhausted)', async () => {
    const { port } = stub({
      kind: 'response',
      status: 403,
      headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4321' },
      body: JSON.stringify({ message: 'You have exceeded a secondary rate limit' }),
    });

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('rate_limited');
    expect(result.failure.message).toContain('slow down');
    expect(result.failure.retryAfterAt).toBe('2026-08-13T09:01:00.000Z');
  });

  it('refuses the NEXT call locally while the window is closed, spending no request', async () => {
    // The whole point of the shared budget: a poll over many repositories discovers the
    // exhausted window once instead of once per repository.
    const resetAt = Math.floor(NOW.getTime() / 1000) + 900;
    const { port, requests } = stub({
      kind: 'response',
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
      body: '{}',
    });
    const github = client(port);

    await github.getRepository(REF);
    const second = await github.getRepository({ owner: 'other', repo: 'thing' });

    expect(requests).toHaveLength(1);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.kind).toBe('rate_limited');
    expect(second.failure.message).toContain('without contacting GitHub');
  });

  it('reports a 403 that is not a rate limit as a permission problem', async () => {
    const { port } = stub(
      response(
        403,
        { message: 'Resource not accessible by personal access token' },
        {
          'x-ratelimit-remaining': '4999',
        },
      ),
    );

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('forbidden');
    expect(result.failure.message).toContain('repo');
    expect(result.failure.retryAfterAt).toBeNull();
  });

  it('reports a rejected token as unauthorized with a fix', async () => {
    const { port } = stub(response(401, { message: 'Bad credentials' }));

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unauthorized');
    expect(result.failure.message).toContain('401');
    expect(result.failure.message).toContain('Settings');
  });

  it('reports a deleted or renamed remote as not_found, naming the repository', async () => {
    const { port } = stub(response(404, { message: 'Not Found' }));

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('not_found');
    expect(result.failure.message).toContain('cento007/MCS');
    expect(result.failure.message).toContain('renamed, deleted, or made private');
  });

  it('reports a redirect rather than silently following it', async () => {
    const { port } = stub(response(301, {}));

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('moved');
    expect(result.failure.message).toContain('renamed or transferred');
  });

  it('reports a timeout with the bound it exceeded', async () => {
    const { port } = stub({ kind: 'timeout' });

    const result = await new GithubClient({
      http: port,
      token: TOKEN,
      now: () => NOW,
      timeoutMs: 1_234,
    }).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('timeout');
    expect(result.failure.message).toContain('1234 ms');
  });

  it('reports an unreachable host with the transport’s own words', async () => {
    const { port } = stub({ kind: 'unreachable', reason: 'getaddrinfo ENOTFOUND api.github.com' });

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('unreachable');
    expect(result.failure.message).toContain('ENOTFOUND');
  });

  it('reports a 200 whose body is not JSON as malformed, not as success', async () => {
    const { port } = stub({
      kind: 'response',
      status: 200,
      headers: {},
      body: '<html>captive portal</html>',
    });

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('malformed');
    expect(result.failure.message).toContain('proxy or captive portal');
  });

  it('reports an unexpected status with GitHub’s own message', async () => {
    const { port } = stub(response(500, { message: 'Server Error' }));

    const result = await client(port).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('http_error');
    expect(result.failure.message).toContain('500');
    expect(result.failure.message).toContain('Server Error');
  });
});

describe('the denying port', () => {
  it('throws with the URL it refused, so an accidental call is obvious', () => {
    const deny = createDenyingGithubHttp('a unit test');
    expect(() =>
      deny({ url: 'https://api.github.com/user', headers: {}, timeoutMs: 1 }),
    ).toThrowError(/Outbound GitHub request blocked in a unit test/);
  });

  it('is what a client with no stub would hit', async () => {
    const github = new GithubClient({ http: createDenyingGithubHttp(), token: TOKEN });
    await expect(github.getRepository(REF)).rejects.toThrow(/blocked/);
  });
});

describe('no global fetch is used', () => {
  it('never touches globalThis.fetch', async () => {
    // Structural proof of the injection: the client has no fallback to the ambient transport.
    const spy = vi.spyOn(globalThis, 'fetch');
    const { port } = stub(response(200, {}));

    await client(port).getRepository(REF);

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
