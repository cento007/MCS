import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Skeleton } from '../../../components/Skeleton.js';
import type { Message } from '../../../lib/api/index.js';
import { MessageItem } from './MessageItem.js';
import { PendingPromptItem } from './PendingPromptItem.js';
import { StreamingTurn } from './StreamingTurn.js';
import { indexToolResults, messageText, readString, type TranscriptItem } from './transcript.js';

/**
 * The conversation pane (TDS 05 §6.3, TDS 06 §5.5, §7.4).
 *
 * Four behaviours here are specification, not taste:
 *
 *  1. **Virtualized with dynamic measurement.** Chat rows vary from one line to a thousand
 *     lines of tool output, so fixed-height windowing is not an option and rendering
 *     everything is not either — observed transcripts reach thousands of Messages.
 *  2. **The live tail renders *outside* the measured set** (§6.3). It changes size on every
 *     frame; measuring it 60 times a second would defeat the virtualizer it lives in.
 *  3. **Streaming never yanks the scroll position.** Auto-follow engages only while the
 *     operator is already at the bottom; scrolling up disengages it and raises a
 *     `[↓ Jump to latest (n new)]` chip, so reading history is never interrupted by output.
 *  4. **`role="log"` + `aria-live="off"`** on the transcript, with boundary announcements
 *     going to a separate polite region owned by the caller (§7.4 items 1–2).
 */

export interface ConversationProps {
  /** Committed Messages, ascending `ordinal` — the virtualized set. */
  readonly messages: readonly Message[];
  /** Live turn + pending prompts, rendered unmeasured after the virtualized set. */
  readonly tail: readonly TranscriptItem[];
  readonly streamInterrupted: boolean;
  readonly hasOlder: boolean;
  readonly isFetchingOlder: boolean;
  readonly fetchOlder: () => void;
  readonly isPending: boolean;
  readonly onDiscardPrompt: (clientRef: string) => void;
  readonly onRetryPrompt: (clientRef: string) => void;
  /** Announcement text for the visually-hidden polite region (§7.4 item 2). */
  readonly announcement: string;
  readonly announcementNonce: number;
  /** Handed a scroll-to-timestamp function so the right panel can index into the transcript. */
  readonly onScrollHandle?: (scrollToTime: (isoTimestamp: string) => boolean) => void;
}

/** How close to the bottom still counts as "following" (px). */
const FOLLOW_THRESHOLD_PX = 64;
/** Distance from the top that triggers the previous cursor page. */
const OLDER_TRIGGER_PX = 240;

