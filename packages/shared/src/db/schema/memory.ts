/**
 * Memory layer: `memory_items` (TDS 03 §6, PRD §6 — Phase 3).
 *
 * TDS 03 §6 reserved this table as a two-column skeleton and said the rest was "entirely
 * deferred to the Phase 3 design doc". This *is* that design, so the skeleton becomes real.
 *
 * ## What this table is for
 *
 * The vectors live in Qdrant (F2.1 #6). This table is the **relational spine**: given a point
 * that came back from a similarity search, it answers three questions and only those three.
 *
 *   1. **What is this vector?** — `content` (or `source_ref`, when the chunk text is owned by a
 *      file rather than by us), `chunk_ordinal`, `content_hash`.
 *   2. **Where did it come from?** — `source_type` + `source_id` | `source_ref`.
 *   3. **May this caller see it?** — `tier` + `project_id` / `session_id` / `agent_id`. V1 has
 *      exactly one local account, so visibility is scope, not ownership; the columns are here so
 *      that a project-scoped query cannot accidentally return another project's memories.
 *
 * ## Why the embedding model and its dimension are columns
 *
 * **Vectors are only comparable within one embedding model.** Change the model, or change its
 * dimension, and every stored vector becomes noise — and the failure is *silent*, because
 * cosine distance will happily rank garbage and hand back a confident answer. The collection
 * carries a stamp that makes writing or querying under a changed model an error
 * (`memory/stamp.ts`); these two columns are the same guarantee at row granularity, and they
 * are what makes a **partial** re-index possible: `WHERE embedding_model <> $current` is the
 * work list, and a row left behind is identifiable rather than merely wrong.
 *
 * ## `qdrant_point_id`
 *
 * Named as TDS 03 §6 names it. In steady state it equals `id`; it is nonetheless its own column
 * because a re-embed writes the new point *before* dropping the old one, and during that window
 * the metadata row's identity (which future rows may reference) must stay stable while the
 * point it addresses does not.
 */

import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import {
  MAX_EMBEDDING_DIMENSION,
  MEMORY_SOURCE_TYPES as MEMORY_SOURCE_TYPE_VOCABULARY,
  MEMORY_TIERS as MEMORY_TIER_VOCABULARY,
  type MemorySourceType,
  type MemoryTier,
} from '../../entities/memory.js';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';
import { projects } from './projects.js';
import { sessions } from './sessions.js';
import { agents } from './skeletons.js';

/** Anchored to the shared vocabulary rather than re-typed, exactly as `sessions.state` is. */
const MEMORY_TIERS = MEMORY_TIER_VOCABULARY satisfies readonly MemoryTier[];
const MEMORY_SOURCE_TYPES = MEMORY_SOURCE_TYPE_VOCABULARY satisfies readonly MemorySourceType[];

/** Matches the settings registry's `MAX_MODEL_NAME_LENGTH` — the value's only source. */
const MAX_MODEL_NAME_LENGTH = 200;
/** A vault-relative path or a URL. Same ceiling the settings registry gives a path. */
const MAX_SOURCE_REF_LENGTH = 1024;

