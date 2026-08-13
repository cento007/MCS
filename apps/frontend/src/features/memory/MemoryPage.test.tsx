import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryPage } from './MemoryPage.js';
import {
  ADR_ID,
  type ApiMock,
  COMMIT_ID,
  healthBody,
  listBody,
  makeBackfillStatus,
  makeEmptyResponse,
  makeProject,
  makeResult,
  makeSearchResponse,
  mockApi,
  PR_ID,
  PROJECT_ID,
  REPOSITORY_ID,
  renderWithProviders,
  SESSION_ID,
} from './test-support.js';

/**
 * `/memory` — the Memory screen.
 *
 * The suite is organised around the one failure mode that matters: **four things called "empty"
 * that have four different fixes.** Each is asserted to render its own words *and* its own next
 * action, and the two broken cases are asserted to be `role="alert"` rather than empty states —
 * because an operator who reads "the index is not answering" as "no matches for this phrase" will
 * spend their time rephrasing a query that was never run.
 */

let api: ApiMock;

function seedDefaults(mock: ApiMock): void {
  mock.on('GET', '/api/v1/services/health', { body: healthBody(true) });
  mock.on('GET', '/api/v1/memory-items/backfill', {
    body: { data: makeBackfillStatus({ indexedModels: ['nomic-embed-text'] }) },
  });
  mock.on('GET', '/api/v1/projects', { body: listBody([makeProject()]) });
  mock.on('POST', '/api/v1/memory-items/search', { body: { data: makeSearchResponse() } });
}

/** Answer one search with a canned response, whatever the request body says. */
function respondWithSearch(body: unknown): void {
  api.on('POST', '/api/v1/memory-items/search', { body: { data: body } });
}

beforeEach(() => {
  api = mockApi();
  seedDefaults(api);
});

afterEach(() => {
  api.restore();
});

// ---------------------------------------------------------------------------- the four empties

describe('1. not configured — nothing will ever work until Settings is filled in', () => {
  it('says so before a query is typed, from the health read', async () => {
    // An operator should not have to compose a question to be told no embedding model is set.
    api.on('GET', '/api/v1/services/health', { body: healthBody(false) });

    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText(/Memory is not configured/)).toBeInTheDocument();
    expect(screen.getByText(/No embedding model is set/)).toBeInTheDocument();
  });

  it('does not claim "not configured" when the health read merely failed', async () => {
    // `configured: null` is "cannot tell". Rendering it as "not configured" would send someone to
    // Settings to fix something that is not broken.
    api.on('GET', '/api/v1/services/health', {
      status: 500,
      body: { error: { code: 'INTERNAL' } },
    });

    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText(/Ask a question in prose/)).toBeInTheDocument();
    expect(screen.queryByText(/Memory is not configured/)).toBeNull();
  });

  it('sends the operator to Settings and nowhere else', async () => {
    respondWithSearch(
      makeEmptyResponse(
        'not_configured',
        'No embedding model is configured. Set `integrations.qdrant.embeddingModel`.',
        { embeddingModel: null },
      ),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });

    const link = await screen.findByRole('link', { name: /Set an embedding model in Settings/ });
    expect(link).toHaveAttribute('href', '/settings/integrations');
    // The Backend's own sentence, verbatim — it names the exact setting key.
    expect(screen.getByText(/integrations\.qdrant\.embeddingModel/)).toBeInTheDocument();
    // Not an offer to index, and not an offer to rephrase.
    expect(screen.queryByRole('button', { name: /Run a backfill/ })).toBeNull();
  });
});

