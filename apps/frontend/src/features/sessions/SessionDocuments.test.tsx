import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '../../stores/toast-store.js';
import { SessionDetailPage } from './SessionDetailPage.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeSession,
  mockApi,
  renderWithProviders,
  SESSION_ID,
} from './test-support.js';

/**
 * Export and Context Package from the Session overflow menu (TDS 04 §6.7, TDS 06 §5.5).
 *
 * The suite is organised around the three ways this feature can look right and be wrong:
 *
 *  1. **The export is a client-side download.** If it were a navigation to the route, a `409`
 *     would land on disk as a file called `export.md` containing an error object — and every
 *     assertion about "a file appeared" would still pass.
 *  2. **The package's gap state is read from `relatedContext.gapReason`, never from the
 *     Markdown.** A package whose memory section is degraded looks complete otherwise.
 *  3. **`created` is gated in the menu**, because both endpoints answer `409` there and a menu
 *     entry the operator can only learn about by tripping over it is not a menu entry.
 */

let api: ApiMock;
let blobs: Blob[];
let clicks: { href: string; download: string }[];

const VIEWPORT_HEIGHT = 500;

const EXPORT_DOCUMENT = {
  format: 'markdown',
  filename: 'session-2026-08-12-1c4fa1-Refactor-queue-port.md',
  content: '---\nmcSessionId: 0198\n---\n\n# Refactor queue port\n\n## Transcript\n',
};

function makePackage(overrides: Record<string, unknown> = {}) {
  return {
    content: '# Context package\n\n## 1. Session\n\nRefactor the queue port.\n',
    tokenEstimate: 12_340,
    bytes: 49_360,
    generatedAt: '2026-08-13T09:00:00.000Z',
    relatedContext: {
      resultCount: 4,
      gapReason: null,
      gapDetail: null,
      embeddingModel: 'nomic-embed-text',
    },
    ...overrides,
  };
}

beforeEach(() => {
  blobs = [];
  clicks = [];

  // Virtualizer geometry — the conversation pane is mounted by this page.
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width: 800,
        height: 80,
        top: 0,
        left: 0,
        right: 800,
        bottom: 80,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => VIEWPORT_HEIGHT,
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 800,
  });

  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return `blob:mock/${blobs.length}`;
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push({ href: this.href, download: this.download });
  });

  api = mockApi();
  api.on('GET', `/sessions/${SESSION_ID}/messages`, { body: listBody([]) });
  api.on('GET', `/sessions/${SESSION_ID}/timeline`, { body: listBody([]) });
  api.on('GET', `/sessions/${SESSION_ID}/commits`, { body: listBody([]) });
  api.on('GET', `/sessions/${SESSION_ID}/files`, {
    body: dataBody({
      root: 'D:\\Repos\\MCS',
      files: [],
      totalFiles: 0,
      truncated: false,
      commitsAsOf: null,
      completeness: 'complete',
      completenessReason: null,
    }),
  });
  api.on('GET', '/sessions?state=running', { body: listBody([]) });
  api.on('GET', `/sessions/${SESSION_ID}`, { body: dataBody(makeSession()) });
});

afterEach(() => {
  api.restore();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

async function openOverflowMenu(): Promise<HTMLElement> {
  const user = userEvent.setup();
  await screen.findByRole('heading', { name: /Refactor queue port/ });
  await user.click(screen.getByRole('button', { name: 'More session actions' }));
  return screen.getByRole('menu');
}

// ------------------------------------------------------------------------------------ export

describe('Export', () => {
  it('appears in the overflow menu of a started session', async () => {
    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();

    expect(within(menu).getByRole('menuitem', { name: 'Export' })).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: 'Generate Context Package' }),
    ).toBeInTheDocument();
  });

  it('POSTs the route and turns the answer into a Blob download — never a navigation', async () => {
    const user = userEvent.setup();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    api.on('POST', `/sessions/${SESSION_ID}/export`, { body: dataBody(EXPORT_DOCUMENT) });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Export' }));

    await waitFor(() => expect(blobs).toHaveLength(1));

    // The document arrived as JSON inside the F5.4 envelope and became a file *here*.
    await expect((blobs[0] as Blob).text()).resolves.toBe(EXPORT_DOCUMENT.content);
    expect(clicks[0]?.download).toBe(EXPORT_DOCUMENT.filename);
    expect(clicks[0]?.href).toMatch(/^blob:/);
    expect(openSpy).not.toHaveBeenCalled();

    const post = api.callsTo('/export').find((call) => call.method === 'POST');
    expect(post?.body).toEqual({ format: 'markdown' });
  });

  it('never dispatches through the lifecycle endpoint', async () => {
    const user = userEvent.setup();
    api.on('POST', `/sessions/${SESSION_ID}/export`, { body: dataBody(EXPORT_DOCUMENT) });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Export' }));

    await waitFor(() => expect(blobs).toHaveLength(1));
    // `POST /sessions/{id}/{action}` answers with a Session; parsing an export document as one
    // would "succeed" and put nonsense in the cache.
    for (const wire of ['/archive', '/clone', '/end', '/resume', '/pause', '/start']) {
      expect(api.callsTo(wire)).toHaveLength(0);
    }
  });

  it('surfaces a 409 with the state the Backend refused on, and writes no file', async () => {
    const user = userEvent.setup();
    api.on('POST', `/sessions/${SESSION_ID}/export`, {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'This session has not started, so there is nothing to export yet',
          details: { state: 'created', action: 'export' },
          requestId: 'req-9',
        },
      },
    });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Export' }));

    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((entry) => entry.message.includes('the session is created'))).toBe(true);
    });
    // The whole point of the envelope: an error is an error, not a file named `export.md`.
    expect(blobs).toHaveLength(0);
    expect(clicks).toHaveLength(0);

    // A 409 means the cached Session was stale, so the menu was offering an illegal action.
    // Refetching is what makes that self-correcting rather than permanent.
    await waitFor(() => {
      expect(
        api.callsTo(`/sessions/${SESSION_ID}`).filter((c) => c.method === 'GET').length,
      ).toBeGreaterThan(1);
    });
  });
});

