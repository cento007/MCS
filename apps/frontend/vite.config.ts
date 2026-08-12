import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Resolve `@mc/shared` to SOURCE, mirroring the tsconfig path aliases, so the SPA never
 *  waits on a `packages/shared` build. Most specific alias first — Vite matches prefixes. */
const sharedAliases = [
  {
    find: '@mc/shared/types',
    replacement: fileURLToPath(new URL('../../packages/shared/src/types.ts', import.meta.url)),
  },
  {
    find: '@mc/shared',
    replacement: fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
  },
];

/**
 * Vite config (TDS 05 §12, F2.3).
 *
 * Dev: the Vite dev server proxies `/api` to the Backend on 127.0.0.1:8710 **with
 * `ws: true`** so the `/api/v1/ws` upgrade traverses the proxy. Same-origin in dev and in
 * prod means there is no CORS branch anywhere in the system.
 *
 * Prod: `vite build` emits static assets that the Backend serves directly with SPA
 * fallback — there is no frontend process in the F2.1 topology and no separate systemd
 * unit. The SPA needs no build-time environment configuration in V1: every URL is
 * same-origin relative and everything user-configurable comes from the Settings API at
 * runtime.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: sharedAliases },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8710',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