export function Conversation({
  messages,
  tail,
  streamInterrupted,
  hasOlder,
  isFetchingOlder,
  fetchOlder,
  isPending,
  onDiscardPrompt,
  onRetryPrompt,
  announcement,
  announcementNonce,
  onScrollHandle,
}: ConversationProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [find, setFind] = useState<{ open: boolean; query: string; index: number }>({
    open: false,
    query: '',
    index: 0,
  });

  const toolResults = useMemo(() => indexToolResults(messages), [messages]);
  const pairedToolUseIds = useMemo(() => collectToolUseIds(messages), [messages]);

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    // A generous estimate: under-estimating makes the scrollbar shrink visibly as rows are
    // measured, which reads as the page moving under the operator's hand.
    estimateSize: () => 120,
    overscan: 8,
    getItemKey: (index) => messages[index]?.id ?? index,
    // The default implementation calls `element.scrollTo`, which does not exist in the unit
    // tier's DOM. Assigning `scrollTop` is equivalent for an instant scroll and works
    // everywhere, which keeps the pinning behaviour testable without a browser.
    scrollToFn: (offset, _options, instance) => {
      const element = instance.scrollElement;
      if (element !== null && element !== undefined) element.scrollTop = offset;
    },
  });

  const scrollToBottom = useCallback(() => {
    if (messages.length > 0) virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    const element = scrollRef.current;
    // The tail lives outside the measured set, so the virtualizer cannot reach it — this
    // second step is what actually lands on a streaming turn.
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messages.length, virtualizer]);

  // --------------------------------------------------------------- follow / new-item counting

  const totalItems = messages.length + tail.length;
  const previousTotal = useRef(totalItems);

  useLayoutEffect(() => {
    if (totalItems === previousTotal.current) return;
    const grew = totalItems > previousTotal.current;
    previousTotal.current = totalItems;
    if (!grew) return;

    if (following) {
      scrollToBottom();
    } else {
      // §5.5: the count is "how much happened while I was reading", which is what lets the
      // operator distinguish one appended paragraph from nine things the agent did.
      setNewCount((count) => count + 1);
    }
  }, [totalItems, following, scrollToBottom]);

  // A streaming turn grows without changing the item count, so following has to be re-applied
  // on content change too — otherwise the tail slides out of view mid-sentence.
  const tailSignature = tail.map((item) => (item.kind === 'live' ? liveLength(item) : 0)).join(':');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tailSignature` is the dependency — it is the *content* of the tail, which is what changed
  useLayoutEffect(() => {
    if (following) scrollToBottom();
  }, [tailSignature, following, scrollToBottom]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (element === null) return;

    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const atBottom = distanceFromBottom <= FOLLOW_THRESHOLD_PX;
    setFollowing(atBottom);
    if (atBottom) setNewCount(0);

    if (element.scrollTop <= OLDER_TRIGGER_PX && hasOlder && !isFetchingOlder) {
      pendingScrollHeight.current = element.scrollHeight;
      fetchOlder();
    }
  }, [hasOlder, isFetchingOlder, fetchOlder]);

  // Reverse infinite scroll preserves position: after a page of older Messages is prepended,
  // the viewport is pushed back down by exactly the height that appeared above it. Without
  // this the operator is thrown to the top of the session every time they scroll up.
  const pendingScrollHeight = useRef<number | null>(null);
  // Runs after **every** commit on purpose: the correction has to happen on whichever render
  // the prepended page lands in, and that is not knowable from a dependency list.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const before = pendingScrollHeight.current;
    if (element === null || before === null) return;
    if (element.scrollHeight === before) return;
    element.scrollTop += element.scrollHeight - before;
    pendingScrollHeight.current = null;
  });

  // ------------------------------------------------------------------------ panel → transcript

  const scrollToTime = useCallback(
    (isoTimestamp: string): boolean => {
      const target = Date.parse(isoTimestamp);
      if (Number.isNaN(target)) return false;

      // "Nearest Message at or before the entry's timestamp" (§5.5, WC3).
      let index = -1;
      for (let i = 0; i < messages.length; i += 1) {
        const at = Date.parse(messages[i]?.occurredAt ?? '');
        if (!Number.isNaN(at) && at <= target) index = i;
      }
      if (index === -1) return false;

      setFollowing(false);
      virtualizer.scrollToIndex(index, { align: 'center' });
      setHighlightId(messages[index]?.id ?? null);
      return true;
    },
    [messages, virtualizer],
  );

  useEffect(() => {
    onScrollHandle?.(scrollToTime);
  }, [onScrollHandle, scrollToTime]);

  // ------------------------------------------------------------------------------- find (§5.5)

  const matches = useMemo(
    () => (find.query.trim().length === 0 ? [] : findMatches(messages, find.query)),
    [messages, find.query],
  );

  const stepFind = useCallback(
    (delta: number) => {
      if (matches.length === 0) return;
      const next = (find.index + delta + matches.length) % matches.length;
      setFind((state) => ({ ...state, index: next }));
      const messageId = matches[next];
      const index = messages.findIndex((message) => message.id === messageId);
      if (index >= 0) {
        setFollowing(false);
        virtualizer.scrollToIndex(index, { align: 'center' });
        setHighlightId(messageId ?? null);
      }
    },
    [matches, find.index, messages, virtualizer],
  );

  // ----------------------------------------------------------------------------- read latest

  const latestAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role === 'assistant') return message.id;
    }
    return null;
  }, [messages]);

  const readLatest = useCallback(() => {
    if (latestAssistantId === null) return;
    const focusTarget = (): boolean => {
      const element = scrollRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${cssEscape(latestAssistantId)}"]`,
      );
      element?.focus();
      return element !== null && element !== undefined;
    };

    if (focusTarget()) return;
    const index = messages.findIndex((message) => message.id === latestAssistantId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'end' });
    // Focus is only ever moved by this deliberate action (§7.4 item 3) — never automatically,
    // which would interrupt a screen-reader user mid-sentence.
    setTimeout(focusTarget, 0);
  }, [latestAssistantId, messages, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <section
      aria-label="Conversation"
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
          // §5.5: native find silently misses most of a virtualized transcript and reports
          // "not found" for text that is present, which is worse than no find at all.
          event.preventDefault();
          setFind((state) => ({ ...state, open: true }));
        }
      }}
    >
      <FindBar
        state={find}
        matchCount={matches.length}
        onQuery={(query) => setFind((state) => ({ ...state, query, index: 0 }))}
        onStep={stepFind}
        onClose={() => setFind({ open: false, query: '', index: 0 })}
      />

      <div
        ref={scrollRef}
        data-testid="conversation-scroll"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {hasOlder ? (
          <div className="px-4 py-3">
            {isFetchingOlder ? (
              <Skeleton height={48} />
            ) : (
              <button
                type="button"
                onClick={fetchOlder}
                className="rounded-sm border border-border-control px-3 text-2xs text-text-secondary"
                style={{ height: 'var(--mc-control-sm)' }}
              >
                Load earlier messages
              </button>
            )}
          </div>
        ) : null}

        {/* §7.4 item 1 — `role="log"` conveys "append-only record"; `aria-live="off"` means the
            container itself never auto-announces. Boundary announcements are the caller's
            polite region below. */}
        <div role="log" aria-live="off" aria-label="Session transcript" data-testid="transcript">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualRows.map((row) => {
              const message = messages[row.index];
              if (message === undefined) return null;
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${row.start}px)`,
                  }}
                >
                  <MessageItem
                    message={message}
                    toolResults={toolResults}
                    pairedToolUseIds={pairedToolUseIds}
                    highlighted={highlightId === message.id}
                  />
                </div>
              );
            })}
          </div>

          {tail.map((item) =>
            item.kind === 'live' ? (
              <StreamingTurn
                key={item.key}
                turn={item.turn}
                streamInterrupted={streamInterrupted}
              />
            ) : item.kind === 'pending' ? (
              <PendingPromptItem
                key={item.key}
                prompt={item.prompt}
                onDiscard={() => onDiscardPrompt(item.prompt.clientRef)}
                onRetry={() => onRetryPrompt(item.prompt.clientRef)}
              />
            ) : null,
          )}
        </div>

        {isPending ? (
          <div className="space-y-3 p-4">
            <Skeleton height={40} />
            <Skeleton height={72} />
            <Skeleton height={40} />
          </div>
        ) : null}
      </div>

      {/* §7.4 item 2 — one announcement per event, never per delta. Keyed on the nonce so a
          repeated message is still a new node and is therefore announced again. */}
      <p
        key={announcementNonce}
        aria-live="polite"
        data-testid="transcript-announcer"
        className="sr-only"
      >
        {announcement}
      </p>

      <div className="pointer-events-none absolute right-4 bottom-4 flex flex-col items-end gap-2">
        {newCount > 0 ? (
          <button
            type="button"
            onClick={() => {
              setFollowing(true);
              setNewCount(0);
              scrollToBottom();
            }}
            aria-label={`Jump to latest, ${newCount} new`}
            className="pointer-events-auto rounded-full border border-border-control px-3 text-2xs text-text"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              height: 'var(--mc-control-sm)',
            }}
          >
            ↓ Jump to latest ({newCount} new)
          </button>
        ) : null}

        {latestAssistantId === null ? null : (
          <button
            type="button"
            onClick={readLatest}
            className="pointer-events-auto rounded-sm border border-border-control px-3 text-2xs text-text-secondary"
            style={{
              backgroundColor: 'var(--color-surface-raised)',
              height: 'var(--mc-control-sm)',
            }}
          >
            Read latest response
          </button>
        )}
      </div>
    </section>
  );
}

function FindBar({
  state,
  matchCount,
  onQuery,
  onStep,
  onClose,
}: {
  state: { open: boolean; query: string; index: number };
  matchCount: number;
  onQuery: (query: string) => void;
  onStep: (delta: number) => void;
  onClose: () => void;
}) {
  if (!state.open) return null;

  return (
    <div className="flex items-center gap-2 border-border border-b px-4 py-2">
      <input
        type="search"
        // biome-ignore lint/a11y/noAutofocus: opening the FindBar IS the request to type in it
        autoFocus
        aria-label="Find in transcript"
        value={state.query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onStep(event.shiftKey ? -1 : 1);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in transcript"
        className="rounded-sm border border-border-control bg-transparent px-2 text-sm text-text"
        style={{ height: 'var(--mc-control-sm)' }}
      />
      <p aria-live="polite" className="font-mono text-2xs text-text-muted">
        {matchCount === 0 ? 'no matches' : `${state.index + 1} of ${matchCount} matches`}
      </p>
      <button
        type="button"
        onClick={() => onStep(-1)}
        aria-label="Previous match"
        className="rounded-xs px-2 text-text-secondary text-xs"
        style={{ minHeight: 24, minWidth: 24 }}
      >
        ‹
      </button>
      <button
        type="button"
        onClick={() => onStep(1)}
        aria-label="Next match"
        className="rounded-xs px-2 text-text-secondary text-xs"
        style={{ minHeight: 24, minWidth: 24 }}
      >
        ›
      </button>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close find"
        className="rounded-xs px-2 text-text-muted text-xs"
        style={{ minHeight: 24, minWidth: 24 }}
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Matching runs over the **full committed Message set in the cache**, not the rendered window
 * (§5.5) — which is the entire reason this exists instead of the browser's own find.
 */
export function findMatches(messages: readonly Message[], query: string): readonly string[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  return messages
    .filter((message) => searchableText(message).toLowerCase().includes(needle))
    .map((message) => message.id);
}

function searchableText(message: Message): string {
  const blocks = message.content
    .map((block) => {
      if (block['type'] === 'tool_use') {
        return `${readString(block, 'toolName') ?? ''} ${JSON.stringify(block['input'] ?? '')}`;
      }
      if (block['type'] === 'tool_result') return readString(block, 'output') ?? '';
      return '';
    })
    .join(' ');
  return `${messageText(message)} ${blocks}`;
}

function collectToolUseIds(messages: readonly Message[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const block of message.content) {
      if (block['type'] !== 'tool_use') continue;
      const id = readString(block, 'toolUseId');
      if (id !== null) ids.add(id);
    }
  }
  return ids;
}

function liveLength(item: TranscriptItem): number {
  if (item.kind !== 'live') return 0;
  return item.turn.blocks.reduce(
    (total, block) => total + block.text.length + block.partialJson.length,
    0,
  );
}

/** `CSS.escape` is not in jsdom; ids here are UUIDs, so a conservative filter is enough. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
