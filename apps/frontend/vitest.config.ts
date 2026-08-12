import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Separate from `vite.config.ts` on purpose: the unit tier does not need the Tailwind or
 * React plugins, and loading them would make every test run pay for a CSS pipeline.
 * Component/DOM tests (Testing Library + jsdom, TDS 07 §4) are added by WS4 along with
 * the first component that needs them.
 */
export default defineConfig({
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
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.int.test.ts'],
  },
});
