/**
 * `memory_items` — the relational spine, read and written.
 *
 * The vectors live in Qdrant; this table answers "what is this hit, where did it come from, and
 * may this caller see it" (see the table's own header). Everything here is either a read the
 * indexer needs to decide what changed, or a write that keeps the two stores agreeing.
 *
 * ## The point id is derived, not random, and that is what makes a crash harmless
 *
 * `qdrant_point_id` is `uuid8(sha256(sourceType | sourceKey | ordinal | model))` — a pure
 * function of what the point *is*. `memory_items.id` stays a UUIDv7 per F4.2; the point id is
 * its own column precisely so it can be something else.
 *
 * Ingestion writes the vector before it commits the row. Without derivation, a crash in that
 * window leaves a point whose id nothing will ever generate again: permanent garbage in the
 * collection, invisible to every query and to every clean-up. With derivation the next run
 * computes the same id and overwrites it. The alternative ordering — row first, vector second —
 * was rejected because its crash window leaves a row that *claims* to be indexed while no vector
 * exists, and that failure is silent at query time rather than merely untidy.
 *
 * ## Removal order: rows first, points second
 *
 * Also deliberate, and also chosen by which crash window is survivable. Rows first leaves an
 * **orphan point**, which is inert: retrieval hydrates every hit from `memory_items` by
 * `memoryItemId` and drops a hit with no row, so an orphan can never answer a query. Points
 * first would leave a row marked `indexed_at` with nothing behind it — a chunk that has silently
 * vanished from search while every counter says it is there.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { type Db, type DbTransaction, schema } from '../db/index.js';
import type { MemorySourceType, MemoryTier } from '../entities/memory.js';
import { newId } from '../events/envelope.js';

type DbLike = Db | DbTransaction;

export type MemoryItemRow = typeof schema.memoryItems.$inferSelect;

/** The identity of a source, as the two partial unique indexes see it. */
export interface SourceKey {
  readonly sourceType: MemorySourceType;
  readonly sourceId: string | null;
  readonly sourceRef: string | null;
}