export const memoryItems = pgTable(
  'memory_items',
  {
    /**
     * UUIDv7 (F4.2). Also the Qdrant point id in steady state — see the header and
     * `qdrantPointId` below.
     */
    id: primaryKeyId(),

    // ------------------------------------------------------------------ scope ("may I see it")

    tier: text('tier').notNull(),
    /**
     * Set for `project` and `session` tiers. Denormalized onto session-tier rows on purpose:
     * "everything this project remembers" is the commonest retrieval filter and it must not
     * need a join to `sessions` to answer.
     */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    /**
     * Phase 4. **Nothing writes this in Phase 3** — the `agent` tier has no producer until the
     * agent framework lands. The FK exists now so that landing it is not a migration.
     */
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'cascade' }),

    // ---------------------------------------------------------------- provenance ("where from")

    sourceType: text('source_type').notNull(),
    /** The row this chunk came from, for sources that are rows (`session`, `commit`, `adr`, …). */
    sourceId: uuid('source_id'),
    /**
     * The file this chunk came from, for sources that are files (`obsidian_note`, `document`).
     * Vault-relative, never absolute: an absolute path would break the moment the vault moves,
     * and it would leak an operator's directory layout into an API response.
     */
    sourceRef: text('source_ref'),

    // -------------------------------------------------------------------- content ("what is it")

    /** The chunk ordinal within its source, from 0. Ordering is the source's, not the index's. */
    chunkOrdinal: integer('chunk_ordinal').notNull(),
    /**
     * The chunk text, or `NULL` when `source_ref` points at the file that owns it.
     *
     * Storing the text is the default because retrieval must be able to show *what it matched*
     * without reading six files, and because a source can be deleted while its memory is still
     * worth surfacing. The pointer form exists for sources large enough that duplicating them
     * into PostgreSQL would double the vault on disk for no retrieval benefit.
     */
    content: text('content'),
    /**
     * `sha256(content)` as 64 lowercase hex characters — of the **chunk**, not the source.
     *
     * This is what makes re-indexing idempotent and cheap: a chunk whose hash is unchanged
     * needs no new embedding, which matters because embedding is the slow half of ingestion.
     */
    contentHash: text('content_hash').notNull(),

    // ------------------------------------------------------------------- the stamp ("comparable")

    /** The model that produced this vector, e.g. `nomic-embed-text`. Never blank. */
    embeddingModel: text('embedding_model').notNull(),
    /** Its output dimension, e.g. 768. Must equal the collection's `vectors.size`. */
    embeddingDimension: integer('embedding_dimension').notNull(),
    /** The Qdrant point holding the vector. See the header for why it is not simply `id`. */
    qdrantPointId: uuid('qdrant_point_id').notNull(),

    // ----------------------------------------------------------------------------- timestamps

    /**
     * When the vector was last written to the store. `NULL` means the row exists and the point
     * does not — the crash window between "metadata committed" and "vector upserted", which a
     * reconciliation pass can find with `WHERE indexed_at IS NULL`.
     */
    indexedAt: timestamptz('indexed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_memory_items_tier', sql`${table.tier} IN (${valueList(MEMORY_TIERS)})`),
    check(
      'ck_memory_items_source_type',
      sql`${table.sourceType} IN (${valueList(MEMORY_SOURCE_TYPES)})`,
    ),

    /**
     * Tier and scope agree. Without this a `project`-tier row with a null `project_id` is
     * storable, and it would be invisible to every project-scoped query and visible to none —
     * a memory that exists and can never be retrieved, which is worse than one that was never
     * written because nothing reports it missing.
     */
    check(
      'ck_memory_items_tier_scope',
      sql`CASE ${table.tier}
            WHEN 'session' THEN ${table.sessionId} IS NOT NULL AND ${table.agentId} IS NULL
            WHEN 'project' THEN ${table.projectId} IS NOT NULL AND ${table.sessionId} IS NULL AND ${table.agentId} IS NULL
            WHEN 'agent'   THEN ${table.agentId} IS NOT NULL AND ${table.sessionId} IS NULL
            WHEN 'global'  THEN ${table.projectId} IS NULL AND ${table.sessionId} IS NULL AND ${table.agentId} IS NULL
            ELSE false
          END`,
    ),

    /** Exactly one identity: a row source has an id, a file source has a ref, never both. */
    check(
      'ck_memory_items_source_identity',
      sql`(${table.sourceId} IS NOT NULL) <> (${table.sourceRef} IS NOT NULL)`,
    ),
    check(
      'ck_memory_items_source_ref_length',
      sql`${table.sourceRef} IS NULL OR length(${table.sourceRef}) BETWEEN 1 AND ${sql.raw(String(MAX_SOURCE_REF_LENGTH))}`,
    ),

    check('ck_memory_items_chunk_ordinal', sql`${table.chunkOrdinal} >= 0`),

    /** The text or a pointer to it — never neither, or the hit cannot be shown to anyone. */
    check(
      'ck_memory_items_content_presence',
      sql`${table.content} IS NOT NULL OR ${table.sourceRef} IS NOT NULL`,
    ),
    check('ck_memory_items_content_hash', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),

    check(
      'ck_memory_items_embedding_model',
      sql`length(${table.embeddingModel}) BETWEEN 1 AND ${sql.raw(String(MAX_MODEL_NAME_LENGTH))}`,
    ),
    check(
      'ck_memory_items_embedding_dimension',
      sql`${table.embeddingDimension} BETWEEN 1 AND ${sql.raw(String(MAX_EMBEDDING_DIMENSION))}`,
    ),

    /**
     * One row per (chunk of a source) per model. Two partial indexes rather than one over a
     * coalesced expression, because `source_id` and `source_ref` are different types and a
     * functional index over both would be unusable by the planner for either.
     *
     * `embedding_model` is part of the key on purpose: a re-index under a new model writes
     * *parallel* rows rather than colliding with the old ones, which is what lets the old
     * vectors keep answering queries until the new set is complete.
     */
    uniqueIndex('ux_memory_items_source_chunk')
      .on(table.sourceType, table.sourceId, table.chunkOrdinal, table.embeddingModel)
      .where(sql`${table.sourceId} IS NOT NULL`),
    uniqueIndex('ux_memory_items_source_ref_chunk')
      .on(table.sourceType, table.sourceRef, table.chunkOrdinal, table.embeddingModel)
      .where(sql`${table.sourceRef} IS NOT NULL`),

    /** The point id is the search result's only handle on this row; it must resolve uniquely. */
    uniqueIndex('ux_memory_items_qdrant_point').on(table.qdrantPointId),

    index('ix_memory_items_tier_project').on(table.tier, table.projectId),
    index('ix_memory_items_session').on(table.sessionId),
    index('ix_memory_items_agent').on(table.agentId),
    /** The re-index work list: "every row not produced by the model settings now name". */
    index('ix_memory_items_model').on(table.embeddingModel, table.embeddingDimension),
    /** Reconciliation: rows whose vector never landed (`indexed_at IS NULL`) sort first. */
    index('ix_memory_items_indexed_at').on(table.indexedAt),
  ],
);