// --------------------------------------------------------------------------- context package

describe('Context Package', () => {
  it('opens a dialog with the Markdown and the two size facts', async () => {
    const user = userEvent.setup();
    api.on('POST', `/sessions/${SESSION_ID}/context-package`, { body: dataBody(makePackage()) });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Generate Context Package' }));

    const dialog = await screen.findByRole('dialog', { name: 'Context package' });
    await waitFor(() =>
      expect(within(dialog).getByTestId('context-package-content')).toHaveTextContent(
        '# Context package',
      ),
    );
    // The artifact exists to be pasted into another context window, so "will it fit" is stated.
    // The group separator is `toLocaleString`'s, so the pattern does not assert a locale.
    expect(within(dialog).getByText(/^~12.340 tokens$/)).toBeInTheDocument();
    expect(within(dialog).getByText('48.2 KB')).toBeInTheDocument();
  });

  it('badges a degraded package from `gapReason`, with `gapDetail` as the tooltip', async () => {
    const user = userEvent.setup();
    api.on('POST', `/sessions/${SESSION_ID}/context-package`, {
      body: dataBody(
        makePackage({
          // The Markdown is deliberately identical to the healthy case: nothing in the document
          // text says "degraded", which is exactly why the field exists.
          relatedContext: {
            resultCount: 0,
            gapReason: 'unavailable',
            gapDetail: 'Semantic retrieval failed while this package was being generated.',
            embeddingModel: null,
          },
        }),
      ),
    });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Generate Context Package' }));

    const gap = await screen.findByTestId('context-package-gap');
    expect(gap).toHaveTextContent(/Related context is incomplete/);
    expect(gap).toHaveTextContent(/the embedding service could not be reached/);
    expect(gap).toHaveAttribute(
      'title',
      'Semantic retrieval failed while this package was being generated.',
    );
    // The Backend's own sentence, visible as well as in the tooltip — a `title` is unreachable
    // by touch and by keyboard.
    expect(gap).toHaveTextContent(/Semantic retrieval failed/);
  });

  it('shows no badge when memory answered — `gapReason: null` is the only whole case', async () => {
    const user = userEvent.setup();
    api.on('POST', `/sessions/${SESSION_ID}/context-package`, { body: dataBody(makePackage()) });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Generate Context Package' }));

    const dialog = await screen.findByRole('dialog', { name: 'Context package' });
    await waitFor(() =>
      expect(within(dialog).getByText(/4 related items from semantic memory/)).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('context-package-gap')).toBeNull();
  });

  it('lets the operator take the whole document away, as a file', async () => {
    const user = userEvent.setup();
    api.on('POST', `/sessions/${SESSION_ID}/context-package`, { body: dataBody(makePackage()) });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Generate Context Package' }));

    const dialog = await screen.findByRole('dialog', { name: 'Context package' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Download .md' })).toBeEnabled(),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Download .md' }));

    expect(blobs).toHaveLength(1);
    await expect((blobs[0] as Blob).text()).resolves.toContain('# Context package');
    // Derived client-side, because §6.7 gives the package no `filename` — and derived the same
    // way the export's is, so the two artifacts of one Session sit together in a Downloads folder.
    expect(clicks[0]?.download).toBe(
      'context-package-2026-08-12-1c4fa1-Refactor-queue-port-to-batch-enqueue.md',
    );
  });

  it('opens immediately with a generating state rather than leaving the menu looking dead', async () => {
    const user = userEvent.setup();

    // A request that never settles. `ApiMock` answers synchronously by design, and what is under
    // test here is precisely the window before an answer exists: the Backend budgets 25 s for
    // semantic retrieval and 10 s for `git status`, and the menu item that started the work has
    // already closed, so without an immediately-opened surface the operator gets nothing at all
    // for up to half a minute.
    const mocked = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes('/context-package')
        ? new Promise<Response>(() => {})
        : mocked(input, init)) as typeof fetch;

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    const menu = await openOverflowMenu();
    await user.click(within(menu).getByRole('menuitem', { name: 'Generate Context Package' }));

    const dialog = await screen.findByRole('dialog', { name: 'Context package' });
    expect(within(dialog).getByText('Generating…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy Markdown' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Download .md' })).toBeDisabled();
  });
});

// -------------------------------------------------------------------------------- the 409 gate

describe('the `created` gate', () => {
  it('offers neither document on a session that has not started', async () => {
    api.on('GET', `/sessions/${SESSION_ID}`, {
      body: dataBody(
        makeSession({
          state: 'created',
          startedAt: null,
          runtime: { ...makeSession().runtime, runtimeSessionId: null },
        }),
      ),
    });

    renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />);
    await screen.findByRole('heading', { name: /Refactor queue port/ });

    // `created` has no overflow entries at all, so the `⋯` trigger itself is absent — the
    // operator never gets the chance to discover the 409.
    expect(screen.queryByRole('button', { name: 'More session actions' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Export' })).toBeNull();
  });
});
