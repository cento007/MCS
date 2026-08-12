import { useEffect, useRef } from 'react';
import type { Message, MessageContentBlock } from '../../../lib/api/index.js';
import type { LiveTurn, PendingPrompt } from '../../../stores/live-session-store.js';

/**
 * The rendered conversation, assembled from the two layers of TDS 05 §6.1.
 *
 *   committed history (REST, canonical, survives reload)
 * + the live tail        (one ephemeral turn buffer, §6.2)
 * + pending prompts      (client-side, not yet transmitted, §6.8)
 *
 * This module is pure: it takes the three inputs and returns an ordered item list. That is
 * what makes §6.2's four-case reconciliation table directly testable — every one of those
 * cases is an assertion about which items come out of `buildTranscript`, with no DOM, no
 * socket and no query client involved.
 */

export type TranscriptItem =
  | { readonly kind: 'message'; readonly key: string; readonly message: Message }
  | {
      readonly kind: 'live';
      readonly key: string;
      readonly turn: LiveTurn;
      /**
       * True for a turn the store has already cleared but whose canonical Message has not
       * arrived yet. Rendered identically — see `buildTranscript` for why it exists at all.
       */
      readonly settling: boolean;
    }
  | { readonly kind: 'pending'; readonly key: string; readonly prompt: PendingPrompt };

export interface TranscriptInput {
  /** Ascending `ordinal` — the only conversation-order key (A5). */
  readonly messages: readonly Message[];
  readonly turn: LiveTurn | null;
  /** The last turn the store cleared, retained until its Message shows up. May be `null`. */
  readonly settlingTurn?: LiveTurn | null;
  readonly pendingPrompts: readonly PendingPrompt[];
}

/**
 * Assemble the list.
 *
 * The single reconciliation rule of §6.2, stated once: **the committed Message wins over the
 * partial buffer only when a canonical Message actually exists for that turn.** So the live
 * item is dropped when — and only when — a Message with the buffer's `messageId` is present
 * in the committed history. A buffer is never dropped merely because the stream stopped: a
 * `failed` session's partial output is the most diagnostic artifact on the screen, and the
 * runtime never re-emits it.
 */
export function buildTranscript(input: TranscriptInput): readonly TranscriptItem[] {
  const items: TranscriptItem[] = input.messages.map((message) => ({
    kind: 'message',
    key: message.id,
    message,
  }));

  const committedIds = new Set(input.messages.map((message) => message.id));

  const live = input.turn ?? null;
  if (live !== null && !isSupersededBy(live, committedIds)) {
    items.push({ kind: 'live', key: liveKey(live), turn: live, settling: false });
  }

  // The settling slot exists because `commitTurn` deletes the buffer the instant the
  // `session.message.appended` event lands, while the canonical Message only arrives with the
  // refetch that event triggers. Rendering nothing in between blanks the transcript for a
  // round trip — and §5.5 is explicit that a blank conversation reads as "nothing is
  // happening", which is the one thing it must never say while a session is working.
  const settling = input.settlingTurn ?? null;
  if (live === null && settling !== null && !isSupersededBy(settling, committedIds)) {
    items.push({ kind: 'live', key: liveKey(settling), turn: settling, settling: true });
  }

  for (const prompt of input.pendingPrompts) {
    items.push({ kind: 'pending', key: `pending-${prompt.clientRef}`, prompt });
  }

  return items;
}

function isSupersededBy(turn: LiveTurn, committedIds: ReadonlySet<string>): boolean {
  return turn.messageId !== null && committedIds.has(turn.messageId);
}

function liveKey(turn: LiveTurn): string {
  return `live-${turn.messageId ?? turn.startedAt}`;
}

/**
 * A turn is "in flight" while deltas are still expected or the runtime has signalled the end
 * and the canonical Message has not landed. This is the §6.8 predicate that swaps `[Pause]`
 * for `[Stop]`, and it is deliberately false for a **terminated** buffer: a retained partial
 * is read-only evidence, not an interruptible turn.
 */
export function isTurnInFlight(turn: LiveTurn | null): boolean {
  return turn !== null && (turn.status === 'streaming' || turn.status === 'awaiting_commit');
}

/**
 * Hold the last cleared buffer until its Message is in the committed list.
 *
 * A ref rather than state: this value must never *cause* a render, only survive one. It is
 * dropped as soon as the Message it is standing in for arrives, so it cannot outlive its
 * purpose and become a ghost turn.
 */
