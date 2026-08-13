import { newId, schema } from '@mc/shared';
import { eq } from 'drizzle-orm';
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
import { MAX_QUERY_NODES } from './parse.js';
import type { SearchResultResource, SearchType } from './types.js';

/**
 * `GET /api/v1/search` end to end (TDS 04 §11) over the real TDS 03 §4.6 index.
 *
 * This tier is not optional for this feature — it is where the feature actually is. Almost
 * nothing here can be proved with a fake store:
 *
 *  - **The ranks are PostgreSQL's.** "A strong `commit` match outranks a weak `session` one" is
 *    a claim about `ts_rank_cd(..., 32)` across two different generated `tsvector` columns with
 *    different weight assignments. A double that returns numbers proves the sort, not the
 *    ranking, and the ranking is the product.
 *  - **The exclusions are the schema's.** Tool Messages are absent because
 *    `messages.search_tsv` is `NULL` for their role — a generated column expression, not a
 *    predicate this code could get wrong or right.
 *  - **The pagination is over real equal ranks.** `ts_rank_cd` produces long runs of identical
 *    values over short documents, which is the exact case a `rank`-only cursor loses rows in.
 *    Only the database generates that distribution honestly.
 *  - **The query syntax is `websearch_to_tsquery`'s.** Quoted phrases, `or` and `-exclusion` are
 *    its behaviour, and stemming means `retries` finds `retry`.
 */

let built: TestApp;
let app: FastifyInstance;
let cookie: string;
let userId: string;
let projectId: string;
let repositoryId: string;

