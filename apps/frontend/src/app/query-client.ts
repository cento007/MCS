import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../lib/api/errors.js';

/**
 * The TanStack Query client (TDS 05 §3).
 *
 * Defaults chosen for an operator console fed by a WebSocket:
 *
 *  - **`staleTime` is short but non-zero.** Freshness comes primarily from F6 event
 *    invalidation (§5.3), not from polling, so a long stale time would be safe — but a
 *    short one bounds how wrong a screen can be if an event is dropped, which F6.3 permits
 *    (best-effort relay, no replay).
 *  - **4xx is never retried.** A 401, 404 or 409 will not become a 200 on the third
 *    attempt; retrying only delays the redirect or the error the operator needs to see.
 *  - **`placeholderData: keepPreviousData` is NOT global.** §11.2 wants it on paginated
 *    queries specifically; applying it everywhere would make a detail view show the
 *    previous Session's data while the next one loads.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (failureCount, error) => {
          if (error instanceof ApiError) {
            if (error.status >= 400 && error.status < 500) return false;
            if (error.isNetworkError) return failureCount < 2;
          }
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
      },
      mutations: {
        // §11.3: the default is pessimistic. A mutation that failed did not happen, and a
        // silent retry of a lifecycle action could execute it twice against an F7 machine.
        retry: false,
      },
    },
  });
}
