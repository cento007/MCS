import { createBrowserRouter, Navigate, type RouteObject } from 'react-router';
import { ErrorPanel } from '../components/ErrorPanel.js';
import { RequireAuth } from './guards.js';
import { AppShell } from './shell/AppShell.js';

/**
 * The route table (TDS 05 §2.2, §2.3).
 *
 * **React Router v7 in library (data) mode.** Loader-less on purpose: all data fetching
 * stays in TanStack Query, so there is one data layer rather than two competing caches with
 * two invalidation stories. Routers loaders would also fetch outside the cache that the
 * WebSocket invalidates, which is exactly the divergence §5.3 exists to prevent.
 *
 * Every entry under `RequireAuth` is a `lazy` module — one chunk per top-level route (§2.3).
 * `/login` is the only public route.
 */
export const routes: RouteObject[] = [
  {
    path: '/login',
    lazy: () => import('../routes/login.js'),
  },
  {
    element: <RequireAuth />,
    ErrorBoundary: RouteErrorBoundary,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, lazy: () => import('../routes/dashboard.js') },
          { path: 'projects', lazy: () => import('../routes/projects.js') },
          { path: 'projects/:projectId', lazy: () => import('../routes/project-detail.js') },
          { path: 'sessions', lazy: () => import('../routes/sessions.js') },
          { path: 'sessions/:sessionId', lazy: () => import('../routes/session-detail.js') },
          { path: 'adrs', lazy: () => import('../routes/adrs.js') },
          { path: 'adrs/:adrId', lazy: () => import('../routes/adr-detail.js') },
          // Phase 3/4 placeholder routes. Reachable and badged — never `disabled` (§10).
          { path: 'memory', lazy: () => import('../routes/memory.js') },
          { path: 'agents', lazy: () => import('../routes/agents.js') },
          { path: 'settings', element: <Navigate to="/settings/general" replace /> },
          { path: 'settings/:category', lazy: () => import('../routes/settings.js') },
          { path: '*', lazy: () => import('../routes/not-found.js') },
        ],
      },
    ],
  },
];

/**
 * Route-level error boundary (§11.1). It catches *render* failures; transport degradation
 * is the ConnectionChip's job and API failures are `ErrorPanel`'s, so this is deliberately
 * the last line rather than the first.
 */
export function RouteErrorBoundary() {
  return (
    <div className="p-6">
      <ErrorPanel
        error={new Error('This screen failed to render.')}
        title="Something broke on this page"
        onRetry={() => window.location.reload()}
      />
    </div>
  );
}

export function createRouter() {
  return createBrowserRouter(routes);
}