export function useSettlingTurn(
  sessionId: string,
  turn: LiveTurn | null,
  messages: readonly Message[],
): LiveTurn | null {
  const previous = useRef<LiveTurn | null>(null);
  const settling = useRef<LiveTurn | null>(null);
  const session = useRef<string>(sessionId);

  if (session.current !== sessionId) {
    session.current = sessionId;
    previous.current = null;
    settling.current = null;
  }

  // A buffer that vanished while it was still live (never terminated) was committed — hold it.
  if (turn === null && previous.current !== null && previous.current.status !== 'terminated') {
    settling.current = previous.current;
  }
  // A new buffer supersedes any settling one: the next turn has started, so the previous
  // turn's Message either arrived or never will, and either way it is no longer the tail.
  if (turn !== null) settling.current = null;

  previous.current = turn;

  const held = settling.current;
  if (held !== null && held.messageId !== null) {
    if (messages.some((message) => message.id === held.messageId)) settling.current = null;
  } else if (held !== null && held.messageId === null) {
    // No id to match on — there is nothing to wait for, so do not hold a turn we could never
    // retire. (`commitTurn(id, null)` is the shape this covers.)
    settling.current = null;
  }

  return settling.current;
}

// ------------------------------------------------------------------- content-block helpers

export interface ToolUseBlock {
  readonly type: 'tool_use';
  readonly toolUseId: string | null;
  readonly toolName: string;
  readonly input: unknown;
}

export interface ToolResult {
  readonly output: string;
  readonly isError: boolean;
  /** Wall time between the tool_use message and its result, in seconds. `null` if unknown. */
  readonly durationSeconds: number | null;
}

/** Every `tool_result` in the transcript, indexed by `toolUseId` (§6.6 content vocabulary). */
export function indexToolResults(messages: readonly Message[]): ReadonlyMap<string, ToolResult> {
  const useAt = new Map<string, number>();
  const results = new Map<string, ToolResult>();

  for (const message of messages) {
    const occurredAt = Date.parse(message.occurredAt);
    for (const block of message.content) {
      if (block['type'] === 'tool_use') {
        const id = readString(block, 'toolUseId');
        if (id !== null && !Number.isNaN(occurredAt)) useAt.set(id, occurredAt);
      } else if (block['type'] === 'tool_result') {
        const id = readString(block, 'toolUseId');
        if (id === null) continue;
        const startedAt = useAt.get(id);
        results.set(id, {
          output: readString(block, 'output') ?? '',
          isError: block['isError'] === true,
          durationSeconds:
            startedAt === undefined || Number.isNaN(occurredAt)
              ? null
              : Math.max(0, (occurredAt - startedAt) / 1000),
        });
      }
    }
  }

  return results;
}

export function isToolUseBlock(block: MessageContentBlock): boolean {
  return block['type'] === 'tool_use';
}

/**
 * The one-line argument a collapsed tool row shows — path, pattern or command.
 *
 * A collapsed tool call must be comprehensible without opening it (§7.4 item 4), and "Read"
 * on its own is not: the file is the entire content of that row.
 */
export function primaryArgument(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of [
    'file_path',
    'filePath',
    'path',
    'notebook_path',
    'pattern',
    'command',
    'url',
    'query',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.length > 0 && value.length <= 200) return value;
  }
  return null;
}

/** Concatenated `text` blocks — what search, the accessible name and the title fall back to. */
export function messageText(message: Message): string {
  return message.content
    .filter((block) => block['type'] === 'text' || block['type'] === 'thinking')
    .map((block) => readString(block, 'text') ?? '')
    .join('\n')
    .trim();
}

export function countToolCalls(message: Message): number {
  return message.content.filter(isToolUseBlock).length;
}

export function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Run `effect` once per distinct value of `signal`.
 *
 * Used by the announcer: "turn started" must be spoken once per turn, not once per render of
 * a turn that is still going.
 */
export function useOnChange<T>(
  signal: T,
  effect: (value: T, previous: T | undefined) => void,
): void {
  const previous = useRef<T | undefined>(undefined);
  const handler = useRef(effect);
  handler.current = effect;

  useEffect(() => {
    if (previous.current === signal) return;
    const before = previous.current;
    previous.current = signal;
    handler.current(signal, before);
  }, [signal]);
}
