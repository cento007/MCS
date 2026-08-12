import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/**
 * Frontend unit tier (TDS 07 §4: "Vitest + Testing Library + jsdom for reducers/hooks/
 * components; the WebSocket client layer is unit-tested against a scripted in-memory socket
 * implementing the same frame contract verified in §6").
 *
 * Separate from `vite.config.ts` on purpose: the test run needs the React plugin (JSX in
 * component tests) but not the Tailwind CSS pipeline, and loading Tailwind would make every
 * test pay for a stylesheet build it never asserts against.
 *
 * `environment: 'jsdom'` applies to the whole project rather than per-glob. Pure-logic
 * suites run happily under jsdom, and a split environment is one more thing that can be
 * configured wrong in a file that nobody reads until it breaks. **No database and no
 * network is involved at any point** — `pnpm test` must keep working on a bare checkout.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@mc/shared/types',
        replacement: fileURLToPath(new URL('../../packages/shared/src/types.ts', import.meta.url)),
      },
      {
        find: '@mc/shared',
        replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    name: 'frontend',
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.int.test.ts'],
  },
});
