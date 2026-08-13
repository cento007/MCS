import {
  type Db,
  findAdrBySourceSession,
  insertAdr,
  type Logger,
  recordSyncAudit,
  schema,
} from '@mc/shared';
import { and, asc, desc, eq, isNotNull, ne, sql } from 'drizzle-orm';
import { type AdrDraft, draftAdrFromSession, type SessionEvidence } from './adr-draft.js';
import type { WorkerOutbox } from './outbox.js';

/**
 * `adr.generate` — draft an ADR from a Session (TDS 04 §9's
 * `POST /sessions/{id}/generate-adr`, which answered `202 { jobId }` and left the work here).
 *
 * The **drafting** is `adr-draft.ts` (pure, deterministic, and unit-tested without a database);
 * this file is the reads, the write, and the idempotency.
 *
 * ## Idempotency anchor: `adrs.source_session_id`
 *
 * Delivery is at-least-once (F6.3). The handler asks "does an ADR from this session already
 * exist" first, and stops if one does — so a redelivered job cannot produce a second ADR, and
 * neither can an operator double-clicking the button. The consequence is stated in the
 * contract: **one generated ADR per Session in V1.** A second decision from the same session is
 * created by hand, which is also the only way to give it a title that distinguishes it.
 *
 * The ADR is created `proposed` (there is no `draft` — §9, A4) and is **not** written to the
 * vault here: the next sync run picks it up like any other ADR, because export is derived from
 * the database rather than pushed per write.
 */

export const MAX_DRAFT_PROMPTS = 10;
export const MAX_DRAFT_PROMPT_CHARACTERS = 2_000;
export const MAX_DRAFT_OUTCOME_CHARACTERS = 6_000;
export const MAX_DRAFT_FILES = 50;

/** The `adr.generate` payload (a job, not an event — TDS 04 §15.2). */
export type AdrGenerationJob = { readonly sessionId: string };

export type AdrGenerationKind = 'created' | 'already_exists' | 'session_missing';

export interface AdrGenerationResult {
  readonly kind: AdrGenerationKind;
  readonly sessionId: string;
  readonly adrId: string | null;
  readonly adrNumber: number | null;
}

export interface AdrGenerationOptions {
  readonly db: Db;
  readonly outbox: WorkerOutbox;
  readonly logger: Logger;
}

export class AdrGenerationService {
  readonly #db: Db;
  readonly #outbox: WorkerOutbox;
  readonly #logger: Logger;

  constructor(options: AdrGenerationOptions) {
    this.#db = options.db;
    this.#outbox = options.outbox;
    this.#logger = options.logger;
  }

  async generate(job: AdrGenerationJob): Promise<AdrGenerationResult> {
    const { sessionId } = job;

    const existing = await findAdrBySourceSession(this.#db, sessionId);
    if (existing !== null) {
      this.#logger.debug(
        { sessionId, adrId: existing.id },
        'an ADR already exists for this session — nothing drafted',
      );
      return {
        kind: 'already_exists',
        sessionId,
        adrId: existing.id,
        adrNumber: existing.adrNumber,
      };
    }

    const evidence = await readSessionEvidence(this.#db, sessionId);
    if (evidence === null) {
      // The Session was deleted between the request and this job. Nothing to draft, nothing
      // broken: log it and complete the job rather than retrying against a row that is gone.
      this.#logger.warn({ sessionId }, 'generate-adr job named a session that no longer exists');
      return { kind: 'session_missing', sessionId, adrId: null, adrNumber: null };
    }

    const draft = draftAdrFromSession(evidence.evidence);
    const created = await this.#write(evidence.projectId, sessionId, draft);

    this.#logger.info(
      { sessionId, adrId: created.id, adrNumber: created.adrNumber },
      'drafted an ADR from a session',
    );

    return {
      kind: 'created',
      sessionId,
      adrId: created.id,
      adrNumber: created.adrNumber,
    };
  }

  async #write(projectId: string, sessionId: string, draft: AdrDraft) {
    return this.#outbox.run(async (ctx) => {
      const adr = await insertAdr(ctx.tx, {
        projectId,
        title: draft.title,
        // `proposed` by construction — `insertAdr` defaults to it, stated here for the reader.
        status: 'proposed',
        context: draft.context,
        decision: draft.decision,
        alternatives: draft.alternatives,
        consequences: draft.consequences,
        sourceSessionId: sessionId,
      });

