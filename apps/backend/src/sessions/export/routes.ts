import type { FastifyInstance } from 'fastify';
import { dataEnvelope } from '../../http/errors.js';
import { dataEnvelopeSchema } from '../../http/response-schema.js';
import { EXPORT_FORMATS, type ExportFormat } from './render.js';
import { contextPackageSchema, sessionExportSchema } from './response-schemas.js';
import type { SessionExportService } from './service.js';

/**
 * `POST /api/v1/sessions/{id}/export` and `POST /api/v1/sessions/{id}/context-package`
 * (TDS 04 §6.7).
 *
 * ## Why both answer with the F5.4 data envelope rather than a file download
 *
 * §6.7 specifies `{ data: { format, filename, content } }` and that is the right shape, for a
 * reason worth writing down rather than inheriting.
 *
 * The SPA's only HTTP path is `lib/api/client.ts`, which sends `credentials: 'same-origin'` for
 * the HTTP-only `mc_session` cookie, parses every response as JSON, and turns every non-2xx into
 * a typed `ApiError` carrying `error.code` and `requestId` (F5.4). A
 * `Content-Disposition: attachment` response is outside all three: the browser would have to
 * fetch it some other way, and the two ways available are both worse. `window.open`/`<a download>`
 * on a `POST` route is not expressible at all — it would force the endpoint to become a `GET`
 * with side-effect-free semantics it does not have. And a `fetch` that reads a blob loses the
 * error envelope: a 409 `CONFLICT` for an unstarted Session arrives as an
 * `application/json` body the download path never inspects, so the operator gets a file called
 * `export.md` containing an error object.
 *
 * With the content in the envelope the SPA builds the `Blob` itself and keeps one error path for
 * the whole API. `filename` is the server's suggestion, so the operator gets the same name
 * whether they save from the browser or script the endpoint — and the name is deterministic in
 * the Session, so a re-export replaces its predecessor instead of accumulating `(1)` copies.
 *
 * TDS 04 §1961 leaves the `Content-Disposition` question open pending transcripts that exceed a
 * 1 MiB response. The export is bounded (`evidence.ts`: 2 000 messages × 20 000 characters is the
 * ceiling, tool payloads excluded, and both bounds are stated in the document when they bite), so
 * that trigger is not reached by construction; if it ever is, the answer is a `202` + job at the
 * same path, which §6.7 already sanctions.
 *
 * ## Strict bodies
 *
 * `additionalProperties: false` on both, and `format` is an enum of one. A caller who sends
 * `{ "format": "json" }` gets a 400 naming the accepted values rather than a Markdown document
 * they did not ask for — see `render.ts` for why `json` is not implemented.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const sessionIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

/**
 * `null` is admitted alongside `object` for the same reason `cloneBodySchema` admits it: a
 * `POST` with no payload arrives as `null`, and `format` has one legal value, so the plainest
 * possible call must not be a 400.
 */
const exportBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: { format: { type: 'string', enum: [...EXPORT_FORMATS] } },
} as const;

const contextPackageBodySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {},
} as const;

interface SessionIdParams {
  id: string;
}

interface ExportBody {
  format?: ExportFormat;
}

export interface SessionExportRoutesOptions {
  readonly service: SessionExportService;
}

export function registerSessionExportRoutes(
  app: FastifyInstance,
  options: SessionExportRoutesOptions,
): void {
  app.post<{ Params: SessionIdParams; Body: ExportBody | null }>(
    '/api/v1/sessions/:id/export',
    {
      schema: {
        params: sessionIdParamsSchema,
        body: exportBodySchema,
        response: { 200: dataEnvelopeSchema(sessionExportSchema) },
      },
    },
    async (request) =>
      dataEnvelope(
        await options.service.export(request.params.id, request.body?.format ?? 'markdown'),
      ),
  );

  app.post<{ Params: SessionIdParams; Body: null }>(
    '/api/v1/sessions/:id/context-package',
    {
      schema: {
        params: sessionIdParamsSchema,
        body: contextPackageBodySchema,
        response: { 200: dataEnvelopeSchema(contextPackageSchema) },
      },
    },
    async (request) => dataEnvelope(await options.service.contextPackage(request.params.id)),
  );
}
