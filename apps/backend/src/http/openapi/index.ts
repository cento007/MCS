import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildOpenApiDocument } from './build.js';
import { toYaml } from './yaml.js';

/**
 * `openapi/` — the F5.1 contract document, generated from the route table (`route-table.ts`).
 *
 * See `build.ts` for what the document does and does not claim, and why it is built here
 * rather than by `@fastify/swagger`.
 */

export * from './build.js';
export * from './yaml.js';

/**
 * Where the committed document lives: the repository root, one directory above `apps/`.
 *
 * Resolved from this module's own location rather than from `process.cwd()`, so `pnpm
 * api:spec` writes the same file whether it is run from the repo root, from `apps/backend`, or
 * from a test.
 */
export const OPENAPI_DOCUMENT_PATH = fileURLToPath(
  new URL('../../../../../openapi.yaml', import.meta.url),
);

/**
 * Render the document for a built app.
 *
 * `app.ready()` must have resolved: routes registered inside a plugin (the WebSocket hub, the
 * managed-session prompt route) reach the route table only when the plugin tree is built.
 */
export function renderOpenApiYaml(app: FastifyInstance): string {
  return toYaml(buildOpenApiDocument(app.apiRoutes));
}
