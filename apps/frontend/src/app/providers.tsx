import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Toaster } from '../components/Toaster.js';
import { KeyboardProvider } from '../lib/keys/context.js';
import { createQueryClient } from './query-client.js';

/**
 * Application providers (TDS 05 §2.1 `app/providers.tsx`).
 *
 * Order matters: the query client is outermost because everything reads from it; the
 * keyboard registry wraps the router so route-scoped bindings can register and die with
 * their route; the toaster sits last so it paints above every surface.
 *
 * The socket provider is deliberately NOT here — it belongs inside `RequireAuth` (§5, §8),
 * because an unauthenticated tab must not open a connection.
 */
export function Providers({
  children,
  queryClient,
}: {
  children: ReactNode;
  /** Test seam: a per-test client with retries off. */
  queryClient?: QueryClient;
}) {
  const [client] = useState(() => queryClient ?? createQueryClient());

  return (
    <QueryClientProvider client={client}>
      <KeyboardProvider>
        {children}
        <Toaster />
      </KeyboardProvider>
    </QueryClientProvider>
  );
}
