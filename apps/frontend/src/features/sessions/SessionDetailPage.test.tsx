import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../lib/api/index.js';
import { setLiveFlushScheduler, useLiveSessionStore } from '../../stores/live-session-store.js';
import { SessionDetailPage } from './SessionDetailPage.js';
import {
  type ApiMock,
  dataBody,
  listBody,
  makeMessage,
  makeSession,
  mockApi,
  renderWithProviders,
  SESSION_ID,
  setSocketOffline,
} from './test-support.js';

/**
 * The Live Session view, end to end inside the SPA (TDS 05 §6, TDS 06 §5.5).
 *
 * These are the assertions the UX review turned into requirements: a mid-stream failure keeps
 * the partial turn, `[Stop]` is a turn control and not a lifecycle one, typing during a stream
 * is always allowed, and an observed Session offers exactly one honest action.
 */

let api: ApiMock;

const VIEWPORT_HEIGHT = 500;

beforeEach(() => {
  // Virtualizer geometry: the viewport is sized from `offsetHeight`, rows from their rect.
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

  // A synchronous flush scheduler so a delta is observable on the next line rather than on
  // the next animation frame. The batching itself is covered by the store's own suite.
  setLiveFlushScheduler((flush) => flush());

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
  setLiveFlushScheduler(null);
  api.restore();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
});

function delta(patch: Record<string, unknown> = {}): void {
  act(() => {
    useLiveSessionStore.getState().applyDelta({
      sessionId: SESSION_ID,
      messageId: 'm-live',
      blockIndex: 0,
      deltaType: 'text_delta',
      text: 'Now updating the pg-boss driver',
      streamEventType: 'content_block_delta',
      ...patch,
    });
  });
}

async function renderSession(overrides = {}) {
  const harness = renderWithProviders(<SessionDetailPage sessionId={SESSION_ID} />, overrides);
  await screen.findByRole('heading', { name: /Refactor queue port/ });
  return harness;
}