describe('2. nothing indexed — the next action is to index, not to rephrase', () => {
  it('offers a backfill and says rephrasing will not help', async () => {
    respondWithSearch(
      makeEmptyResponse(
        'index_empty',
        'Nothing is indexed for this scope yet. Run a memory backfill.',
      ),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });

    // Anchored on the glyph so it matches the heading rather than also matching the Backend
    // sentence quoted under it — two nodes saying the same thing is not two assertions.
    expect(await screen.findByText(/◌\s+Nothing is indexed for this scope/)).toBeInTheDocument();
    expect(screen.getByText(/Run a memory backfill/)).toBeInTheDocument();
    expect(screen.getByText(/Rephrasing will not help/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run a backfill' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Set an embedding model/ })).toBeNull();
  });

  it('triggers an incremental run — never a rebuild — from that button', async () => {
    respondWithSearch(makeEmptyResponse('index_empty', 'Nothing is indexed for this scope yet.'));
    api.on('POST', '/api/v1/memory-items/backfill', {
      status: 202,
      body: {
        data: {
          runId: '0198a2f3-9c41-7bd2-a10e-00000000ab01',
          state: 'queued',
          mode: 'incremental',
          createdAt: '2026-08-13T09:00:00.000Z',
        },
      },
    });

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });
    await userEvent.click(await screen.findByRole('button', { name: 'Run a backfill' }));

    await waitFor(() => {
      expect(
        api.callsTo('/api/v1/memory-items/backfill').some((call) => call.method === 'POST'),
      ).toBe(true);
    });
    const post = api
      .callsTo('/api/v1/memory-items/backfill')
      .find((call) => call.method === 'POST');
    // `rebuild` destroys every stored vector; it must never be reachable without a confirm.
    expect(post?.body).toEqual({ mode: 'incremental' });
  });

  it('does not offer a second run while one is already active', async () => {
    respondWithSearch(makeEmptyResponse('index_empty', 'Nothing is indexed for this scope yet.'));
    api.on('GET', '/api/v1/memory-items/backfill', {
      body: {
        data: makeBackfillStatus({
          runId: '0198a2f3-9c41-7bd2-a10e-00000000ab01',
          state: 'running',
          mode: 'incremental',
        }),
      },
    });

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });

    expect(
      await screen.findByRole('button', { name: 'A backfill is already running' }),
    ).toBeDisabled();
  });
});

describe('3. nothing relevant — the query ran and everything scored too low', () => {
  it('surfaces the Backend’s reason, including how many candidates were considered', async () => {
    respondWithSearch(
      makeEmptyResponse(
        'below_threshold',
        'Nothing scored above 0.52. 5 chunks were considered — the closest were not close enough to be worth showing.',
        { candidatesConsidered: 5 },
      ),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=sourdough+bread'] });

    expect(await screen.findByText(/Nothing scored above the relevance floor/)).toBeInTheDocument();
    expect(screen.getByText(/5 chunks were considered/)).toBeInTheDocument();
    // This is the ONE empty answer where rephrasing is the right advice, and it says so.
    expect(screen.getByText(/where rephrasing helps/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run a backfill' })).toBeNull();
  });

  it('offers to drop the floor to 0, which is a request parameter and not a constant', async () => {
    respondWithSearch(makeEmptyResponse('below_threshold', 'Nothing scored above 0.52.'));

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=sourdough'] });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show the closest matches anyway' }),
    );

    await waitFor(() => {
      const bodies = api
        .callsTo('/api/v1/memory-items/search')
        .map((call) => call.body as { minScore?: number });
      expect(bodies.some((body) => body.minScore === 0)).toBe(true);
    });
  });
});