/** `sha256` of a chunk's text, as 64 lowercase hex — the `content_hash` column, verbatim. */
export function hashChunk(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The deterministic Qdrant point id for one chunk.
 *
 * RFC 9562 version 8 (custom): the first 16 bytes of a SHA-256 with the version and variant
 * nibbles set. Version 8 is the one the spec reserves for exactly this — "vendor-specific"
 * derivation — so the value is a well-formed UUID that no generator will ever collide with,
 * and Qdrant (which accepts UUID or unsigned-integer point ids) takes it as-is.
 *
 * The NUL separator matters: without it `('adr', 'x1', 0)` and `('adr', 'x', 10)` would hash
 * the same string, and two different chunks would fight over one point.
 */
const SEPARATOR = '\u0000';

export function derivePointId(key: SourceKey, ordinal: number, embeddingModel: string): string {
  const identity = key.sourceId ?? key.sourceRef ?? '';
  const digest = createHash('sha256')
    .update([key.sourceType, identity, String(ordinal), embeddingModel].join(SEPARATOR))
    .digest();

  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // Version 8 in the high nibble of byte 6; RFC variant `10` in the top bits of byte 8.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Match one source's rows under one model — the two partial unique indexes, as a predicate. */
function sourceCondition(key: SourceKey, embeddingModel: string) {
  const base = [
    eq(schema.memoryItems.sourceType, key.sourceType),
    eq(schema.memoryItems.embeddingModel, embeddingModel),
  ];

  return key.sourceId === null
    ? and(...base, eq(schema.memoryItems.sourceRef, key.sourceRef ?? ''))
    : and(...base, eq(schema.memoryItems.sourceId, key.sourceId));
}

/** Every stored chunk of one source under one model, ordinal-ordered. */
export async function readSourceRows(
  db: DbLike,
  key: SourceKey,
  embeddingModel: string,
): Promise<MemoryItemRow[]> {
  return db
    .select()
    .from(schema.memoryItems)
    .where(sourceCondition(key, embeddingModel))
    .orderBy(schema.memoryItems.chunkOrdinal);
}

export interface MemoryItemWrite {
  readonly id: string;
  readonly tier: MemoryTier;
  readonly projectId: string | null;
  readonly sessionId: string | null;
  readonly sourceType: MemorySourceType;
  readonly sourceId: string | null;
  readonly sourceRef: string | null;
  readonly chunkOrdinal: number;
  readonly content: string;
  readonly contentHash: string;
  readonly embeddingModel: string;
  readonly embeddingDimension: number;
  readonly qdrantPointId: string;
  readonly indexedAt: Date;
}

/**
 * Insert or update one chunk's row.
 *
 * `ON CONFLICT` against whichever partial unique index applies, so a redelivered job that
 * re-indexes the same source converges instead of failing on a duplicate key. The conflict
 * target must name the index's `WHERE` clause too, or PostgreSQL cannot tell which of the two
 * partial indexes is meant.
 */
export async function upsertMemoryItem(tx: DbTransaction, write: MemoryItemWrite): Promise<void> {
  const shared = {
    tier: write.tier,
    projectId: write.projectId,
    sessionId: write.sessionId,
    content: write.content,
    contentHash: write.contentHash,
    embeddingDimension: write.embeddingDimension,
    qdrantPointId: write.qdrantPointId,
    indexedAt: write.indexedAt,
    updatedAt: write.indexedAt,
  };

  await tx
    .insert(schema.memoryItems)
    .values({
      id: write.id,
      sourceType: write.sourceType,
      sourceId: write.sourceId,
      sourceRef: write.sourceRef,
      chunkOrdinal: write.chunkOrdinal,
      embeddingModel: write.embeddingModel,
      ...shared,
    })
    .onConflictDoUpdate({
      target:
        write.sourceId === null
          ? [
              schema.memoryItems.sourceType,
              schema.memoryItems.sourceRef,
              schema.memoryItems.chunkOrdinal,
              schema.memoryItems.embeddingModel,
            ]
          : [
              schema.memoryItems.sourceType,
              schema.memoryItems.sourceId,
              schema.memoryItems.chunkOrdinal,
              schema.memoryItems.embeddingModel,
            ],
      targetWhere:
        write.sourceId === null
          ? isNotNull(schema.memoryItems.sourceRef)
          : isNotNull(schema.memoryItems.sourceId),
      set: shared,
    });
}

export async function deleteMemoryItemsByIds(
  tx: DbTransaction,
  ids: readonly string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const deleted = await tx
    .delete(schema.memoryItems)
    .where(inArray(schema.memoryItems.id, [...ids]))
    .returning({ id: schema.memoryItems.id });
  return deleted.length;
}

/** Every row of one source, under every model. The purge path (archive, delete, prune). */
export async function deleteSourceRows(tx: DbTransaction, key: SourceKey): Promise<string[]> {
  const condition =
    key.sourceId === null
      ? and(
          eq(schema.memoryItems.sourceType, key.sourceType),
          eq(schema.memoryItems.sourceRef, key.sourceRef ?? ''),
        )
      : and(
          eq(schema.memoryItems.sourceType, key.sourceType),
          eq(schema.memoryItems.sourceId, key.sourceId),
        );

  const deleted = await tx
    .delete(schema.memoryItems)
    .where(condition)
    .returning({ id: schema.memoryItems.id });
  return deleted.map((row) => row.id);
}

/** Rows written by a model other than the configured one — the partial re-index work list. */
export async function countRowsForOtherModels(db: DbLike, embeddingModel: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.memoryItems)
    .where(ne(schema.memoryItems.embeddingModel, embeddingModel));
  return rows[0]?.count ?? 0;
}

export async function deleteRowsForOtherModels(
  tx: DbTransaction,
  embeddingModel: string,
): Promise<number> {
  const deleted = await tx
    .delete(schema.memoryItems)
    .where(ne(schema.memoryItems.embeddingModel, embeddingModel))
    .returning({ id: schema.memoryItems.id });
  return deleted.length;
}

/** Distinct models present in the table. The rebuild path reports these to the operator. */
export async function listIndexedModels(db: DbLike): Promise<string[]> {
  const rows = await db
    .selectDistinct({ model: schema.memoryItems.embeddingModel })
    .from(schema.memoryItems);
  return rows.map((row) => row.model).sort();
}

/**
 * Rows whose vector never landed (`indexed_at IS NULL`).
 *
 * Nothing in the current write path can produce one — the vector is upserted before the row is
 * committed — so a non-zero count means an older build, a hand-edit, or a bug. Reported by the
 * backfill so it is visible rather than merely possible.
 */
export async function countUnindexedRows(db: DbLike): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.memoryItems)
    .where(isNull(schema.memoryItems.indexedAt));
  return rows[0]?.count ?? 0;
}