describe('streaming render (§6.2)', () => {
  it('appends text deltas into one live turn without touching the query cache', async () => {
    await renderSession();
    await waitFor(() => expect(api.callsTo('/messages').length).toBeGreaterThan(0));
    const before = api.callsTo('/messages').length;

    delta({ text: 'Now updating ' });
    delta({ text: 'the pg-boss driver' });

    expect(screen.getByTestId('streaming-turn')).toHaveTextContent(
      'Now updating the pg-boss driver',
    );
    // §6.2: deltas never invalidate. A REST refetch per token would be catastrophic, and this
    // is the assertion that catches a well-meaning "just invalidate on every event".
    expect(api.callsTo('/messages')).toHaveLength(before);
  });

  it('patches a second content block rather than concatenating into the first', async () => {
    await renderSession();
    delta({ blockIndex: 0, text: 'first block' });
    delta({ blockIndex: 1, deltaType: 'thinking_delta', text: 'second block' });

    const turn = screen.getByTestId('streaming-turn');
    expect(turn).toHaveTextContent('first block');
    expect(turn).toHaveTextContent('second block');
    expect(within(turn).getByText('Thinking')).toBeInTheDocument();
  });

  it('replaces the buffer with the canonical Message once it exists', async () => {
    const harness = await renderSession();
    delta({ text: 'streamed text' });
    expect(screen.getByTestId('streaming-turn')).toBeInTheDocument();

    api.on('GET', `/sessions/${SESSION_ID}/messages`, {
      body: listBody([
        makeMessage({
          id: 'm-live',
          ordinal: 1,
          content: [{ type: 'text', text: 'committed body' }],
        }),
      ]),
    });

    act(() => {
      useLiveSessionStore.getState().commitTurn(SESSION_ID, 'm-live');
    });

    // The buffer is held while the refetch is in flight — the transcript is never blanked.
    expect(screen.getByText('streamed text')).toBeInTheDocument();

    await act(async () => {
      await harness.queryClient.refetchQueries({
        queryKey: queryKeys.sessions.messages(SESSION_ID),
      });
    });

    await waitFor(() => expect(screen.getByText('committed body')).toBeInTheDocument());
    expect(screen.queryByTestId('streaming-turn')).toBeNull();
    expect(screen.queryByText('streamed text')).toBeNull();
  });

  it('KEEPS the partial turn when the session fails mid-stream', async () => {
    await renderSession();
    delta({ text: 'I will start with the enqueue path' });

    api.on('GET', `/sessions/${SESSION_ID}`, { body: dataBody(makeSession({ state: 'failed' })) });

    act(() => {
      useLiveSessionStore.getState().terminateTurn(SESSION_ID, {
        reason: 'failed',
        at: Date.parse('2026-08-12T14:03:41.000Z'),
        errorCode: 'SESSION_PROCESS_EXIT',
        requestId: '0198a2f3-8b1c',
      });
    });

    // The partial text is the entire triage signal; it stays at normal emphasis, in place.
    expect(screen.getByText(/I will start with the enqueue path/)).toBeInTheDocument();
    expect(screen.getByText(/stream ended here/)).toBeInTheDocument();
    expect(screen.getByText(/SESSION_PROCESS_EXIT/)).toBeInTheDocument();
    // The `requestId` is the operator's bridge from a red rule to the Backend log line.
    expect(screen.getByTitle('Copy request ID')).toHaveTextContent('0198a2f3-8b1c');
  });

  it('marks a dropped wire without blanking the turn', async () => {
    await renderSession();
    delta({ text: 'half a sentence' });

    act(() => setSocketOffline());

    expect(screen.getByText(/half a sentence/)).toBeInTheDocument();
    expect(screen.getByText(/stream interrupted — reconnecting/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/Reconnecting/);
  });
});

describe('[Stop] — a turn control, not a lifecycle one (§6.8)', () => {
  it('is absent until a turn is in flight and replaces [Pause] when it is', async () => {
    await renderSession();

    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();

    delta();

    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });

  it('calls interrupt, causes no F7 transition, and keeps the partial turn', async () => {
    const user = userEvent.setup();
    await renderSession();
    delta({ text: 'mid-turn output' });

    api.on('POST', `/sessions/${SESSION_ID}/interrupt`, {
      body: dataBody({ sessionId: SESSION_ID, messageId: 'm-live' }),
    });

    await user.click(screen.getByRole('button', { name: 'Stop' }));

    await waitFor(() => expect(api.callsTo('/interrupt')).toHaveLength(1));
    // The whole point: `[Stop]` ends the turn, not the process.
    expect(api.callsTo('/pause')).toHaveLength(0);
    expect(api.callsTo('/end')).toHaveLength(0);
    // The header badge still reads the verbatim F7 state it read before the interrupt.
    expect(within(screen.getByRole('banner')).getByTitle('running')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/turn stopped by operator/)).toBeInTheDocument());
    expect(screen.getByText(/mid-turn output/)).toBeInTheDocument();
  });

  it('is bound to Esc from the conversation region', async () => {
    const user = userEvent.setup();
    await renderSession();
    delta();

    api.on('POST', `/sessions/${SESSION_ID}/interrupt`, {
      body: dataBody({ sessionId: SESSION_ID, messageId: null }),
    });

    await user.click(screen.getByTestId('composer-input'));
    // One Esc leaves the composer…
    await user.keyboard('{Escape}');
    expect(api.callsTo('/interrupt')).toHaveLength(0);
    // …a second, now from the conversation region, stops the turn.
    await user.keyboard('{Escape}');
    await waitFor(() => expect(api.callsTo('/interrupt')).toHaveLength(1));
  });
});

