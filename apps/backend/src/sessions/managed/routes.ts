import type { FastifyInstance } from 'fastify';
import { requirePrincipal } from '../../auth/guard.js';
import { dataEnvelope } from '../../http/errors.js';
import { MAX_PROMPT_BYTES, type PromptService } from './prompts.js';

/**
 * `POST /api/v1/sessions/{id}/prompts` — TDS 04 §6.4.
 *
 * Its own route module, registered alongside `sessions/routes.ts` rather than inside it: the
 * endpoint exists only when a managed runtime is wired, and §6.4's `202` promises a stream that
 * nothing else in this Backend can produce.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const paramsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const bodySchema = {
  type: 'object',
  required: ['content'],
  additionalProperties: false,
  properties: {
    // `maxLength` counts UTF-16 units and the limit is bytes, so it is a cheap upper guard only;
    // `bodyLimit` below is the byte-exact one, and the service re-checks for the WS path.
    content: { type: 'string', minLength: 1, maxLength: MAX_PROMPT_BYTES },
  },
} as const;

export interface PromptRoutesOptions {
  readonly prompts: PromptService;
}

export function registerPromptRoutes(app: FastifyInstance, options: PromptRoutesOptions): void {
  app.post<{ Params: { id: string }; Body: { content: string } }>(
    '/api/v1/sessions/:id/prompts',
    {
      schema: { params: paramsSchema, body: bodySchema },
      // §6.4 "Request (max 256 KiB)" — a quarter of the app-wide 1 MiB default (`app.ts`).
      bodyLimit: MAX_PROMPT_BYTES,
    },
    async (request, reply) => {
      const result = await options.prompts.submit({
        principal: requirePrincipal(request),
        sessionId: request.params.id,
        content: request.body.content,
      });

      // 202, not 201: the Message is committed, and the assistant turn it triggers arrives on
      // `session:{id}` rather than in this response.
      reply.code(202);
      return dataEnvelope({ messageId: result.messageId });
    },
  );
}
