import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef } from 'react';
import { useSocketStore } from '../../stores/socket-store.js';
import { createEventDispatcher, createReconnectHandler } from './dispatch.js';
import { sessionChannel } from './protocol.js';
import { type EventListener, SocketClient } from './socket-client.js';

/**
 * Socket lifecycle and channel hooks (TDS 05 §5).
 *
 * The client is created when an authenticated operator enters the app shell and torn down
 * on logout — it is mounted *inside* `RequireAuth`, so an unauthenticated tab never opens a
 * socket that would only be refused at the upgrade.
 */

const SocketContext = createContext<SocketClient | null>(null);

export interface SocketProviderProps {
  readonly children: ReactNode;
  /** Test seam. Production builds one here, wired to the query cache and the socket store. */
  readonly client?: SocketClient;
  /** Called on close code 4001 (§14.6) — the same path a REST 401 takes (§8). */
  readonly onAuthFailure?: () => void;
}

export function SocketProvider({ children, client: injected, onAuthFailure }: SocketProviderProps) {
  const queryClient = useQueryClient();
  const applySnapshot = useSocketStore((state) => state.applySnapshot);
  const setBrowserOnline = useSocketStore((state) => state.setBrowserOnline);

  const authFailureRef = useRef(onAuthFailure);
  authFailureRef.current = onAuthFailure;

  const client = useMemo(() => {
    if (injected !== undefined) return injected;
    return new SocketClient({
      onStateChange: (snapshot) => applySnapshot(snapshot),
      onEvent: createEventDispatcher({ queryClient }),
      onReconnected: createReconnectHandler(queryClient),
      onAuthFailure: () => authFailureRef.current?.(),
    });
  }, [injected, queryClient, applySnapshot]);

  useEffect(() => {
    if (typeof navigator !== 'undefined') setBrowserOnline(navigator.onLine);
    client.connect();

    const onOnline = (): void => {
      setBrowserOnline(true);
      // The browser regaining a network is the one signal worth short-circuiting backoff
      // for: waiting out a 30 s timer after the operator's Wi-Fi came back is exactly the
      // kind of stale-by-policy behaviour §3.3 is about.
      client.retryNow();
    };
    const onOffline = (): void => setBrowserOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      // `disconnect()`, NOT `dispose()`.
      //
      // React 19 StrictMode mounts every effect, tears it down, and mounts it again. A
      // `dispose()` here permanently poisons the memoised client — the second mount calls
      // `connect()` on an instance that has already decided it is dead, so the socket never
      // opens and the ConnectionChip reads `offline` forever in development. This was
      // observed against the real Backend, not reasoned about.
      //
      // `disconnect()` is full teardown anyway: it closes the socket, cancels backoff and
      // stops the heartbeat. Channel subscriptions drain on their own, because every
      // `useChannel` effect releases its refcount as its own component unmounts.
      client.disconnect();
    };
  }, [client, setBrowserOnline]);

  return <SocketContext value={client}>{children}</SocketContext>;
}

export function useSocketClient(): SocketClient {
  const client = useContext(SocketContext);
  if (client === null) throw new Error('useSocketClient must be used inside <SocketProvider>');
  return client;
}

/** Same as `useSocketClient`, but `null` outside a provider — for optional shell chrome. */
export function useOptionalSocketClient(): SocketClient | null {
  return useContext(SocketContext);
}

/**
 * Refcounted channel subscription bound to the component lifecycle (§5.2).
 *
 * The registry sends a subscribe frame on the first subscriber and an unsubscribe frame
 * when the last one goes away — after a short linger, so a route transition between two
 * views of the same Session does not churn a subscribe/unsubscribe pair.
 */
export function useChannel(channel: string | null, onEvent?: EventListener): void {
  const client = useSocketClient();
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (channel === null) return;
    return client.subscribe(channel, (name, event) => handler.current?.(name, event));
  }, [client, channel]);
}

/** Subscribe to `session:{id}` for as long as this component is mounted (§5.2). */
export function useSessionChannel(sessionId: string | null, onEvent?: EventListener): void {
  useChannel(sessionId === null ? null : sessionChannel(sessionId), onEvent);
}

/**
 * Subscribe to every Session in the operator's open set (§5.2/§6.5), so background activity
 * accrues on Sessions that are not the visible route. Mounted once, in the app shell.
 */
export function useOpenSessionChannels(sessionIds: readonly string[]): void {
  const client = useSocketClient();
  const signature = sessionIds.join(',');

  useEffect(() => {
    const ids = signature.length === 0 ? [] : signature.split(',');
    const releases = ids.map((id) => client.subscribe(sessionChannel(id)));
    return () => {
      for (const release of releases) release();
    };
  }, [client, signature]);
}