describe('4. broken — the index is not answering, which is not an empty result', () => {
  it('renders an unreachable service as an alert, not as an empty state', async () => {
    respondWithSearch(
      makeEmptyResponse(
        'unavailable',
        'The embedding service could not be reached (connect_failed)',
      ),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Memory search could not run/)).toBeInTheDocument();
    expect(within(alert).getByText(/could not be reached/)).toBeInTheDocument();
    expect(within(alert).getByText(/This is not an empty result/)).toBeInTheDocument();
    expect(within(alert).getByRole('link', { name: /Check service health/ })).toHaveAttribute(
      'href',
      '/settings/services',
    );
  });

  it('renders a stamp mismatch as broken, with a rebuild rather than a rephrase', async () => {
    // The case the whole screen turns on: the collection is reachable and its contents are
    // incomparable with the current model. "No matches" would be actively misleading.
    respondWithSearch(
      makeEmptyResponse(
        'stamp_mismatch',
        'The "mc_memory" collection was built by nomic-embed-text (768) but the configured model produces mxbai-embed-large (1024).',
      ),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/The index cannot be trusted/)).toBeInTheDocument();
    expect(within(alert).getByText(/was built by nomic-embed-text/)).toBeInTheDocument();
    expect(within(alert).getByText(/confident nonsense/)).toBeInTheDocument();
    expect(within(alert).getByRole('button', { name: 'Rebuild the index' })).toBeInTheDocument();
    // Explicitly not an empty state, and explicitly not a phrasing problem.
    expect(screen.queryByText(/Nothing scored above/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Show the closest matches anyway' })).toBeNull();
  });

  it('stops the index panel calling itself healthy while the vectors are unusable', async () => {
    // Observed in the browser: a green "● Indexed with nomic-embed-text" sat directly above the
    // red refusal, because `memory_items.embedding_model` really does hold that name. The rows
    // are not the index — the vectors are.
    respondWithSearch(makeEmptyResponse('stamp_mismatch', 'Collection stamp does not match.'));

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });

    expect(
      await screen.findByText('nomic-embed-text rows stored, none queryable'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Indexed with nomic-embed-text')).toBeNull();
  });

  it('makes a rebuild confirm before destroying every vector', async () => {
    respondWithSearch(makeEmptyResponse('stamp_mismatch', 'Collection stamp does not match.'));
    api.on('POST', '/api/v1/memory-items/backfill', {
      status: 202,
      body: {
        data: {
          runId: '0198a2f3-9c41-7bd2-a10e-00000000ab02',
          state: 'queued',
          mode: 'rebuild',
          createdAt: '2026-08-13T09:00:00.000Z',
        },
      },
    });

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });
    await userEvent.click(await screen.findByRole('button', { name: 'Rebuild the index' }));

    // Nothing has been sent yet — the confirm is the gate, not a formality after the fact.
    expect(
      api.callsTo('/api/v1/memory-items/backfill').filter((call) => call.method === 'POST'),
    ).toHaveLength(0);
    expect(await screen.findByText(/destroys every stored vector/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Rebuild from zero' }));

    await waitFor(() => {
      const post = api
        .callsTo('/api/v1/memory-items/backfill')
        .find((call) => call.method === 'POST');
      expect(post?.body).toEqual({ mode: 'rebuild' });
    });
  });
});

describe('the five outcomes are five different screens', () => {
  const cases = [
    ['not_configured', /Memory is not configured/],
    ['index_empty', /Nothing is indexed for this scope/],
    ['below_threshold', /Nothing scored above the relevance floor/],
    ['unavailable', /Memory search could not run/],
    ['stamp_mismatch', /The index cannot be trusted/],
  ] as const;

  it.each(cases)('%s renders its own words and nobody else’s', async (reason, expected) => {
    respondWithSearch(makeEmptyResponse(reason, 'the backend sentence'));

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=anything'] });

    expect(await screen.findByText(expected)).toBeInTheDocument();
    for (const [otherReason, otherText] of cases) {
      if (otherReason === reason) continue;
      expect(screen.queryByText(otherText)).toBeNull();
    }
    // Not one of them says the generic thing.
    expect(screen.queryByText(/^No results$/)).toBeNull();
  });
});

// ------------------------------------------------------------------------------------ results

