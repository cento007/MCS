import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeMessage, makeTurn } from '../test-support.js';
import { Conversation, findMatches } from './Conversation.js';
import type { TranscriptItem } from './transcript.js';

/**
 * TanStack Virtual renders nothing when its scroll element measures zero, and in jsdom every
 * element measures zero. Stubbing the geometry is therefore not a convenience — without it
 * the virtualizer is *correct* to render an empty window, and the suite would be asserting
 * against a viewport that does not exist.
 *
 * Two different measurements are involved and both have to be stubbed: the virtualizer sizes
 * its **viewport** from `offsetWidth`/`offsetHeight` and each **row** from
 * `getBoundingClientRect()`.
 */
const VIEWPORT_HEIGHT = 500;

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        width: 800,
        height: VIEWPORT_HEIGHT,
        top: 0,
        left: 0,
        right: 800,
        bottom: VIEWPORT_HEIGHT,
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
});

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetWidth');
});

/**
 * The conversation pane's structural contracts: §6.3 virtualization and follow behaviour, and
 * §7.4's streaming accessibility.
 *
 * jsdom has no layout, so the scroll element's geometry is stubbed explicitly. That is not a
 * workaround for the test — it is how the follow/jump rules become assertable at all, since
 * they are entirely functions of `scrollTop`, `scrollHeight` and `clientHeight`.
 */

function stubGeometry(
  element: HTMLElement,
  geometry: { scrollTop: number; scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => geometry.scrollTop,
    set: (value: number) => {
      geometry.scrollTop = value;
    },
  });
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => geometry.scrollHeight,
  });
  Object.defineProperty(element, 'clientHeight', {
    configurable: true,
    get: () => geometry.clientHeight,
  });
}

const noop = (): void => {};

function renderConversation(props: Partial<Parameters<typeof Conversation>[0]> = {}) {
  return render(
    <Conversation
      messages={[makeMessage({ id: 'm-1', ordinal: 1 })]}
      tail={[]}
      streamInterrupted={false}
      hasOlder={false}
      isFetchingOlder={false}
      fetchOlder={noop}
      isPending={false}
      onDiscardPrompt={noop}
      onRetryPrompt={noop}
      announcement=""
      announcementNonce={0}
      {...props}
    />,
  );
}

describe('streaming accessibility (§7.4)', () => {
  it('marks the transcript as an append-only log that never auto-announces', () => {
    renderConversation();
    const log = screen.getByRole('log', { name: 'Session transcript' });
    // `role="log"` conveys the semantics; `aria-live="off"` is what stops a per-token flood.
    expect(log).toHaveAttribute('aria-live', 'off');
  });

  it('carries a separate visually-hidden polite region for boundary announcements', () => {
    renderConversation({ announcement: 'Response complete, 2 tool calls', announcementNonce: 1 });
    const region = screen.getByTestId('transcript-announcer');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveClass('sr-only');
    expect(region).toHaveTextContent('Response complete, 2 tool calls');
    // The announcement lives outside the log, so it cannot be re-read as transcript content.
    expect(
      within(screen.getByRole('log')).queryByText('Response complete, 2 tool calls'),
    ).toBeNull();
  });

  it('marks the streaming message aria-busy while the turn is in flight', () => {
    const tail: TranscriptItem[] = [
      { kind: 'live', key: 'live-1', turn: makeTurn({ status: 'streaming' }), settling: false },
    ];
    renderConversation({ tail });
    expect(screen.getByTestId('streaming-turn')).toHaveAttribute('aria-busy', 'true');
  });

  it('drops aria-busy once the turn is terminated', () => {
    const tail: TranscriptItem[] = [
      { kind: 'live', key: 'live-1', turn: makeTurn({ status: 'terminated' }), settling: false },
    ];
    renderConversation({ tail });
    expect(screen.getByTestId('streaming-turn')).not.toHaveAttribute('aria-busy');
  });

  it('exposes committed assistant turns as focusable articles with a spoken name', () => {
    renderConversation({
      messages: [
        makeMessage({
          id: 'm-1',
          ordinal: 1,
          occurredAt: '2026-08-12T12:03:00.000Z',
          content: [
            { type: 'text', text: 'done' },
            { type: 'tool_use', toolUseId: 't1', toolName: 'Read', input: { file_path: 'a.ts' } },
          ],
        }),
      ],
    });

    const article = screen.getByRole('article', { name: /^Claude, \d\d:\d\d, 1 tool call$/ });
    expect(article).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus to the latest response only when asked', async () => {
    const user = userEvent.setup();
    renderConversation({ messages: [makeMessage({ id: 'm-1', ordinal: 1 })] });

    const article = screen.getByRole('article');
    expect(document.activeElement).not.toBe(article);

    await user.click(screen.getByRole('button', { name: 'Read latest response' }));
    expect(document.activeElement).toBe(article);
  });
});

