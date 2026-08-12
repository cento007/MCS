import { type UseQueryResult, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type ApiError,
  type AuthMe,
  apiGet,
  apiSend,
  apiVoid,
  endpoints,
  type LoginResult,
  queryKeys,
} from '../../lib/api/index.js';
import { useLiveSessionStore } from '../../stores/live-session-store.js';
import { useSocketStore } from '../../stores/socket-store.js';

/**
 * Auth queries and mutations (TDS 05 §8).
 *
 * The SPA never reads or stores the credential or the cookie — F5.5 makes `mc_session`
 * HTTP-only. "Am I signed in?" is answered by one query (`['auth','me']`) succeeding, which
 * is also why that query must not retry: a 401 is the *answer*, and retrying it three times
 * turns an instant redirect into a visible stall on every cold load of an expired session.
 */

export function useCurrentUser(): UseQueryResult<AuthMe, ApiError> {
  return useQuery<AuthMe, ApiError>({
    queryKey: queryKeys.auth.me(),
    queryFn: ({ signal }) => apiGet<AuthMe>(endpoints.auth.me, { signal }),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
}

export interface LoginInput {
  readonly username: string;
  readonly password: string;
}

export function useLogin() {
  const queryClient = useQueryClient();

  return useMutation<LoginResult, ApiError, LoginInput>({
    mutationFn: (input) =>
      apiSend<LoginResult>('POST', endpoints.auth.login, {
        body: input,
        // The login call's own 401 IS the answer — routing it through the global expiry
        // interceptor would redirect to the page the operator is already on.
        skipAuthInterceptor: true,
      }),
    onSuccess: async (result) => {
      // Seed rather than await a round trip: the Backend has just told us who we are, and
      // the guard can render immediately instead of flashing a skeleton.
      queryClient.setQueryData<AuthMe>(queryKeys.auth.me(), {
        user: result.user,
        authMethod: 'cookie',
        session: { expiresAt: result.expiresAt },
      });
      await queryClient.invalidateQueries();
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();

  return useMutation<void, ApiError, void>({
    mutationFn: () => apiVoid('POST', endpoints.auth.logout),
    // `onSettled`, not `onSuccess`: a logout whose request failed must still clear the
    // client. Leaving cached Sessions and a live socket on screen because the server did
    // not answer is the wrong failure mode for a sign-out.
    onSettled: () => {
      resetClientState(queryClient);
    },
  });
}

/**
 * Drop every trace of the previous principal: server cache, socket state, streaming
 * buffers. `uiStore` deliberately survives — theme, nav and composer drafts are the
 * operator's, not the session's (§8: "draft composer text survives re-login").
 */
export function resetClientState(queryClient: ReturnType<typeof useQueryClient>): void {
  queryClient.clear();
  useLiveSessionStore.getState().reset();
  useSocketStore.getState().reset();
}
