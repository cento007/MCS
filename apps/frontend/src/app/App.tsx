import { AppShell } from './shell/AppShell.js';

/**
 * Application root.
 *
 * SCAFFOLD STATE: no router yet. TDS 05 §2.2 specifies React Router v7 in library (data)
 * mode with lazy route modules as the code-split points, and TDS 05 §3 specifies TanStack
 * Query + Zustand for state; both land with WS4.
 */
export function App() {
  return <AppShell />;
}