describe('virtualization and follow behaviour (§6.3)', () => {
  it('renders a bounded window of a long transcript, not every row', () => {
    const messages = Array.from({ length: 400 }, (_, index) =>
      makeMessage({ id: `m-${index}`, ordinal: index + 1 }),
    );
    const { container } = renderConversation({ messages });

    const rendered = container.querySelectorAll('[data-message-id]');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(40);
  });

  it('raises a jump-to-latest chip with a count once the operator scrolls away', () => {
    const messages = [makeMessage({ id: 'm-1', ordinal: 1 })];
    const { rerender } = renderConversation({ messages });

    const scroller = screen.getByTestId('conversation-scroll');
    stubGeometry(scroller, { scrollTop: 0, scrollHeight: 4_000, clientHeight: 500 });
    fireEvent.scroll(scroller);

    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();

    rerender(
      <Conversation
        messages={[...messages, makeMessage({ id: 'm-2', ordinal: 2 })]}
        tail={[]}
        streamInterrupted={false}
        hasOlder={false}
        isFetchingOlder={false}
        fetchOlder={noop}
        isPending={false}
        onDiscardPrompt={noop}
        onRetryPrompt={noop}
        announcement=""
        announcementNonce={0}
      />,
    );

    // The count is "how much happened while I was reading", so it must be in the name.
    expect(screen.getByRole('button', { name: 'Jump to latest, 1 new' })).toBeInTheDocument();
  });

  it('clears the chip when the operator jumps back to the bottom', async () => {
    const user = userEvent.setup();
    const messages = [makeMessage({ id: 'm-1', ordinal: 1 })];
    const { rerender } = renderConversation({ messages });

    const scroller = screen.getByTestId('conversation-scroll');
    stubGeometry(scroller, { scrollTop: 0, scrollHeight: 4_000, clientHeight: 500 });
    fireEvent.scroll(scroller);

    rerender(
      <Conversation
        messages={[...messages, makeMessage({ id: 'm-2', ordinal: 2 })]}
        tail={[]}
        streamInterrupted={false}
        hasOlder={false}
        isFetchingOlder={false}
        fetchOlder={noop}
        isPending={false}
        onDiscardPrompt={noop}
        onRetryPrompt={noop}
        announcement=""
        announcementNonce={0}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Jump to latest, 1 new' }));
    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull();
  });

  it('requests the previous cursor page when scrolled near the top', () => {
    const fetchOlder = vi.fn();
    renderConversation({ hasOlder: true, fetchOlder });

    const scroller = screen.getByTestId('conversation-scroll');
    stubGeometry(scroller, { scrollTop: 10, scrollHeight: 4_000, clientHeight: 500 });
    fireEvent.scroll(scroller);

    expect(fetchOlder).toHaveBeenCalled();
  });

  it('never blanks the transcript when the wire drops mid-turn', () => {
    const tail: TranscriptItem[] = [
      { kind: 'live', key: 'live-1', turn: makeTurn({ status: 'streaming' }), settling: false },
    ];
    renderConversation({ tail, streamInterrupted: true });

    expect(screen.getByText('partial output')).toBeInTheDocument();
    expect(screen.getByText(/stream interrupted — reconnecting/)).toBeInTheDocument();
  });
});

describe('find in transcript (§5.5)', () => {
  it('matches over the full committed set, including tool payloads', () => {
    const messages = [
      makeMessage({ id: 'm-1', ordinal: 1, content: [{ type: 'text', text: 'queue port' }] }),
      makeMessage({
        id: 'm-2',
        ordinal: 2,
        content: [
          { type: 'tool_use', toolUseId: 't1', toolName: 'Read', input: { file_path: 'queue.ts' } },
        ],
      }),
      makeMessage({ id: 'm-3', ordinal: 3, content: [{ type: 'text', text: 'unrelated' }] }),
    ];
    expect(findMatches(messages, 'queue')).toEqual(['m-1', 'm-2']);
    expect(findMatches(messages, '')).toEqual([]);
  });

  it('intercepts Ctrl+F inside the conversation rather than leaving it to the browser', () => {
    renderConversation();
    const region = screen.getByRole('region', { name: 'Conversation' });
    fireEvent.keyDown(region, { key: 'f', ctrlKey: true });
    expect(screen.getByRole('searchbox', { name: 'Find in transcript' })).toBeInTheDocument();
  });
});
