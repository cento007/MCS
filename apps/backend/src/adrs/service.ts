import {
  createJob,
  type Db,
  insertAdr,
  type JobPayload,
  newId,
  QUEUE_NAMES,
  type QueuePort,
} from '@mc/shared';
import { recordAuditEntry } from '../audit/index.js';
import type { Principal } from '../auth/index.js';
import { isUniqueViolation } from '../db/index.js';
import type { Outbox } from '../events/index.js';
import type { RequestContext } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { type AdrResource, serializeAdr } from './serialize.js';
import {
  type AdrRecord,
  type AdrUpdate,
  findAdrById,
  findSessionSummary,
  listAdrs,
  projectExists,
  updateAdr,
} from './store.js';
import { normalizeAdrSection, normalizeAdrStatus, normalizeAdrTitle } from './validation.js';

/**
 * The Adr domain service — TDS 04 §9.
 *
 * Three things worth stating outright:
 *
 * 1. **`proposed` is the only initial status.** There is no `draft` anywhere in this contract
 *    (§9, arbitration A4): an AI-drafted ADR awaiting review *is* `proposed`.
 * 2. **Generation is a job, not a request.** `POST /sessions/{id}/generate-adr` returns `202`
 *    with the queue job's id and the Sync Worker does the work (§9). The Backend never drafts
 *    an ADR inline, so a slow draft cannot occupy a request or a Fastify worker.
 * 3. **There is no delete.** §9 defines list/create/get/patch and nothing else, and that is
 *    right for a decision record: an ADR that turned out to be wrong is `rejected` or
 *    `superseded`, which is history. Nothing here removes a row, so nothing here can orphan a
 *    vault note.
 */

/** How many times a colliding `adr_number` is retried before the caller sees an error. */
const NUMBER_COLLISION_RETRIES = 3;

export interface CreateAdrInput {
  readonly projectId: string;
  readonly title: string;
  readonly status?: string | undefined;
  readonly context?: string | undefined;
  readonly decision?: string | undefined;
  readonly alternatives?: string | undefined;
  readonly consequences?: string | undefined;
}

export interface UpdateAdrInput {
  readonly title?: string | undefined;
  readonly status?: string | undefined;
  readonly context?: string | undefined;
  readonly decision?: string | undefined;
  readonly alternatives?: string | undefined;
  readonly consequences?: string | undefined;
  readonly supersededByAdrId?: string | null | undefined;
}

export interface ListAdrsApiInput {
  readonly limit: number;
  readonly order: 'asc' | 'desc';
  readonly afterId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly status?: string | undefined;
}

/** The `adr.generate` job payload — a job name, not an event (TDS 04 §15.2). */
export type AdrGenerationJob = { readonly sessionId: string };

export interface AdrServiceOptions {
  readonly db: Db;
  readonly outbox: Outbox;
  readonly queue: QueuePort;
}

export class AdrService {
  readonly #db: Db;
  readonly #outbox: Outbox;
  readonly #queue: QueuePort;

  constructor(options: AdrServiceOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#queue = options.queue;
  }