export interface MemoryItemCounts {
  readonly total: number;
  readonly byModel: ReadonlyMap<string, number>;
  readonly bySourceType: ReadonlyMap<string, number>;
}

export async function countMemoryItems(db: DbLike): Promise<MemoryItemCounts> {
  const [byModel, bySourceType] = await Promise.all([
    db
      .select({ key: schema.memoryItems.embeddingModel, count: sql<number>`count(*)::int` })
      .from(schema.memoryItems)
      .groupBy(schema.memoryItems.embeddingModel),
    db
      .select({ key: schema.memoryItems.sourceType, count: sql<number>`count(*)::int` })
      .from(schema.memoryItems)
      .groupBy(schema.memoryItems.sourceType),
  ]);

  let total = 0;
  for (const row of byModel) total += row.count;

  return {
    total,
    byModel: new Map(byModel.map((row) => [row.key, row.count])),
    bySourceType: new Map(bySourceType.map((row) => [row.key, row.count])),
  };
}

/**
 * Hydrate search hits.
 *
 * Returned as a Map because a vector search answers with ids in *score* order and a `WHERE id IN
 * (…)` answers in whatever order the planner likes; re-sorting a list is a bug waiting to
 * happen, looking one up by id is not. A hit whose id is absent here is dropped by the caller —
 * that is the mechanism that makes an orphan point unable to answer a query.
 */
