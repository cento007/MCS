import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KeyboardProvider } from '../lib/keys/context.js';
import { RequireAuth } from './guards.js';

/**
 * `RequireAuth` (TDS 05 §8).
 *
 * The distinction this guard exists to get right is **401 versus everything else**. A 401 is
 * an answer and redirects. A network failure is not: bouncing the operator to `/login`
 * because the Backend restarted hides the actual problem behind a form they cannot submit
 * either.
 */

class SilentWebSocket {
  static readonly CONNECTING = 0;
  readyState = 0;
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  send(): void {}
  close(): void {}
}

const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();

function testQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function renderGuarded(initialPath: string) {
  const queryClient = testQueryClient();
  const router = createMemoryRouter(
    [
      { path: '/login', element: <p>login page</p> },
      {
        element: <RequireAuth />,
        children: [{ path: '/sessions', element: <p>protected sessions screen</p> }],
      },
    ],
    { initialEntries: [initialPath] },
  );

  render(
    <QueryClientProvider client={queryClient}>
      <KeyboardProvider>
        <RouterProvider router={router} />
      </KeyboardProvider>
    </QueryClientProvider>,
  );

  return router;
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ error: { code, message: code, requestId: 'req-1' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  // The guard mounts the socket provider on success; a real WebSocket would try to dial
  // localhost from jsdom and litter the run with connection errors.
  vi.stubGlobal('WebSocket', SilentWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RequireAuth', () => {
  it('renders the protected route when the current-user query succeeds', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { user: { id: 'u1', username: 'operator' }, authMethod: 'cookie', session: null },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    renderGuarded('/sessions');
    expect(await screen.findByText('protected sessions screen')).toBeInTheDocument();
  });

  it('redirects a 401 to /login carrying the encoded returnTo', async () => {
    fetchMock.mockResolvedValue(errorResponse(401, 'UNAUTHORIZED'));

    const router = renderGuarded('/sessions');

    expect(await screen.findByText('login page')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe('?returnTo=%2Fsessions');
  });

  it('does NOT redirect on a transport failure — it shows the error with a retry', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    const router = renderGuarded('/sessions');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText('Could not verify your session')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sessions');
  });

  it('shows a skeleton while the identity is unknown rather than guessing', async () => {
    fetchMock.mockImplementation(() => new Promise(() => undefined));
    renderGuarded('/sessions');
    expect(await screen.findByText('Loading')).toBeInTheDocument();
  });
});