interface Page {
  readonly data: readonly SearchResultResource[];
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

/** A successful search. `query` is appended to `/api/v1/search?`. */
async function search(query: string): Promise<Page> {
  const response = await get(`/api/v1/search?${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Page>();
}

async function failedSearch(query: string): Promise<ErrorBody['error']> {
  const response = await get(`/api/v1/search?${query}`);
  expect(response.statusCode, response.body).toBeGreaterThanOrEqual(400);
  return response.json<ErrorBody>().error;
}

function idsOf(page: Page): string[] {
  return page.data.map((result) => result.id);
}

function typesOf(page: Page): SearchType[] {
  return page.data.map((result) => result.type);
}

function resultOf(page: Page, id: string): SearchResultResource {
  const found = page.data.find((result) => result.id === id);
  if (found === undefined) {
    throw new Error(`No result for ${id}; got ${JSON.stringify(page.data, null, 2)}`);
  }
  return found;
}

// ---------------------------------------------------------------------------- seed factories
//
// Rows are written directly: every producer of this data (the GitHub sync, the Session manager,
// the observed ingest, the Phase 2 ADR generator) has its own coverage, and what is under test
// here is reading. `search_tsv` is never written — it is generated, which is the §4.6 property
// that makes the index unable to drift from the row.

async function seedCommit(input: {
  message: string;
  committedAt?: Date;
  sessionId?: string;
  authorName?: string;
  branch?: string;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.commits)
    .values({
      id,
      repositoryId,
      sha: id.replaceAll('-', '').padEnd(40, '0').slice(0, 40),
      authorName: input.authorName ?? 'Operator',
      authorEmail: 'operator@example.invalid',
      message: input.message,
      branch: input.branch ?? 'main',
      files: [],
      committedAt: input.committedAt ?? new Date('2026-08-10T09:00:00.000Z'),
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    });
  return id;
}

/** A bulk of identical commits, in one statement — seeding 400 rows one at a time is the slow way. */
async function seedManyCommits(count: number, message: string): Promise<string[]> {
  const ids = Array.from({ length: count }, () => newId());
  await testDatabase()
    .db.insert(schema.commits)
    .values(
      ids.map((id) => ({
        id,
        repositoryId,
        sha: id.replaceAll('-', '').padEnd(40, '0').slice(0, 40),
        authorName: 'Operator',
        message,
        branch: 'main',
        files: [],
        committedAt: new Date('2026-08-10T09:00:00.000Z'),
      })),
    );
  return ids;
}

let nextPullRequestNumber = 1;

async function seedPullRequest(input: {
  title: string;
  description?: string;
  openedAt?: Date;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.pullRequests)
    .values({
      id,
      repositoryId,
      number: nextPullRequestNumber++,
      title: input.title,
      description: input.description ?? null,
      state: 'open',
      openedAt: input.openedAt ?? new Date('2026-08-09T09:00:00.000Z'),
    });
  return id;
}

let nextAdrNumber = 1;

async function seedAdr(input: {
  title: string;
  decision?: string;
  context?: string;
  alternatives?: string;
  consequences?: string;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.adrs)
    .values({
      id,
      projectId,
      adrNumber: nextAdrNumber++,
      title: input.title,
      decision: input.decision ?? '',
      context: input.context ?? '',
      alternatives: input.alternatives ?? '',
      consequences: input.consequences ?? '',
    });
  return id;
}

let nextOrdinal = 0;

async function seedMessage(input: {
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  occurredAt?: Date;
  toolName?: string;
}): Promise<string> {
  const id = newId();
  await testDatabase()
    .db.insert(schema.messages)
    .values({
      id,
      sessionId: input.sessionId,
      ordinal: nextOrdinal++,
      role: input.role,
      content: input.content,
      occurredAt: input.occurredAt ?? new Date('2026-08-08T09:00:00.000Z'),
      ...(input.toolName === undefined ? {} : { toolName: input.toolName }),
    });
  return id;
}

async function seedSessionWithNotes(input: {
  title: string | null;
  notes?: string;
  state?: string;
  repositoryId?: string;
}): Promise<string> {
  const id = await seedSession({
    projectId,
    userId,
    title: input.title,
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.repositoryId === undefined ? {} : { repositoryId: input.repositoryId }),
  });

  // `notes` is weight `B` in the Session's generated vector and is not on the shared factory's
  // input — setting it here keeps that factory the Session domain's rather than this suite's.
  if (input.notes !== undefined) {
    await testDatabase()
      .db.update(schema.sessions)
      .set({ notes: input.notes })
      .where(eq(schema.sessions.id, id));
  }
  return id;
}

beforeEach(async () => {
  await truncateAll();
  nextPullRequestNumber = 1;
  nextAdrNumber = 1;
  nextOrdinal = 0;

  const user = await seedUser();
  userId = user.id;
  ({ projectId } = await seedProject());
  repositoryId = await seedRepository(projectId, { localPath: 'D:/tmp/mc-search' });

  built = createTestApp({ cookieSecure: false });
  app = built.app;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { username: user.username, password: user.password },
  });
  cookie = cookieValueFrom(login.headers['set-cookie'], SESSION_COOKIE_NAME);
});

describe('GET /api/v1/search — the five branches', () => {
  it('finds every entity type and labels each with its own singular discriminator', async () => {
    // One recognisable term, planted once in each of the five searchable tables.
    const sessionId = await seedSessionWithNotes({
      title: 'Investigate quesadilla throughput',
    });
    const adrId = await seedAdr({
      title: 'Adopt quesadilla batching',
      decision: 'We will batch quesadilla writes.',
    });
    const commitId = await seedCommit({ message: 'Add quesadilla batching\n\nDetails follow.' });
    const pullRequestId = await seedPullRequest({
      title: 'Batch quesadilla writes',
      description: 'Implements the quesadilla batching decision.',
    });
    const conversationId = await seedSession({ projectId, userId, title: 'Chat' });
    const messageId = await seedMessage({
      sessionId: conversationId,
      role: 'assistant',
      content: 'The quesadilla batching change looks correct to me.',
    });

    const page = await search('q=quesadilla');

    expect(typesOf(page).sort()).toEqual(['adr', 'commit', 'message', 'pull_request', 'session']);
    expect(idsOf(page).sort()).toEqual(
      [sessionId, adrId, commitId, pullRequestId, messageId].sort(),
    );
    expect(resultOf(page, sessionId).type).toBe('session');
    expect(resultOf(page, adrId).type).toBe('adr');
    expect(resultOf(page, commitId).type).toBe('commit');
    expect(resultOf(page, pullRequestId).type).toBe('pull_request');
    expect(resultOf(page, messageId).type).toBe('message');
  });

  it('titles each result from its own branch, not from a generic column', async () => {
    await seedSessionWithNotes({ title: null, notes: 'quesadilla notes only' });
    await seedAdr({ title: 'Adopt quesadilla batching' });
    await seedCommit({ message: 'Add quesadilla batching\n\nA body nobody wants in a title.' });
    await seedPullRequest({ title: 'Batch quesadilla writes' });
    const conversationId = await seedSession({ projectId, userId, title: 'Chat' });
    await seedMessage({
      sessionId: conversationId,
      role: 'assistant',
      content: 'quesadilla batching',
    });

    const page = await search('q=quesadilla');
    const titles = new Map(page.data.map((result) => [result.type, result.title]));

    expect(titles.get('session')).toBe('(untitled session)');
    expect(titles.get('adr')).toBe('ADR-0001 — Adopt quesadilla batching');
    // The commit *subject* — the first line — never the whole message.
    expect(titles.get('commit')).toBe('Add quesadilla batching');
    expect(titles.get('pull_request')).toBe('#1 Batch quesadilla writes');
    expect(titles.get('message')).toBe('assistant message');
  });

  it('prunes branches to `?types=`', async () => {
    await seedSessionWithNotes({ title: 'quesadilla session' });
    const commitId = await seedCommit({ message: 'quesadilla commit' });
    await seedAdr({ title: 'quesadilla adr' });

    const page = await search('q=quesadilla&types=commit');

    expect(idsOf(page)).toEqual([commitId]);
  });

  it('accepts several types in either order', async () => {
    await seedSessionWithNotes({ title: 'quesadilla session' });
    await seedCommit({ message: 'quesadilla commit' });
    await seedAdr({ title: 'quesadilla adr' });

    const forwards = await search('q=quesadilla&types=session,commit');
    const backwards = await search('q=quesadilla&types=commit,session');

    expect(idsOf(forwards)).toEqual(idsOf(backwards));
    expect(new Set(typesOf(forwards))).toEqual(new Set(['session', 'commit']));
  });

  it('excludes archived Sessions (§4.6), and says so by omission rather than by error', async () => {
    const live = await seedSessionWithNotes({ title: 'quesadilla planning' });
    await seedSessionWithNotes({ title: 'quesadilla planning', state: 'archived' });

    const page = await search('q=quesadilla&types=session');

    expect(idsOf(page)).toEqual([live]);
  });
});

describe('GET /api/v1/search — ranking across branches', () => {
  it('lets a strong commit match outrank a weak session match', async () => {
    // This is the property the `32` normalization flag exists for. The two ranks come from
    // different tables, different weight classes (commit message = A, session notes = B) and
    // different documents; only `rank/(rank+1)` puts them on one scale.
    //
    // Commit: both terms, adjacent, twice — maximum cover density at weight A.
    const commitId = await seedCommit({
      message: 'Fix checkout latency\n\nThe checkout latency regression is gone.',
    });
    // Session: both terms present but far apart, at weight B (notes), in a long document.
    const sessionId = await seedSessionWithNotes({
      title: 'Sprint planning',
      notes: `checkout ${'filler word here. '.repeat(40)} latency`,
    });

    const page = await search('q=checkout latency&types=commit,session');

    expect(idsOf(page)).toEqual([commitId, sessionId]);
    expect(resultOf(page, commitId).rank).toBeGreaterThan(resultOf(page, sessionId).rank);
  });

  it('normalises every rank into (0,1) so the merged ordering means something', async () => {
    await seedCommit({ message: 'quesadilla quesadilla quesadilla' });
    await seedSessionWithNotes({ title: 'quesadilla', notes: 'quesadilla' });
    await seedAdr({ title: 'quesadilla', decision: 'quesadilla' });
    const conversationId = await seedSession({ projectId, userId, title: 'Chat' });
    await seedMessage({ sessionId: conversationId, role: 'user', content: 'quesadilla' });
    await seedPullRequest({ title: 'quesadilla', description: 'quesadilla' });

    const page = await search('q=quesadilla');

    expect(page.data).toHaveLength(5);
    for (const result of page.data) {
      expect(result.rank, `${result.type} rank`).toBeGreaterThan(0);
      expect(result.rank, `${result.type} rank`).toBeLessThan(1);
    }
  });

  it('returns results in descending rank order', async () => {
    await seedCommit({ message: 'retry retry retry budget budget' });
    await seedCommit({ message: `retry ${'noise '.repeat(60)} budget` });
    await seedAdr({ title: 'retry budget', decision: 'retry budget policy' });
    await seedSessionWithNotes({ title: 'Something else', notes: `budget ${'x '.repeat(80)}` });

    const page = await search('q=retry budget');
    const ranks = page.data.map((result) => result.rank);

    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});

describe('GET /api/v1/search — websearch_to_tsquery syntax', () => {
  beforeEach(async () => {
    await seedCommit({ message: 'Fix the checkout latency regression' });
    await seedCommit({ message: 'Latency in the checkout of the reporting job' });
    await seedCommit({ message: 'Unrelated: bump the linter' });
  });

  it('ANDs bare terms', async () => {
    const page = await search('q=checkout latency');

    expect(page.data).toHaveLength(2);
  });

  it('honours a quoted phrase as an adjacency constraint', async () => {
    // Both commits contain both words; only one has them adjacent in this order.
    const page = await search(`q=${encodeURIComponent('"checkout latency"')}`);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.title).toBe('Fix the checkout latency regression');
  });

  it('honours `or`', async () => {
    const page = await search(`q=${encodeURIComponent('linter or checkout')}`);

    expect(page.data).toHaveLength(3);
  });

  it('honours `-exclusion`', async () => {
    const page = await search(`q=${encodeURIComponent('latency -reporting')}`);

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.title).toBe('Fix the checkout latency regression');
  });

  it('stems, because `pg_catalog.english` is the pinned configuration', async () => {
    await seedAdr({ title: 'Retry policy', decision: 'We retry idempotent requests.' });

    expect((await search('q=retries&types=adr')).data).toHaveLength(1);
    expect((await search('q=retrying&types=adr')).data).toHaveLength(1);
  });

  it('answers junk with an empty list rather than a syntax error', async () => {
    // `to_tsquery` would raise on every one of these; `websearch_to_tsquery` is pinned in §4.6
    // precisely so a search box cannot 500.
    for (const q of ['&&&', '((', ':*', '!', '<->', 'the and of']) {
      const page = await search(`q=${encodeURIComponent(q)}`);
      expect(page.data, q).toEqual([]);
      expect(page.meta.nextCursor, q).toBeNull();
    }
  });

  it('returns an empty list, not a 404, when nothing matches', async () => {
    const page = await search('q=zzzznothingmatchesthis');

    expect(page.data).toEqual([]);
    expect(page.meta.nextCursor).toBeNull();
    expect(page.meta.limit).toBe(50);
  });
});

describe('GET /api/v1/search — snippets', () => {
  it('marks the matched terms', async () => {
    await seedCommit({ message: 'Fix the checkout latency regression in the payment path' });

    const page = await search('q=checkout latency');

    expect(page.data[0]?.snippet).toContain('<mark>checkout</mark>');
    expect(page.data[0]?.snippet).toContain('<mark>latency</mark>');
  });

  it('escapes browser-executable markup that ts_headline passes through verbatim', async () => {
    // This is not hypothetical. PostgreSQL's text-search parser recognises *some* HTML as a
    // `tag` token and drops it from the headline, which is exactly what makes the hole easy to
    // miss — a well-formed `<img src=x onerror="…">` disappears and the feature looks safe.
    // Its tag grammar is far stricter than a browser's, so markup it does not recognise is
    // copied through **verbatim**:
    //
    //   'Reject <img src=x onerror=alert(1) quesadilla in the body'
    //     -> 'Reject <img src=x onerror=alert(1) <mark>quesadilla</mark> in the body'
    //
    // Under §4.6's literal `StartSel=<mark>` that is a stored XSS in a field the client is
    // required to render as HTML. Both payloads below survive PostgreSQL untouched.
    await seedAdr({
      title: 'Sanitisation policy',
      decision: 'Reject <img src=x onerror=alert(1) quesadilla in the body',
    });
    await seedCommit({ message: 'quesadilla <svg/onload=alert(1)> in the renderer' });

    const page = await search('q=quesadilla&types=adr,commit');
    expect(page.data).toHaveLength(2);

    for (const result of page.data) {
      expect(result.snippet, result.type).toContain('<mark>quesadilla</mark>');
      expect(result.snippet, result.type).not.toContain('<img');
      expect(result.snippet, result.type).not.toContain('<svg');
      // Nothing but `<mark>`/`</mark>` may remain once the highlights are removed.
      const bare = result.snippet.replaceAll('<mark>', '').replaceAll('</mark>', '');
      expect(bare, result.type).not.toMatch(/[<>]/);
    }

    expect(resultOf(page, page.data[0]?.id ?? '').snippet).toContain('&lt;');
  });

  it('escapes bare `<`, `>` and `&` — the characters no tag grammar protects', async () => {
    await seedCommit({ message: 'quesadilla sizing: 5<6 && a&b are "fine"' });

    const snippet = (await search('q=quesadilla&types=commit')).data[0]?.snippet ?? '';

    expect(snippet).toContain('<mark>quesadilla</mark>');
    expect(snippet).toContain('5&lt;6');
    expect(snippet).toContain('&amp;&amp;');
    // The closing quote falls outside the `MaxWords=18` fragment, which is the point: the
    // snippet is a bounded excerpt, and every character that *is* in it is escaped.
    expect(snippet).toContain('&quot;fine');
    expect(snippet.replaceAll('<mark>', '').replaceAll('</mark>', '')).not.toMatch(/[<>]/);
  });

  it('degrades to a stray mark, never to markup, if the corpus contains the sentinel', async () => {
    await seedCommit({ message: '<<<mc-hl>>> literal quesadilla sentinel in source' });

    const snippet = (await search('q=quesadilla&types=commit')).data[0]?.snippet ?? '';

    expect(snippet).toContain('<mark>quesadilla</mark>');
    expect(snippet.replaceAll('<mark>', '').replaceAll('</mark>', '')).not.toMatch(/[<>]/);
  });

  it('produces a snippet even when the match was on metadata the snippet cannot show', async () => {
    // `author_name`/`branch` are weight D and are not part of the commit's headline source, so
    // this row matches with nothing to highlight. It must still carry readable text.
    await seedCommit({
      message: 'Routine dependency bump',
      authorName: 'quesadilla-bot',
    });

    const page = await search('q=quesadilla&types=commit');

    expect(page.data).toHaveLength(1);
    expect(page.data[0]?.snippet).toContain('Routine dependency bump');
  });
});

describe('GET /api/v1/search — reachability', () => {
  it('carries the identifiers each result type needs to be linked', async () => {
    const conversationId = await seedSession({ projectId, userId, title: 'Chat' });
    const messageId = await seedMessage({
      sessionId: conversationId,
      role: 'user',
      content: 'quesadilla please',
    });
    const commitId = await seedCommit({
      message: 'quesadilla commit',
      sessionId: conversationId,
    });
    const pullRequestId = await seedPullRequest({ title: 'quesadilla pr' });
    const adrId = await seedAdr({ title: 'quesadilla adr' });
    const sessionId = await seedSessionWithNotes({ title: 'quesadilla session', repositoryId });

    const page = await search('q=quesadilla');

    // A Message is only rendered inside /sessions/:sessionId — without this it is unlinkable.
    expect(resultOf(page, messageId).context).toEqual({
      projectId,
      repositoryId: null,
      sessionId: conversationId,
    });
    // A commit is rendered under its Repository (and its Repository under its Project); when it
    // came from a Session it is also in that Session's Commits panel.
    expect(resultOf(page, commitId).context).toEqual({
      projectId,
      repositoryId,
      sessionId: conversationId,
    });
    expect(resultOf(page, pullRequestId).context).toEqual({
      projectId,
      repositoryId,
      sessionId: null,
    });
    expect(resultOf(page, adrId).context).toEqual({
      projectId,
      repositoryId: null,
      sessionId: null,
    });
    expect(resultOf(page, sessionId).context).toEqual({
      projectId,
      repositoryId,
      sessionId: null,
    });
  });

  it('reports `occurredAt` from each branch’s own time column, as ISO 8601 UTC', async () => {
    const commitId = await seedCommit({
      message: 'quesadilla commit',
      committedAt: new Date('2026-03-04T05:06:07.000Z'),
    });

    expect(resultOf(await search('q=quesadilla'), commitId).occurredAt).toBe(
      '2026-03-04T05:06:07.000Z',
    );
  });
});

describe('GET /api/v1/search — tool messages', () => {
  it('never returns a tool Message, even when its content matches', async () => {
    const sessionId = await seedSession({ projectId, userId, title: 'Chat' });
    const conversational = await seedMessage({
      sessionId,
      role: 'assistant',
      content: 'I will read the quesadilla config now.',
    });
    // The same term in a tool payload, which is the volume that would otherwise dominate.
    await seedMessage({
      sessionId,
      role: 'tool',
      content: 'quesadilla quesadilla quesadilla quesadilla quesadilla',
      toolName: 'Read',
    });
    await seedMessage({ sessionId, role: 'system', content: 'quesadilla system prompt' });

    const page = await search('q=quesadilla&types=message');

    expect(idsOf(page)).toEqual([conversational]);
  });
});

describe('GET /api/v1/search — pagination', () => {
  /** Walk every page, following `nextCursor`, and return the ids in order. */
  async function walk(query: string, limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 50; page += 1) {
      const suffix: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
      const body: Page = await search(`${query}&limit=${limit}${suffix}`);

      seen.push(...idsOf(body));
      cursor = body.meta.nextCursor;
      if (cursor === null) return seen;
    }
    throw new Error('Pagination did not terminate');
  }

  it('walks to exhaustion with no overlap and no drop, across equal ranks', async () => {
    // Identical documents produce identical `ts_rank_cd` values, so the whole set is one rank
    // tie and the cursor is carried entirely by `(occurredAt, id)`. A rank-only cursor returns
    // page one forever here; a `(rank, occurredAt)` cursor loses the rows sharing an instant.
    const identical: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      identical.push(await seedCommit({ message: 'quesadilla batching change' }));
    }
    // …and a batch that also shares one `committed_at`, which is what a backfill sync writes.
    for (let index = 0; index < 6; index += 1) {
      identical.push(
        await seedCommit({
          message: 'quesadilla batching change',
          committedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      );
    }

    const walked = await walk('q=quesadilla&types=commit', 4);

    expect(walked).toHaveLength(identical.length);
    expect(new Set(walked).size).toBe(identical.length);
    expect([...walked].sort()).toEqual([...identical].sort());
  });

  it('walks a mixed-type result set in one relevance order', async () => {
    const expected: string[] = [];
    for (let index = 0; index < 4; index += 1) {
      expected.push(await seedCommit({ message: `quesadilla commit ${index}` }));
      expected.push(await seedAdr({ title: `quesadilla adr ${index}` }));
      expected.push(await seedPullRequest({ title: `quesadilla pr ${index}` }));
      expected.push(await seedSessionWithNotes({ title: `quesadilla session ${index}` }));
    }

    const walked = await walk('q=quesadilla', 3);

    expect(new Set(walked).size).toBe(expected.length);
    expect([...walked].sort()).toEqual([...expected].sort());
  });

  it('agrees with an unpaginated read of the same search', async () => {
    for (let index = 0; index < 7; index += 1) {
      await seedCommit({ message: `quesadilla ${'again '.repeat(index)}change` });
    }

    const whole = idsOf(await search('q=quesadilla&types=commit&limit=50'));

    expect(await walk('q=quesadilla&types=commit', 2)).toEqual(whole);
  });

  it('returns `nextCursor: null` on a partial page, so a client stops without an empty fetch', async () => {
    await seedCommit({ message: 'quesadilla one' });
    await seedCommit({ message: 'quesadilla two' });

    const page = await search('q=quesadilla&types=commit&limit=10');

    expect(page.data).toHaveLength(2);
    expect(page.meta.nextCursor).toBeNull();
  });

  it('rejects a cursor once `q` changes', async () => {
    for (let index = 0; index < 4; index += 1) {
      await seedCommit({ message: 'quesadilla batching change' });
    }

    const first = await search('q=quesadilla&types=commit&limit=2');
    expect(first.meta.nextCursor).not.toBeNull();
    const cursor = encodeURIComponent(first.meta.nextCursor ?? '');

    const error = await failedSearch(`q=batching&types=commit&limit=2&cursor=${cursor}`);

    expect(error.code).toBe('INVALID_CURSOR');
    expect(error.details).toMatchObject({ invalidatedBy: ['q', 'types'] });
  });

  it('rejects a cursor once `types` changes', async () => {
    for (let index = 0; index < 4; index += 1) {
      await seedCommit({ message: 'quesadilla batching change' });
      await seedAdr({ title: 'quesadilla batching decision' });
    }

    const first = await search('q=quesadilla&types=commit&limit=2');
    const cursor = encodeURIComponent(first.meta.nextCursor ?? '');

    expect(
      (await failedSearch(`q=quesadilla&types=commit,adr&limit=2&cursor=${cursor}`)).code,
    ).toBe('INVALID_CURSOR');
    // …and is still accepted for the search that produced it.
    await search(`q=quesadilla&types=commit&limit=2&cursor=${cursor}`);
  });

  it('accepts a cursor when only the type *order* changed — same search, same fingerprint', async () => {
    for (let index = 0; index < 4; index += 1) {
      await seedCommit({ message: 'quesadilla batching change' });
      await seedAdr({ title: 'quesadilla batching decision' });
    }

    const first = await search('q=quesadilla&types=commit,adr&limit=2');
    const cursor = encodeURIComponent(first.meta.nextCursor ?? '');

    const second = await search(`q=quesadilla&types=adr,commit&limit=2&cursor=${cursor}`);

    expect(second.data).toHaveLength(2);
    expect(idsOf(second).some((id) => idsOf(first).includes(id))).toBe(false);
  });
});

describe('GET /api/v1/search — request validation', () => {
  it('rejects an unknown `types` value with VALIDATION_FAILED and names it', async () => {
    const error = await failedSearch('q=quesadilla&types=session,recipe');

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toMatchObject({ parameter: 'types', rejected: ['recipe'] });
  });

  it('rejects the withdrawn plural spelling rather than searching everything', async () => {
    await seedSessionWithNotes({ title: 'quesadilla session' });

    const error = await failedSearch('q=quesadilla&types=sessions');

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toMatchObject({ rejected: ['sessions'] });
  });

  it('requires `q`', async () => {
    expect((await failedSearch('types=session')).code).toBe('VALIDATION_FAILED');
    expect((await failedSearch('q=')).code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown query parameter rather than dropping it', async () => {
    // The house rule (`http/query-strictness.ts`): a dropped filter answers a question nobody
    // asked. `type=` singular is the plausible typo this catches.
    const error = await failedSearch('q=quesadilla&type=commit');

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toMatchObject({ unknownParameters: ['type'] });
  });

  it('rejects a `q` longer than the route bound', async () => {
    expect((await failedSearch(`q=${'a'.repeat(300)}`)).code).toBe('VALIDATION_FAILED');
  });

  it('rejects a query with more terms than the node budget', async () => {
    // 40 terms is 149 characters — comfortably inside the route's 256-character bound — and
    // parses to 79 tsquery nodes. That gap is why there are two bounds: the character cap does
    // not bound the tsquery, and the tsquery is what costs.
    const q = Array.from({ length: 40 }, (_, index) => `t${index}`).join(' ');
    expect(q.length).toBeLessThan(256);

    const error = await failedSearch(`q=${encodeURIComponent(q)}`);

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.details).toMatchObject({ parameter: 'q', maxQueryNodes: MAX_QUERY_NODES });
  });

  it('clamps `limit` to the F5.3 default when omitted', async () => {
    await seedCommit({ message: 'quesadilla' });

    expect((await search('q=quesadilla')).meta.limit).toBe(50);
  });

  it('requires authentication', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/search?q=quesadilla' });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorBody>().error.code).toBe('UNAUTHORIZED');
  });
});

describe('GET /api/v1/search — the statement timeout', () => {
  it('is enforced by PostgreSQL, not merely written down', async () => {
    // A second app over the *same* database, differing only in its budget. Auth is DB-backed
    // (F5.5), so the cookie minted in `beforeEach` authenticates here too.
    const bounded = createTestApp({ cookieSecure: false, searchTimeoutMs: 1 });

    // The work has to be unambiguously larger than the budget, or the test is a race against
    // query planning rather than an assertion about the timeout. 150 documents of ~6 KB each,
    // all requested on one page, means `ts_headline` re-parses ~900 KB of text — tens of
    // milliseconds against a 1 ms budget, not a coin flip. (A handful of tiny rows finishes
    // inside 1 ms often enough to flake, which is exactly what the first draft of this test did.)
    const message = `quesadilla batching change ${'lorem ipsum dolor sit amet '.repeat(220)}`;
    await seedManyCommits(150, message);

    const response = await bounded.app.inject({
      method: 'GET',
      url: '/api/v1/search?q=quesadilla&limit=150',
      headers: auth(),
    });

    expect(response.statusCode).toBe(500);
    const error = response.json<ErrorBody>().error;
    expect(error.code).toBe('INTERNAL');
    expect(error.details).toMatchObject({ timeoutMs: 1 });
    // Actionable, and carrying no SQL and no server internals.
    expect(error.message).toContain('more specific');
    expect(error.message).not.toContain('SELECT');

    // The budget is `SET LOCAL`, so it dies with its transaction: the pooled connection it ran
    // on must not carry a 1 ms timeout into the next request. This is the same query over the
    // same rows, through the default-budget app, answering normally.
    expect((await search('q=quesadilla&types=commit&limit=150')).data).toHaveLength(150);
  });
});
