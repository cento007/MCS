import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router';
import { ErrorPanel } from '../components/ErrorPanel.js';
import { RouteSkeleton } from '../components/Skeleton.js';
import { resetClientState, useCurrentUser } from '../features/auth/queries.js';
import { loginPathFor } from '../features/auth/return-to.js';
import { setUnauthorizedHandler } from '../lib/api/client.js';
import { SocketProvider } from '../lib/ws/context.js';
import { toast } from '../stores/toast-store.js';

/**
 * `RequireAuth` (TDS 05 §8) — everything except `/login` mounts inside this.
 *
 * It gates on the `['auth','me']` query and it is also where the socket lives: the client
 * is "created when an authenticated user enters the app shell and torn down on logout"
 * (§5), so an unauthenticated tab never opens a connection that could only be refused at
 * the upgrade.
 *
 * The distinction this guard has to get right is **401 versus everything else**. A 401 is
 * an answer — redirect. A network failure is not: bouncing an operator to `/login` because
 * the Backend restarted would hide the actual problem behind a login form they cannot
 * submit either.
 */
export function RequireAuth() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useCurrentUser();

  // The current route, read through a ref so the expiry handler below is registered once
  // but always redirects back to where the operator actually is. Reading `window.location`
  // instead would be subtly wrong under any router whose history is not the browser's.
  const locationRef = useRef(`${location.pathname}${location.search}`);
  locationRef.current = `${location.pathname}${location.search}`;

  const expireSession = useCallback(() => {
    resetClientState(queryClient);
    toast({ kind: 'warning', message: 'Session expired. Sign in again to continue.' });
    void navigate(loginPathFor(locationRef.current), { replace: true });
  }, [queryClient, navigate]);

  // The single 401 interceptor (§4). Registered here rather than at module scope because
  // it needs the router: only a component inside `RouterProvider` can navigate.
  useEffect(() => {
    setUnauthorizedHandler(expireSession);
    return () => setUnauthorizedHandler(null);
  }, [expireSession]);

  if (isPending) return <RouteSkeleton />;

  if (isError) {
    if (error.status === 401) {
      return <Navigate to={loginPathFor(`${location.pathname}${location.search}`)} replace />;
    }
    return (
      <div className="p-6">
        <ErrorPanel
          error={error}
          title="Could not verify your session"
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  if (data === undefined) return <RouteSkeleton />;

  return (
    // Close code 4001 — "auth session expired or token revoked" (§14.6) — takes the same
    // path as a REST 401 because it means the same thing, and §5.1 requires that the client
    // NOT retry the socket in this one case.
    <SocketProvider onAuthFailure={expireSession}>
      <Outlet />
    </SocketProvider>
  );
}