export async function readMemoryItemsByIds(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, MemoryItemRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(schema.memoryItems)
    .where(inArray(schema.memoryItems.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

export async function findMemoryItem(db: DbLike, id: string): Promise<MemoryItemRow | null> {
  const rows = await db
    .select()
    .from(schema.memoryItems)
    .where(eq(schema.memoryItems.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Every stored chunk of one Session, deleted — the purge that follows an archive.
 *
 * Returns the ids it deleted, because the points behind them have to be deleted through the
 * vector store by the same ids and the caller owns that port.
 */
export async function deleteMemoryItemsForSession(
  tx: DbTransaction,
  sessionId: string,
): Promise<string[]> {
  const deleted = await tx
    .delete(schema.memoryItems)
    .where(eq(schema.memoryItems.sessionId, sessionId))
    .returning({ id: schema.memoryItems.id });
  return deleted.map((row) => row.id);
}

/** A fresh row id. Kept here so callers never reach for `newId` and get the convention wrong. */
export function newMemoryItemId(): string {
  return newId();
}

// ------------------------------------------------------------------ source enumeration (backfill)

/**
 * One page of sources to index, keyset-paginated on the UUIDv7 primary key.
 *
 * Keyset rather than `OFFSET` for the same reason every list in this product is (F5.3): a
 * backfill runs over minutes while new Sessions and Commits are being written, and an offset
 * page would skip rows as the table grows underneath it. `id > cursor` is stable under insert.
 */
export interface SourcePage<T> {
  readonly rows: readonly T[];
  /** The id to resume after, or `null` when the source type is exhausted. */
  readonly nextCursor: string | null;
}

function pageOf<T extends { id: string }>(rows: T[], limit: number): SourcePage<T> {
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: rows.length < limit || last === undefined ? null : last.id,
  };
}

export interface SessionSourceRow {
  readonly id: string;
  readonly projectId: string;
  readonly title: string | null;
  readonly state: string;
  readonly occurredAt: Date;
}

/**
 * Sessions worth indexing: everything that is not `archived`.
 *
 * Archiving is the product's retention action, and the memory rule that follows from it is
 * purge-on-archive (see `indexer.ts`) — so an archived Session must not be re-indexed by the
 * very next backfill, or the purge would be undone on a schedule.
 */
export async function listSessionSources(
  db: DbLike,
  input: { readonly limit: number; readonly afterId?: string | undefined },
): Promise<SourcePage<SessionSourceRow>> {
  const conditions = [ne(schema.sessions.state, 'archived')];
  if (input.afterId !== undefined) conditions.push(sql`${schema.sessions.id} > ${input.afterId}`);

  const rows = await db
    .select({
      id: schema.sessions.id,
      projectId: schema.sessions.projectId,
      title: schema.sessions.title,
      state: schema.sessions.state,
      completedAt: schema.sessions.completedAt,
      createdAt: schema.sessions.createdAt,
    })
    .from(schema.sessions)
    .where(and(...conditions))
    .orderBy(schema.sessions.id)
    .limit(input.limit);

  return pageOf(
    rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      title: row.title,
      state: row.state,
      occurredAt: row.completedAt ?? row.createdAt,
    })),
    input.limit,
  );
}

export interface TurnRow {
  readonly role: string;
  readonly content: string;
}

/** One Session's conversation turns, ordinal-ordered. Tool and system rows are excluded. */
export async function readSessionTurns(
  db: DbLike,
  sessionId: string,
  limit: number,
): Promise<TurnRow[]> {
  const rows = await db
    .select({ role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.sessionId, sessionId),
        inArray(schema.messages.role, ['user', 'assistant']),
      ),
    )
    .orderBy(schema.messages.ordinal)
    .limit(limit);

  return rows;
}

export interface CommitSourceRow {
  readonly id: string;
  readonly projectId: string;
  readonly sha: string;
  readonly message: string;
  readonly authorName: string;
  readonly branch: string | null;
  readonly files: typeof schema.commits.$inferSelect.files;
  readonly committedAt: Date;
}

/**
 * Commits of repositories that belong to a Project.
 *
 * `repositories.project_id` is nullable — discovery registers a repository before the operator
 * assigns it (TDS 03 §3.6) — and a commit with no Project cannot be `project`-tier, because
 * `ck_memory_items_tier_scope` requires the two to agree. Filing it under `global` instead was
 * rejected: an unassigned repository's commits are not organisation-wide knowledge, they are
 * knowledge whose scope is not yet decided. So they wait, and assigning the repository makes
 * the next backfill pick them up.
 */
export async function listCommitSources(
  db: DbLike,
  input: { readonly limit: number; readonly afterId?: string | undefined },
): Promise<SourcePage<CommitSourceRow>> {
  const conditions = [isNotNull(schema.repositories.projectId)];
  if (input.afterId !== undefined) conditions.push(sql`${schema.commits.id} > ${input.afterId}`);

  const rows = await db
    .select({
      id: schema.commits.id,
      projectId: schema.repositories.projectId,
      sha: schema.commits.sha,
      message: schema.commits.message,
      authorName: schema.commits.authorName,
      branch: schema.commits.branch,
      files: schema.commits.files,
      committedAt: schema.commits.committedAt,
    })
    .from(schema.commits)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.commits.repositoryId))
    .where(and(...conditions))
    .orderBy(schema.commits.id)
    .limit(input.limit);

  return pageOf(
    rows.map((row) => ({ ...row, projectId: row.projectId ?? '' })),
    input.limit,
  );
}

export interface AdrSourceRow {
  readonly id: string;
  readonly projectId: string;
  readonly adrNumber: number;
  readonly title: string;
  readonly status: string;
  readonly context: string;
  readonly decision: string;
  readonly alternatives: string;
  readonly consequences: string;
  readonly updatedAt: Date;
}

