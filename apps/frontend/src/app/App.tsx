import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { Providers } from './providers.js';
import { createRouter } from './router.js';

/**
 * Application root: providers, then the router.
 *
 * The router is created once and held in state rather than at module scope, so a test can
 * mount `<App />` twice without two mounts sharing history state.
 */
export function App() {
  const [router] = useState(() => createRouter());

  return (
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  );
}