describe('typing during a stream (§6.8)', () => {
  it('accepts the prompt as a visibly-pending entry and delivers it when the turn ends', async () => {
    const user = userEvent.setup();
    await renderSession();
    delta();

    api.on('POST', `/sessions/${SESSION_ID}/prompts`, {
      status: 202,
      body: dataBody({ messageId: 'm-user' }),
    });

    await user.click(screen.getByTestId('composer-input'));
    await user.paste('actually, use the batch API');
    await user.keyboard('{Control>}{Enter}{/Control}');

    const pending = await screen.findByTestId('pending-prompt');
    expect(pending).toHaveTextContent('queued — will send when the current turn finishes');
    expect(pending).toHaveTextContent('actually, use the batch API');
    // Not transmitted while the turn is in flight, and never rendered as history.
    expect(api.callsTo('/prompts')).toHaveLength(0);
    expect(screen.getByTestId('transcript-announcer')).toHaveTextContent(
      'Prompt queued, will send when the current turn finishes',
    );

    act(() => {
      useLiveSessionStore.getState().commitTurn(SESSION_ID, 'm-live');
    });

    await waitFor(() => expect(api.callsTo('/prompts')).toHaveLength(1));
    expect(api.callsTo('/prompts')[0]?.body).toEqual({ content: 'actually, use the batch API' });
  });

  it('marks a rejected prompt for retry rather than converting it into fake history', async () => {
    const user = userEvent.setup();
    await renderSession();

    api.on('POST', `/sessions/${SESSION_ID}/prompts`, {
      status: 409,
      body: {
        error: { code: 'SESSION_NOT_RUNNING', message: 'not running', requestId: 'req-9' },
      },
    });

    await user.click(screen.getByTestId('composer-input'));
    await user.paste('a prompt');
    await user.keyboard('{Control>}{Enter}{/Control}');

    const pending = await screen.findByTestId('pending-prompt');
    await waitFor(() => expect(pending).toHaveTextContent('not sent'));
    expect(pending).toHaveTextContent('The session is not running, so it cannot accept a prompt.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Discard this prompt' })).toBeInTheDocument();
  });
});

describe('observed sessions (§5.5)', () => {
  const observed = makeSession({
    sessionType: 'observed',
    observation: {
      channel: 'hooks_only',
      degraded: true,
      reason: 'transcript parse drift',
      driftCount: 4,
      updatedAt: '2026-08-12T12:30:00.000Z',
    },
  });

  it('offers only [Stop observing], with confirm copy that names what keeps running', async () => {
    const user = userEvent.setup();
    api.on('GET', `/sessions/${SESSION_ID}`, { body: dataBody(observed) });
    await renderSession();

    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'End' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Stop observing' }));

    const dialog = await screen.findByRole('dialog', { name: 'Stop observing this session?' });
    expect(dialog).toHaveTextContent(
      'Mission Control will stop recording this session. The Claude Code session in your terminal keeps running.',
    );
  });

  it('renders the degraded-fidelity chip from the resource, not only from a live event', async () => {
    api.on('GET', `/sessions/${SESSION_ID}`, { body: dataBody(observed) });
    await renderSession();

    const chip = screen.getByTestId('degraded-chip');
    expect(chip).toHaveTextContent('Degraded fidelity');
    expect(chip.getAttribute('title')).toContain('Message text may be incomplete');
  });

  it('renders known events rather than a blank conversation while degraded', async () => {
    api.on('GET', `/sessions/${SESSION_ID}`, { body: dataBody(observed) });
    api.on('GET', `/sessions/${SESSION_ID}/messages`, {
      body: listBody([
        makeMessage({
          id: 'm-1',
          ordinal: 1,
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolUseId: 't1',
              toolName: 'Edit',
              input: { file_path: 'queue.ts' },
            },
          ],
        }),
      ]),
    });
    await renderSession();

    // An empty pane reads as "nothing is happening" when the session is in fact working.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /tool Edit, queue.ts/ })).toBeInTheDocument(),
    );
    expect(screen.getByTestId('observed-bar')).toBeInTheDocument();
  });
});

describe('announcements (§7.4)', () => {
  it('announces turn boundaries only — never content', async () => {
    await renderSession();
    // Re-queried every time on purpose: the region is keyed on an announcement nonce, so a
    // repeated message replaces the node rather than mutating it — which is what makes a
    // second identical announcement audible at all.
    const announcement = (): string => screen.getByTestId('transcript-announcer').textContent ?? '';

    expect(announcement()).toBe('');

    delta({ text: 'first token' });
    await waitFor(() => expect(announcement()).toBe('Claude is responding'));

    delta({ text: ' more tokens' });
    // Still exactly the boundary announcement: content deltas never enter this region.
    expect(announcement()).toBe('Claude is responding');

    act(() => {
      useLiveSessionStore.getState().commitTurn(SESSION_ID, 'm-live');
    });
    await waitFor(() => expect(announcement()).toBe('Response complete'));
  });
});