      await ctx.emit(
        this.#outbox.event(
          'adr.created',
          { adrId: adr.id, projectId, sourceSessionId: sessionId },
          { correlationId: adr.id },
        ),
      );

      await recordSyncAudit(ctx.tx, {
        action: 'adr.generated',
        entityType: 'adrs',
        entityId: adr.id,
        after: { title: adr.title, adrNumber: adr.adrNumber, sourceSessionId: sessionId },
      });

      return adr;
    });
  }
}

interface EvidenceRead {
  readonly projectId: string;
  readonly evidence: SessionEvidence;
}

/**
 * Everything the draft is built from, in four bounded queries.
 *
 * Bounded because a session can hold thousands of messages and a draft that pulled all of them
 * into memory would be a worker that stalls on the one session worth writing an ADR about.
 */
export async function readSessionEvidence(db: Db, sessionId: string): Promise<EvidenceRead | null> {
  const rows = await db
    .select({
      id: schema.sessions.id,
      projectId: schema.sessions.projectId,
      projectName: schema.projects.name,
      repositoryName: schema.repositories.name,
      title: schema.sessions.title,
      state: schema.sessions.state,
      sessionType: schema.sessions.sessionType,
      runtime: schema.sessions.runtime,
      model: schema.sessions.model,
      branch: schema.sessions.branch,
      workingDir: schema.sessions.workingDir,
      startedAt: schema.sessions.startedAt,
      completedAt: schema.sessions.completedAt,
      durationMs: schema.sessions.durationMs,
      numTurns: schema.sessions.numTurns,
      totalCostUsd: schema.sessions.totalCostUsd,
      failureReason: schema.sessions.failureReason,
    })
    .from(schema.sessions)
    .leftJoin(schema.projects, eq(schema.projects.id, schema.sessions.projectId))
    .leftJoin(schema.repositories, eq(schema.repositories.id, schema.sessions.repositoryId))
    .where(eq(schema.sessions.id, sessionId))
    .limit(1);

  const session = rows[0];
  if (session === undefined) return null;

  const [prompts, promptsTotal, outcome, files, filesTotal] = await Promise.all([
    db
      .select({
        content: sql<string>`left(${schema.messages.content}, ${MAX_DRAFT_PROMPT_CHARACTERS})`,
      })
      .from(schema.messages)
      .where(and(eq(schema.messages.sessionId, sessionId), eq(schema.messages.role, 'user')))
      .orderBy(asc(schema.messages.ordinal))
      .limit(MAX_DRAFT_PROMPTS),

    countMessages(
      db,
      and(eq(schema.messages.sessionId, sessionId), eq(schema.messages.role, 'user')),
    ),

    db
      .select({
        content: sql<string>`left(${schema.messages.content}, ${MAX_DRAFT_OUTCOME_CHARACTERS})`,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.sessionId, sessionId),
          eq(schema.messages.role, 'assistant'),
          ne(schema.messages.content, ''),
        ),
      )
      .orderBy(desc(schema.messages.ordinal))
      .limit(1),

    db
      .selectDistinct({ path: schema.messages.toolFilePath })
      .from(schema.messages)
      .where(and(eq(schema.messages.sessionId, sessionId), isNotNull(schema.messages.toolFilePath)))
      .orderBy(asc(schema.messages.toolFilePath))
      .limit(MAX_DRAFT_FILES),

    countDistinctFiles(db, sessionId),
  ]);

  return {
    projectId: session.projectId,
    evidence: {
      sessionId: session.id,
      title: session.title,
      state: session.state,
      sessionType: session.sessionType,
      runtime: session.runtime,
      model: session.model,
      branch: session.branch,
      workingDir: session.workingDir,
      projectName: session.projectName,
      repositoryName: session.repositoryName,
      startedAt: session.startedAt,
      completedAt: session.completedAt,
      durationMs: session.durationMs,
      numTurns: session.numTurns,
      totalCostUsd: session.totalCostUsd,
      failureReason: session.failureReason,
      prompts: prompts.map((row) => row.content),
      promptsTotal,
      outcome: outcome[0]?.content ?? null,
      files: files.map((row) => row.path).filter((path): path is string => path !== null),
      filesTotal,
    },
  };
}

async function countMessages(db: Db, where: ReturnType<typeof and>): Promise<number> {
  const result = await db
    .select({ total: sql<string>`count(*)` })
    .from(schema.messages)
    .where(where);
  return Number(result[0]?.total ?? 0);
}

async function countDistinctFiles(db: Db, sessionId: string): Promise<number> {
  const result = await db
    .select({ total: sql<string>`count(DISTINCT ${schema.messages.toolFilePath})` })
    .from(schema.messages)
    .where(and(eq(schema.messages.sessionId, sessionId), isNotNull(schema.messages.toolFilePath)));
  return Number(result[0]?.total ?? 0);
}
