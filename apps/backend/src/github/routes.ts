import { createJob, type Db, QUEUE_NAMES, type Queue } from '@mc/shared';
import type { FastifyInstance } from 'fastify';
import { jobAcceptedSchema } from '../adrs/response-schemas.js';
import { recordAuditEntry } from '../audit/index.js';
import { requirePrincipal } from '../auth/guard.js';
import { requestContextOf } from '../http/context.js';
import { ApiError, dataEnvelope } from '../http/errors.js';
import { dataEnvelopeSchema } from '../http/response-schema.js';
import { findRepositoryById } from '../repositories/store.js';
import type { SecretVault } from '../settings/secrets.js';
import type { RepositoryDiscoveryService } from './discover.js';
import { discoveryReportSchema } from './response-schemas.js';
import { GITHUB_NOT_CONFIGURED_MESSAGE, readGithubToken } from './settings.js';

/**
 * The two GitHub routes TDS 04 §5.1 defines on the Repositories resource. They live here rather
 * than in `repositories/routes.ts` because `github/` owns discovery and polling (TDS 02 §2) —
 * `repositories/` owns the entity, this module owns what GitHub does to it.
 *
 *   POST /api/v1/repositories/discover      200 { data: DiscoveryReport }   ⚠ see `discover.ts`
 *   POST /api/v1/repositories/{id}/sync     202 { data: { jobId } }         per §5.1
 *
 * Two different answers to "is this synchronous", and the difference is not arbitrary:
 *
 *  - **Discovery answers `200` with its report** because the report is the product, and no table
 *    stores a skip reason. The full justification for departing from §5.1's `202 { jobId }` is
 *    in `discover.ts`; it is flagged there, not buried here.
 *  - **Sync answers `202 { jobId }` exactly as §5.1 specifies**, because its outcome *is*
 *    durable and observable without the job id: `syncStatus`, `lastSyncedAt` and `lastSyncError`
 *    on `GET /repositories/{id}`, plus `repository.synced` / `repository.sync_failed` on the
 *    `repositories` WebSocket channel (§14.3). The caller has something real to watch, so the
 *    asynchronous shape costs it nothing.
 *
 * `INTEGRATION_NOT_CONFIGURED` (409) is the answer to "no token saved" on the sync route, and
 * to "no discovery roots saved" on the discover route. That is §7.4's established distinction
 * applied here: Mission Control declining to ask is an error the operator fixes in Settings,
 * whereas GitHub declining to answer is a *result* recorded on the row. Answering 401 for a
 * credential that was never entered would send them to regenerate a token that does not exist.
 */

const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const repositoryIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: UUID_PATTERN } },
} as const;

interface RepositoryIdParams {
  id: string;
}

/** The `repository.sync` job payload — a job name, not an event (TDS 04 §15.2 note). */
export type RepositorySyncJob = {
  readonly repositoryId: string;
  readonly trigger: 'user' | 'schedule';
};

export interface GithubRoutesOptions {
  readonly db: Db;
  readonly queue: Queue;
  readonly vault: SecretVault;
  readonly discovery: RepositoryDiscoveryService;
}

export function registerGithubRoutes(app: FastifyInstance, options: GithubRoutesOptions): void {
  const { db, queue, vault, discovery } = options;

  app.post(
    '/api/v1/repositories/discover',
    { schema: { response: { 200: dataEnvelopeSchema(discoveryReportSchema) } } },
    // §1.2: a bounded, computed read model returns `{ data: … }` with no `meta`.
    async (request) =>
      dataEnvelope(await discovery.discover(requirePrincipal(request), requestContextOf(request))),
  );

  app.post<{ Params: RepositoryIdParams }>(
    '/api/v1/repositories/:id/sync',
    {
      schema: {
        params: repositoryIdParamsSchema,
        response: { 202: dataEnvelopeSchema(jobAcceptedSchema) },
      },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const ctx = requestContextOf(request);
      const repositoryId = request.params.id;

      const repository = await findRepositoryById(db, repositoryId);
      if (repository === null) {
        throw new ApiError('NOT_FOUND', `No repository with id ${repositoryId}`);
      }

      // Checked here as well as in the job: an operator pressing Sync deserves an immediate,
      // specific answer rather than a 202 for work that will silently skip itself. The job
      // re-checks because settings can change between enqueue and run.
      const token = await readGithubToken(db, vault);
      if (token.kind === 'not_configured') {
        throw new ApiError('INTEGRATION_NOT_CONFIGURED', GITHUB_NOT_CONFIGURED_MESSAGE, {
          integration: 'github',
          missing: ['integrations.github.token'],
        });
      }

      // A sync already running for this repository is answered with the same 202 rather than a
      // 409: the operator asked for the repository to be synced, and it is being synced. The
      // job itself is the guard (`RepositorySyncService.sync` returns `skipped: 'in_flight'`),
      // so a double-click cannot start two.
      const job = createJob<RepositorySyncJob>({ repositoryId, trigger: 'user' });

      await db.transaction(async (tx) => {
        await queue.enqueueJob(tx, QUEUE_NAMES.REPOSITORY_SYNC, job);

        await recordAuditEntry(tx, {
          actorType: 'user',
          actorId: principal.userId,
          action: 'repository.sync_requested',
          entityType: 'repositories',
          entityId: repositoryId,
          after: { jobId: job.id, trigger: 'user' },
          requestId: ctx.requestId,
          ipAddress: ctx.ipAddress,
        });
      });

      reply.code(202);
      return dataEnvelope({ jobId: job.id });
    },
  );
}