  /** `GET /api/v1/adrs` — cursor list; `?projectId=`, `?status=` filters (§9). */
  async list(input: ListAdrsApiInput): Promise<AdrResource[]> {
    const records = await listAdrs(this.#db, {
      limit: input.limit,
      order: input.order,
      ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.status === undefined ? {} : { status: normalizeAdrStatus(input.status) }),
    });
    return records.map(serializeAdr);
  }

  async get(id: string): Promise<AdrResource> {
    return serializeAdr(await this.#require(id));
  }

  /** `POST /api/v1/adrs` -> `201`. `status` defaults to `proposed` (§9). */
  async create(
    principal: Principal,
    input: CreateAdrInput,
    ctx: RequestContext,
  ): Promise<AdrResource> {
    const title = normalizeAdrTitle(input.title);
    const status = input.status === undefined ? 'proposed' : normalizeAdrStatus(input.status);
    const sections = {
      context: normalizeAdrSection('context', input.context ?? ''),
      decision: normalizeAdrSection('decision', input.decision ?? ''),
      alternatives: normalizeAdrSection('alternatives', input.alternatives ?? ''),
      consequences: normalizeAdrSection('consequences', input.consequences ?? ''),
    };

    if (!(await projectExists(this.#db, input.projectId))) {
      throw new ApiError('VALIDATION_FAILED', 'projectId does not reference a known Project', {
        field: 'projectId',
      });
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = await this.#outbox.run(async (tx) => {
          const created = await insertAdr(tx.tx, {
            projectId: input.projectId,
            title,
            status,
            ...sections,
          });

          await tx.emit(
            this.#outbox.event(
              'adr.created',
              { adrId: created.id, projectId: created.projectId, sourceSessionId: null },
              { correlationId: created.id },
            ),
          );

          await recordAuditEntry(tx.tx, {
            actorType: 'user',
            actorId: principal.userId,
            action: 'adr.created',
            entityType: 'adrs',
            entityId: created.id,
            after: { title: created.title, status: created.status, adrNumber: created.adrNumber },
            requestId: ctx.requestId,
            ipAddress: ctx.ipAddress,
          });

          return created;
        });

        return serializeAdr({ adr: row, syncedAt: null });
      } catch (error) {
        // `adr_number` is `max + 1` per project; two creates committing together collide on
        // `ux_adrs_project_number`. Retrying is correct — the caller asked for an ADR, not for
        // a particular number.
        if (
          isUniqueViolation(error, 'ux_adrs_project_number') &&
          attempt < NUMBER_COLLISION_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * `PATCH /api/v1/adrs/{id}` — edit fields or change status (§9).
   *
   * Setting `supersededByAdrId` **also sets `status` to `superseded`** unless the request says
   * otherwise: §9 describes the two as one operation ("supersede sets supersededByAdrId"), and
   * an ADR pointing at its replacement while still reading `accepted` is a record that
   * contradicts itself.
   */
  async update(
    principal: Principal,
    id: string,
    input: UpdateAdrInput,
    ctx: RequestContext,
  ): Promise<AdrResource> {
    const existing = await this.#require(id);

    const changes: AdrUpdate = {
      ...(input.title === undefined ? {} : { title: normalizeAdrTitle(input.title) }),
      ...(input.status === undefined ? {} : { status: normalizeAdrStatus(input.status) }),
      ...(input.context === undefined
        ? {}
        : { context: normalizeAdrSection('context', input.context) }),
      ...(input.decision === undefined
        ? {}
        : { decision: normalizeAdrSection('decision', input.decision) }),
      ...(input.alternatives === undefined
        ? {}
        : { alternatives: normalizeAdrSection('alternatives', input.alternatives) }),
      ...(input.consequences === undefined
        ? {}
        : { consequences: normalizeAdrSection('consequences', input.consequences) }),
    };

    if (input.supersededByAdrId !== undefined) {
      const target = input.supersededByAdrId;
      if (target !== null) {
        if (target === id) {
          throw new ApiError('VALIDATION_FAILED', 'An ADR cannot supersede itself', {
            field: 'supersededByAdrId',
          });
        }
        if ((await findAdrById(this.#db, target)) === null) {
          throw new ApiError(
            'VALIDATION_FAILED',
            'supersededByAdrId does not reference a known Adr',
            { field: 'supersededByAdrId' },
          );
        }
        if (input.status === undefined) changes.status = 'superseded';
      }
      changes.supersededByAdrId = target;
    }

    if (Object.keys(changes).length === 0) return serializeAdr(existing);

    const changedFields = Object.keys(changes);

    const row = await this.#outbox.run(async (tx) => {
      const updated = await updateAdr(tx.tx, id, changes);
      /* c8 ignore next */
      if (updated === null) throw new ApiError('NOT_FOUND', `No adr with id ${id}`);

      await tx.emit(
        this.#outbox.event('adr.updated', { adrId: id, changedFields }, { correlationId: id }),
      );

      await recordAuditEntry(tx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'adr.updated',
        entityType: 'adrs',
        entityId: id,
        before: fieldSubset(existing.adr, changedFields),
        after: fieldSubset(updated, changedFields),
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });

      return updated;
    });

    return serializeAdr({ adr: row, syncedAt: existing.syncedAt });
  }

  /**
   * `POST /api/v1/sessions/{id}/generate-adr` -> `202 { data: { jobId } }` (§9).
   *
   * `CONFLICT` when the Session is still `created`: nothing has been said in it yet, so there
   * is no decision to draft. Every other F7 state is fair game — a `failed` session is often
   * exactly the one worth recording a decision about.
   *
   * The job id is returned to the caller and is the pg-boss job's own id, so `jobId` names
   * something real.
   */
  async generateFromSession(
    principal: Principal,
    sessionId: string,
    ctx: RequestContext,
  ): Promise<{ jobId: string }> {
    const session = await findSessionSummary(this.#db, sessionId);
    if (session === null) throw new ApiError('NOT_FOUND', `No session with id ${sessionId}`);
    if (session.state === 'created') {
      throw new ApiError(
        'CONFLICT',
        'This session has not run yet, so there is nothing to draft an ADR from',
        { sessionId, state: session.state },
      );
    }

    const jobId = newId();

    await this.#outbox.run(async (tx) => {
      await this.#queue.enqueueJob<AdrGenerationJob & JobPayload>(
        tx.tx,
        QUEUE_NAMES.ADR_GENERATE,
        createJob<AdrGenerationJob & JobPayload>({ sessionId }, jobId),
      );

      await recordAuditEntry(tx.tx, {
        actorType: 'user',
        actorId: principal.userId,
        action: 'adr.generation_requested',
        entityType: 'sessions',
        entityId: sessionId,
        after: { jobId },
        requestId: ctx.requestId,
        ipAddress: ctx.ipAddress,
      });
    });

    return { jobId };
  }

  async #require(id: string): Promise<AdrRecord> {
    const record = await findAdrById(this.#db, id);
    if (record === null) throw new ApiError('NOT_FOUND', `No adr with id ${id}`);
    return record;
  }
}

/** Only the fields this request touched, so the audit diff is a diff (TDS 03 §3.14). */
function fieldSubset(row: Record<string, unknown>, fields: readonly string[]) {
  const view: Record<string, unknown> = {};
  for (const field of fields) view[field] = row[field];
  return view;
}