export async function listAdrSources(
  db: DbLike,
  input: { readonly limit: number; readonly afterId?: string | undefined },
): Promise<SourcePage<AdrSourceRow>> {
  const conditions = [];
  if (input.afterId !== undefined) conditions.push(sql`${schema.adrs.id} > ${input.afterId}`);

  const rows = await db
    .select({
      id: schema.adrs.id,
      projectId: schema.adrs.projectId,
      adrNumber: schema.adrs.adrNumber,
      title: schema.adrs.title,
      status: schema.adrs.status,
      context: schema.adrs.context,
      decision: schema.adrs.decision,
      alternatives: schema.adrs.alternatives,
      consequences: schema.adrs.consequences,
      updatedAt: schema.adrs.updatedAt,
    })
    .from(schema.adrs)
    .where(conditions.length === 0 ? undefined : and(...conditions))
    .orderBy(schema.adrs.id)
    .limit(input.limit);

  return pageOf(rows, input.limit);
}

export interface PullRequestSourceRow {
  readonly id: string;
  readonly projectId: string;
  readonly number: number;
  readonly title: string;
  readonly description: string | null;
  readonly state: string;
  readonly updatedAt: Date;
}

export async function listPullRequestSources(
  db: DbLike,
  input: { readonly limit: number; readonly afterId?: string | undefined },
): Promise<SourcePage<PullRequestSourceRow>> {
  // Same Project requirement as `listCommitSources`, for the same reason.
  const conditions = [isNotNull(schema.repositories.projectId)];
  if (input.afterId !== undefined)
    conditions.push(sql`${schema.pullRequests.id} > ${input.afterId}`);

  const rows = await db
    .select({
      id: schema.pullRequests.id,
      projectId: schema.repositories.projectId,
      number: schema.pullRequests.number,
      title: schema.pullRequests.title,
      description: schema.pullRequests.description,
      state: schema.pullRequests.state,
      updatedAt: schema.pullRequests.updatedAt,
    })
    .from(schema.pullRequests)
    .innerJoin(schema.repositories, eq(schema.repositories.id, schema.pullRequests.repositoryId))
    .where(and(...conditions))
    .orderBy(schema.pullRequests.id)
    .limit(input.limit);

  return pageOf(
    rows.map((row) => ({ ...row, projectId: row.projectId ?? '' })),
    input.limit,
  );
}

/**
 * Memory rows whose source row has disappeared.
 *
 * A hard `DELETE` of a Session or a Project takes its `memory_items` with it by cascade, and a
 * `commits` row can be deleted with its Repository — but `source_id` is polymorphic and carries
 * no FK, so a deleted Commit leaves its chunks behind. This is the sweep that finds them, run
 * once per full backfill rather than per source: it is a left join over the whole table, which
 * is cheap at this scale and pointless to repeat per batch.
 */
export async function listOrphanedMemoryItemIds(db: DbLike, limit: number): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT mi.id
      FROM memory_items mi
     WHERE mi.source_id IS NOT NULL
       AND (
            (mi.source_type = 'session'      AND NOT EXISTS (SELECT 1 FROM sessions s      WHERE s.id = mi.source_id))
         OR (mi.source_type = 'commit'       AND NOT EXISTS (SELECT 1 FROM commits c      WHERE c.id = mi.source_id))
         OR (mi.source_type = 'adr'          AND NOT EXISTS (SELECT 1 FROM adrs a        WHERE a.id = mi.source_id))
         OR (mi.source_type = 'pull_request' AND NOT EXISTS (SELECT 1 FROM pull_requests p WHERE p.id = mi.source_id))
       )
     LIMIT ${limit}
  `);
  return rows.rows.map((row) => row.id);
}

/**
 * Chunks of Sessions that have since been archived.
 *
 * Purge-on-archive is event-driven, and an event can be missed — a Backend restart between the
 * transition and the job, an archive performed by an older build. The backfill re-derives the
 * rule from state instead of trusting that every event arrived.
 */
export async function listArchivedSessionMemoryItemIds(
  db: DbLike,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.memoryItems.id })
    .from(schema.memoryItems)
    .innerJoin(schema.sessions, eq(schema.sessions.id, schema.memoryItems.sessionId))
    .where(eq(schema.sessions.state, 'archived'))
    .limit(limit);
  return rows.map((row) => row.id);
}