describe('results', () => {
  it('renders the score raw, with the floor it was produced under', async () => {
    respondWithSearch(
      makeSearchResponse({ results: [makeResult({ score: 0.6543 })], minScore: 0.52 }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=why+pg-boss'] });

    // Two decimals of the actual cosine — never a percentage.
    expect(await screen.findByText('0.65')).toBeInTheDocument();
    expect(screen.getByText('floor 0.52')).toBeInTheDocument();
    expect(screen.getByText('nomic-embed-text')).toBeInTheDocument();
    expect(screen.queryByText('65%')).toBeNull();
  });

  it('shows enough of the matched text to judge relevance, as text', async () => {
    respondWithSearch(
      makeSearchResponse({
        results: [makeResult({ content: 'Redis has no official native Windows build.' })],
      }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=redis'] });

    expect(
      await screen.findByText(/Redis has no official native Windows build/),
    ).toBeInTheDocument();
    // A vector hit has no matched terms; nothing may be highlighted as if it did.
    expect(document.querySelector('mark')).toBeNull();
  });

  it('links a session hit to its session', async () => {
    respondWithSearch(
      makeSearchResponse({
        results: [
          makeResult({
            sourceType: 'session',
            sourceId: SESSION_ID,
            title: 'Refactor the queue port',
            tier: 'session',
            context: { projectId: PROJECT_ID, repositoryId: null, sessionId: SESSION_ID },
          }),
        ],
      }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=queue'] });

    expect(await screen.findByRole('link', { name: 'Refactor the queue port' })).toHaveAttribute(
      'href',
      `/sessions/${SESSION_ID}`,
    );
  });

  it('links an ADR hit to its ADR', async () => {
    respondWithSearch(
      makeSearchResponse({ results: [makeResult({ sourceType: 'adr', sourceId: ADR_ID })] }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=queue'] });

    expect(await screen.findByRole('link', { name: /ADR-0007/ })).toHaveAttribute(
      'href',
      `/adrs/${ADR_ID}`,
    );
  });

  it('links a commit hit through the session that produced it', async () => {
    respondWithSearch(
      makeSearchResponse({
        results: [
          makeResult({
            sourceType: 'commit',
            sourceId: COMMIT_ID,
            title: '4b4d17e Add the settings backend',
            context: { projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, sessionId: SESSION_ID },
          }),
        ],
      }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=settings'] });

    expect(await screen.findByRole('link', { name: /4b4d17e/ })).toHaveAttribute(
      'href',
      `/sessions/${SESSION_ID}?panel=commits`,
    );
  });

  it('says a pull-request link lands on the repository, because no PR screen exists', async () => {
    respondWithSearch(
      makeSearchResponse({
        results: [
          makeResult({
            sourceType: 'pull_request',
            sourceId: PR_ID,
            title: '#42 Close the relay gap',
            context: { projectId: PROJECT_ID, repositoryId: REPOSITORY_ID, sessionId: null },
          }),
        ],
      }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=relay'] });

    expect(await screen.findByRole('link', { name: /#42 Close the relay gap/ })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}?tab=repositories`,
    );
    expect(screen.getByText(/no screen of their own yet/)).toBeInTheDocument();
  });

  it('renders a vault note with its path and no link at all', async () => {
    respondWithSearch(
      makeSearchResponse({
        results: [
          makeResult({
            sourceType: 'obsidian_note',
            sourceId: null,
            sourceRef: 'Decisions/queue.md',
            title: 'queue',
            tier: 'global',
            context: { projectId: null, repositoryId: null, sessionId: null },
          }),
        ],
      }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=queue'] });

    expect(await screen.findByText('Decisions/queue.md')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'queue' })).toBeNull();
    expect(screen.getByText(/lives in the Obsidian vault/)).toBeInTheDocument();
  });

  it('names which chunk of a long document matched', async () => {
    respondWithSearch(
      makeSearchResponse({ results: [makeResult({ chunkOrdinal: 3, chunkCount: 9 })] }),
    );

    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=queue'] });

    expect(await screen.findByText('chunk 4 of 9')).toBeInTheDocument();
  });
});

// -------------------------------------------------------------------------------------- scope

describe('scope reaches the request', () => {
  it('sends the project id, and says on screen that the query is project-scoped', async () => {
    renderWithProviders(<MemoryPage />, {
      initialEntries: [`/memory?q=queue&project=${PROJECT_ID}`],
    });

    await waitFor(() => {
      expect(api.callsTo('/api/v1/memory-items/search')).toHaveLength(1);
    });
    expect(api.callsTo('/api/v1/memory-items/search')[0]?.body).toMatchObject({
      q: 'queue',
      projectId: PROJECT_ID,
    });

    // Visibly scoped — including the widening the operator cannot infer from the control.
    expect(
      await screen.findByText(/Scoped to project mission-control, plus global memory/),
    ).toBeInTheDocument();
  });

  it('sends tier and source filters, and never an empty list', async () => {
    renderWithProviders(<MemoryPage />, {
      initialEntries: ['/memory?q=queue&tier=session&source=commit'],
    });

    await waitFor(() => {
      expect(api.callsTo('/api/v1/memory-items/search')).toHaveLength(1);
    });
    expect(api.callsTo('/api/v1/memory-items/search')[0]?.body).toEqual({
      q: 'queue',
      limit: 10,
      tiers: ['session'],
      sourceTypes: ['commit'],
    });
  });

  it('re-runs the search when a tier chip is pressed', async () => {
    renderWithProviders(<MemoryPage />, { initialEntries: ['/memory?q=queue'] });

    await waitFor(() => expect(api.callsTo('/api/v1/memory-items/search')).toHaveLength(1));
    await userEvent.click(screen.getByRole('button', { name: 'global' }));

    await waitFor(() => {
      const bodies = api
        .callsTo('/api/v1/memory-items/search')
        .map((call) => call.body as { tiers?: string[] });
      expect(bodies.some((body) => body.tiers?.includes('global') === true)).toBe(true);
    });
  });

  it('disables the tier chips under a session scope, because the Backend overrides them', async () => {
    api.on('GET', `/api/v1/sessions/${SESSION_ID}`, {
      body: { data: { id: SESSION_ID, title: 'Refactor the queue port' } },
    });

    renderWithProviders(<MemoryPage />, {
      initialEntries: [`/memory?q=queue&session=${SESSION_ID}`],
    });

    expect(await screen.findByRole('button', { name: 'session' })).toBeDisabled();
    expect(
      screen.getByText(/session-tier chunks only — a session scope overrides the tier filter/),
    ).toBeInTheDocument();
  });

  it('issues no request at all until something is asked', async () => {
    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText(/Ask a question in prose/)).toBeInTheDocument();
    expect(api.callsTo('/api/v1/memory-items/search')).toHaveLength(0);
  });

  it('puts a submitted query in the URL so the answer is linkable', async () => {
    renderWithProviders(<MemoryPage />);

    await userEvent.type(
      await screen.findByRole('searchbox', { name: /Ask your engineering memory/ }),
      'why pg-boss',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      expect(api.callsTo('/api/v1/memory-items/search')[0]?.body).toMatchObject({
        q: 'why pg-boss',
      });
    });
  });
});

// -------------------------------------------------------------------------------- index state

describe('the index state panel', () => {
  it('says plainly when nothing is indexed', async () => {
    api.on('GET', '/api/v1/memory-items/backfill', { body: { data: makeBackfillStatus() } });

    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('Nothing indexed')).toBeInTheDocument();
    expect(screen.getByText(/No backfill has run on this instance/)).toBeInTheDocument();
  });

  it('names the models the index actually holds', async () => {
    api.on('GET', '/api/v1/memory-items/backfill', {
      body: { data: makeBackfillStatus({ indexedModels: ['nomic-embed-text'] }) },
    });

    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('Indexed with nomic-embed-text')).toBeInTheDocument();
  });

  it('flags rows embedded by a model that is no longer configured', async () => {
    api.on('GET', '/api/v1/memory-items/backfill', {
      body: {
        data: makeBackfillStatus({
          indexedModels: ['nomic-embed-text', 'mxbai-embed-large'],
          rowsFromOtherModels: 412,
        }),
      },
    });

    renderWithProviders(<MemoryPage />);

    expect(
      await screen.findByText(/412 chunks were embedded by a different model/),
    ).toBeInTheDocument();
  });

  it('reports a running backfill as counts and refuses to fake a percentage', async () => {
    api.on('GET', '/api/v1/memory-items/backfill', {
      body: {
        data: makeBackfillStatus({
          runId: '0198a2f3-9c41-7bd2-a10e-00000000ab01',
          state: 'running',
          mode: 'incremental',
          trigger: 'user',
          startedAt: '2026-08-13T09:00:00.000Z',
          indexedModels: ['nomic-embed-text'],
          progress: {
            stage: 'commit',
            cursor: null,
            sourcesSeen: 90,
            sourcesIndexed: 42,
            sourcesSkipped: 3,
            chunksEmbedded: 311,
            chunksDeleted: 0,
            failures: 0,
            lastError: null,
            pruned: 0,
            notesDone: true,
          },
        }),
      },
    });

    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('42 indexed')).toBeInTheDocument();
    expect(screen.getByText('311 chunks')).toBeInTheDocument();
    expect(screen.getByText('at commit')).toBeInTheDocument();
    // The sweep has no denominator, so there is no bar and the panel says why.
    expect(screen.getByText(/These are counts, not a percentage/)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows the failure a run ended on', async () => {
    api.on('GET', '/api/v1/memory-items/backfill', {
      body: {
        data: makeBackfillStatus({
          runId: '0198a2f3-9c41-7bd2-a10e-00000000ab01',
          state: 'failed',
          mode: 'incremental',
          error: 'Ollama stopped responding at chunk 4102',
          completedAt: '2026-08-13T09:20:00.000Z',
        }),
      },
    });

    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText(/Ollama stopped responding/)).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });

  it('reports a failed status read as an error, not as an empty index', async () => {
    api.on('GET', '/api/v1/memory-items/backfill', {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'boom', requestId: 'req-1' } },
    });

    renderWithProviders(<MemoryPage />);

    expect(await screen.findByText('The index state could not be read')).toBeInTheDocument();
    expect(screen.queryByText('Nothing indexed')).toBeNull();
  });
});
