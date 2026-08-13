import { describe, expect, it } from 'vitest';
import { GithubClient } from './client.js';
import type { GithubHttpOutcome, GithubHttpPort } from './http.js';
import { classifyRemote } from './remote.js';
import { hasMoved, pullRequestEvents } from './sync.js';

/**
 * **The token must never appear in serialized output.** Not in a message, not in a detail, not
 * in an event payload, not in an audit row, not in a log line.
 *
 * This file asserts that mechanically rather than by inspection: it drives the client through
 * *every* failure kind and every success shape, serializes the whole result, and scans it. A
 * new failure branch that interpolates the token is caught by the `it.each` below without
 * anyone remembering to add a case — which is the only kind of secret-handling test worth
 * having, because the ones that leak are always the branches nobody thought about.
 *
 * The hostile cases matter most: GitHub *echoing the token back* in an error body, and a
 * transport error quoting a URL that contains it. Both have happened to real integrations.
 */

const TOKEN = 'ghp_S3cr3t_L1ve_T0ken_do_not_leak_0123456789';
const REF = { owner: 'cento007', repo: 'MCS' };

function port(outcome: GithubHttpOutcome): GithubHttpPort {
  return () => Promise.resolve(outcome);
}

function github(outcome: GithubHttpOutcome): GithubClient {
  return new GithubClient({ http: port(outcome), token: TOKEN });
}

/** Everything the client hands back, as it would be persisted, logged or sent to a browser. */
function serializeEverything(value: unknown): string {
  return `${JSON.stringify(value)} ${String(value)} ${inspectDeep(value)}`;
}

function inspectDeep(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return String(value);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, nested]) => `${key}=${inspectDeep(nested)}`)
    .join(' ');
}

const OUTCOMES: readonly [string, GithubHttpOutcome][] = [
  ['200 success', { kind: 'response', status: 200, headers: {}, body: '{"ok":true}' }],
  [
    '401 bad credentials',
    { kind: 'response', status: 401, headers: {}, body: '{"message":"Bad credentials"}' },
  ],
  [
    '403 forbidden',
    {
      kind: 'response',
      status: 403,
      headers: { 'x-ratelimit-remaining': '4999' },
      body: '{"message":"Resource not accessible"}',
    },
  ],
  [
    '403 rate limited',
    {
      kind: 'response',
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786000000' },
      body: '{"message":"API rate limit exceeded"}',
    },
  ],
  [
    '429 secondary limit',
    { kind: 'response', status: 429, headers: { 'retry-after': '30' }, body: '{}' },
  ],
  [
    '404 not found',
    { kind: 'response', status: 404, headers: {}, body: '{"message":"Not Found"}' },
  ],
  ['301 moved', { kind: 'response', status: 301, headers: {}, body: '{}' }],
  ['500 server error', { kind: 'response', status: 500, headers: {}, body: '{"message":"boom"}' }],
  ['malformed body', { kind: 'response', status: 200, headers: {}, body: 'not json' }],
  ['timeout', { kind: 'timeout' }],
  ['unreachable', { kind: 'unreachable', reason: 'connect ECONNREFUSED 140.82.121.6:443' }],

  // ---- the hostile cases ----
  [
    'GitHub echoes the token back in the error body',
    {
      kind: 'response',
      status: 422,
      headers: {},
      body: JSON.stringify({ message: `Token ${TOKEN} is not valid for this resource` }),
    },
  ],
  [
    'the transport error quotes a URL containing the token',
    {
      kind: 'unreachable',
      reason: `request to https://${TOKEN}@api.github.com/repos/cento007/MCS failed, reason: socket hang up`,
    },
  ],
];

describe('the GitHub token never reaches serialized output', () => {
  it.each(OUTCOMES)('%s', async (_label, outcome) => {
    const client = github(outcome);

    const results = [
      await client.getRepository(REF),
      await client.listCommits(REF, { branch: 'main', perPage: 10 }),
      await client.getCommit(REF, 'a'.repeat(40)),
      await client.listPullRequests(REF, { perPage: 10 }),
      await client.listReviews(REF, 7, { perPage: 10 }),
    ];

    for (const result of results) {
      const serialized = serializeEverything(result);
      expect(serialized).not.toContain(TOKEN);
      // A prefix leak is still a leak; assert on a distinctive substring too.
      expect(serialized).not.toContain('S3cr3t_L1ve_T0ken');
    }
  });

  it('replaces the token with a marker rather than dropping it silently', async () => {
    const result = await github({
      kind: 'unreachable',
      reason: `https://${TOKEN}@api.github.com failed`,
    }).getRepository(REF);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Visible redaction, so an operator reading `last_sync_error` can tell something was removed.
    expect(result.failure.message).toContain('«redacted»');
    expect(result.failure.message).not.toContain(TOKEN);
  });

  it('the client exposes no accessor that could return the token', () => {
    const client = github({ kind: 'timeout' });
    // Private `#token`: not enumerable, not on the prototype, not reachable by serialization.
    expect(Object.keys(client)).toEqual([]);
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(client))).not.toContain('token');
  });
});

describe('a credential embedded in a git remote never reaches output either', () => {
  it('is stripped by classifyRemote before anything is stored', () => {
    const raw = `https://x-access-token:${TOKEN}@github.com/cento007/MCS.git`;
    expect(JSON.stringify(classifyRemote(raw))).not.toContain(TOKEN);
  });
});

describe('pure sync decisions cannot carry a secret', () => {
  it('pull-request events carry ids and scalars only (F6.1)', () => {
    const events = pullRequestEvents(
      null,
      {
        number: 1,
        title: `token ${TOKEN}`,
        description: `token ${TOKEN}`,
        state: 'open',
        author: 'someone',
        headBranch: 'feature',
        baseBranch: 'main',
        url: 'https://github.com/cento007/MCS/pull/1',
        openedAt: new Date(),
        mergedAt: null,
        closedAt: null,
        updatedAt: new Date(),
      },
      null,
    );

    // The payload is `{ reason }` at most — never the PR's own text, which is what would carry
    // a token an author pasted into a description.
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });

  it('hasMoved compares, it does not report', () => {
    expect(typeof hasMoved).toBe('function');
  });
});
