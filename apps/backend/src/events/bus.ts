import type { EventEnvelope, EventType } from '@mc/shared';

/**
 * The in-process event bus (F3.2, TDS 02 §2) — the Backend's own fan-out, separate from the
 * durable queue.
 *
 * It carries F6 envelopes to in-process subscribers, of which the WebSocket hub is the first
 * (TDS 02 §2: "`ws/` is a dumb relay ... it subscribes to the in-process bus"). Delivery is
 * best-effort and in-memory with no durability claim; anything that must survive a restart
 * goes through the queue instead (F6.3).
 *
 * Implemented over a `Set` rather than `node:events`: an `EventEmitter` whose channel is
 * literally named `error` for one event type would make a listener throw take the process
 * down, and this bus must never be able to do that — a relay failure is not a domain failure.
 */

export type EventListener = (event: EventEnvelope) => void;

export interface EventBusOptions {
  /** Called when a listener throws. The publisher never sees the error. */
  readonly onListenerError?: (error: unknown, event: EventEnvelope) => void;
}

export interface EventBus {
  /**
   * Publish to every subscriber. Never throws: a listener that fails is reported through
   * `onListenerError` and the remaining listeners still run.
   */
  publish(event: EventEnvelope): void;
  /**
   * Receive every envelope published in this process; returns the unsubscribe function.
   *
   * Named to satisfy `ws/ports.ts`'s `EventBusPort` structurally, so the hub subscribes to
   * this bus with no adapter. The hub deliberately wants the firehose plus its own routing
   * table (`ws/channels.ts`) rather than per-type registration, so that the filter deciding
   * what a browser may see lives in exactly one reviewable place.
   */
  subscribeAll(listener: EventListener): () => void;
  /** Subscribe to one event type — the common case for feature modules. */
  on(type: EventType, listener: EventListener): () => void;
  /** Live listener count. Diagnostics only. */
  readonly listenerCount: number;
}

export function createEventBus(options: EventBusOptions = {}): EventBus {
  const listeners = new Set<EventListener>();

  return {
    get listenerCount() {
      return listeners.size;
    },
    publish(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch (error) {
          options.onListenerError?.(error, event);
        }
      }
    },
    subscribeAll(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    on(type, listener) {
      const filtered: EventListener = (event) => {
        if (event.type === type) listener(event);
      };
      listeners.add(filtered);
      return () => {
        listeners.delete(filtered);
      };
    },
  };
}
