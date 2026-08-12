import type { EventEnvelope } from '@mc/shared/types';
import type { QueryClient } from '@tanstack/react-query';
import { type DeltaPayload, useLiveSessionStore } from '../../stores/live-session-store.js';
import { useUiStore } from '../../stores/ui-store.js';
import {
  dedupeQueryKeys,
  queryKeysForChannel,
  queryKeysForEvent,
  reconnectBaselineKeys,
} from './invalidation.js';
import { payloadString } from './protocol.js';
import type { EventListener } from './socket-client.js';

/**
 * The event dispatcher (TDS 05 §5.3) — the one place a relayed F6 envelope turns into
 * client effects.
 *
 * Handling is **invalidation-first** because payloads carry IDs only (F6.2): the event says
 * what changed, REST says what it changed to. The single exception is the delta stream,
 * which is ephemeral by nature and goes straight to `liveSessionStore` with no cache
 * traffic at all (§6.2).
 */

export interface DispatcherOptions {
  readonly queryClient: QueryClient;
  /** Test seam; defaults to the real stores. */
  readonly live?: {
    applyDelta(payload: DeltaPayload): void;
    commitTurn(sessionId: string, messageId: string | null): void;
    terminateTurn(
      sessionId: string,
      termination: {
        reason: 'failed' | 'disconnected' | 'interrupted';
        at: number;
        errorCode: string | null;
        requestId: string | null;
      },
    ): void;
    noteActivity(sessionId: string): void;
  };
  readonly focusedSessionId?: () => string | null;
}

function defaultLive(): NonNullable<DispatcherOptions['live']> {
  const store = useLiveSessionStore.getState();
  return {
    applyDelta: store.applyDelta,
    commitTurn: store.commitTurn,
    terminateTurn: store.terminateTurn,
    noteActivity: store.noteActivity,
  };
}

export function createEventDispatcher(options: DispatcherOptions): EventListener {
  const { queryClient } = options;
  const live = options.live ?? defaultLive();
  const focusedSessionId =
    options.focusedSessionId ?? (() => useUiStore.getState().focusedSessionId);

  return (_channel: string, event: EventEnvelope): void => {
    const sessionId = payloadString(event, 'sessionId');

    switch (event.type as string) {
      case 'session.message.delta_appended':
        // No invalidation, by design: one REST refetch per token would be catastrophic and
        // the canonical Message is coming anyway via `session.message.appended`.
        live.applyDelta(event.payload as unknown as DeltaPayload);
        return;

      case 'session.message.appended': {
        if (sessionId !== null) {
          live.commitTurn(sessionId, payloadString(event, 'messageId'));
          // §6.5 — background activity accrues while the Session is not the focused one.
          if (focusedSessionId() !== sessionId) live.noteActivity(sessionId);
        }
        break;
      }

      case 'session.failed': {
        if (sessionId !== null) {
          // §6.2: a partial turn with no committed Message is RETAINED and marked, never
          // blanked — it is the most diagnostic artifact a failed session leaves behind.
          live.terminateTurn(sessionId, {
            reason: 'failed',
            at: Date.now(),
            errorCode: payloadString(event, 'reason'),
            requestId: null,
          });
          if (focusedSessionId() !== sessionId) live.noteActivity(sessionId);
        }
        break;
      }

      case 'session.state_changed':
      case 'session.completed':
      case 'session.paused':
      case 'session.observation_degraded': {
        if (sessionId !== null && focusedSessionId() !== sessionId) live.noteActivity(sessionId);
        break;
      }

      default:
        break;
    }

    for (const queryKey of queryKeysForEvent(event)) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
}

/**
 * The reconnect refetch (TDS 05 §5.3 step 2 / TDS 04 §14.7 step 3).
 *
 * Called *after* the resubscribe frame has gone out, with exactly the channels that were
 * re-subscribed. Everything missed during the gap is healed here, because F6.3 provides no
 * replay — this refetch IS the recovery mechanism, not a belt-and-braces extra.
 */
export function createReconnectHandler(
  queryClient: QueryClient,
): (channels: readonly string[]) => void {
  return (channels) => {
    const keys = dedupeQueryKeys([
      ...channels.flatMap((channel) => queryKeysForChannel(channel)),
      ...reconnectBaselineKeys(),
    ]);
    for (const queryKey of keys) {
      void queryClient.invalidateQueries({ queryKey });
    }
  };
}
