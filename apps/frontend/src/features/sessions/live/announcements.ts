import { useCallback, useState } from 'react';

/**
 * The polite announcement channel for the live transcript (TDS 06 §7.4 item 2).
 *
 * The vocabulary below is **complete and closed**. The transcript container itself is
 * `aria-live="off"` precisely so that this region can carry one announcement per *event*
 * rather than one per delta: streaming text mutates dozens of times a second, and any live
 * value on the container queues an announcement per mutation, which is how a screen reader is
 * rendered useless by a feature that was meant to include it.
 *
 * "Something is happening, and now it's done" is the target. Not silence, and not narration.
 */

export const ANNOUNCEMENTS = {
  turnStarted: 'Claude is responding',
  turnComplete: (toolCalls: number): string =>
    toolCalls === 0
      ? 'Response complete'
      : `Response complete, ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`,
  turnStopped: 'Turn stopped',
  /** Verbatim F7 state names — `paused`, never "suspended" (F9.5). */
  sessionState: (state: 'failed' | 'completed' | 'paused'): string => `Session ${state}`,
  streamInterrupted: 'Stream interrupted, reconnecting',
  promptQueued: 'Prompt queued, will send when the current turn finishes',
} as const;

export interface Announcer {
  /** The text the visually-hidden polite region currently holds. */
  readonly message: string;
  /**
   * Increments on every announcement, including a repeat of the same string. The region is
   * keyed on it: assistive technology de-duplicates unchanged live-region content, and
   * "Stream interrupted, reconnecting" twice in a row is two genuinely separate facts, so the
   * node is replaced rather than the text being polluted with an invisible marker character.
   */
  readonly nonce: number;
  readonly announce: (text: string) => void;
}

/**
 * `announce` is imperative on purpose: these are events, not state. Deriving them from
 * rendered state would re-announce on every unrelated re-render.
 */
export function useAnnouncer(): Announcer {
  const [state, setState] = useState<{ message: string; nonce: number }>({
    message: '',
    nonce: 0,
  });

  const announce = useCallback((text: string) => {
    setState((previous) => ({ message: text, nonce: previous.nonce + 1 }));
  }, []);

  return { message: state.message, nonce: state.nonce, announce };
}
