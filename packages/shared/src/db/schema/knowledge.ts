/**
 * Knowledge layer: `adrs` (TDS 03 §4.1, Phase 2).
 *
 * Template sections per PRD §7.3 are dedicated text columns — they are always all rendered,
 * so there is no reason for JSONB. `adr_number` is per-project and user-visible ("ADR-0007"),
 * assigned by the app as `max + 1` within the insert transaction.
 */

import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ADR_STATUSES as ADR_STATUS_VOCABULARY, type AdrStatus } from '../../entities/adr.js';
import { createdAt, primaryKeyId, tsvector, updatedAt, valueList } from './columns.js';
import { projects } from './projects.js';
import { sessions } from './sessions.js';

/**
 * Anchored to the shared vocabulary rather than re-typed, exactly as `sessions.state` is: the
 * CHECK and the values the API validates against cannot drift apart (F9.5).
 */
const ADR_STATUSES = ADR_STATUS_VOCABULARY satisfies readonly AdrStatus[];

export const adrs = pgTable(
  'adrs',
  {
    id: primaryKeyId(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'restrict' }),
    adrNumber: integer('adr_number').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull().default('proposed'),
    context: text('context').notNull().default(''),
    decision: text('decision').notNull().default(''),
    alternatives: text('alternatives').notNull().default(''),
    consequences: text('consequences').notNull().default(''),
    supersededByAdrId: uuid('superseded_by_adr_id').references((): AnyPgColumn => adrs.id, {
      onDelete: 'set null',
    }),
    /** ADR generated from a Session. */
    sourceSessionId: uuid('source_session_id').references(() => sessions.id, {
      onDelete: 'set null',
    }),
    /** Vault-relative path, denormalized for display; the ledger lives in `obsidian_sync_states`. */
    obsidianPath: text('obsidian_path'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Stored generated column (TDS 03 §4.6): title A, decision B, remaining sections C. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') || setweight(to_tsvector('pg_catalog.english', coalesce(decision, '')), 'B') || setweight(to_tsvector('pg_catalog.english', coalesce(context, '') || ' ' || coalesce(alternatives, '') || ' ' || coalesce(consequences, '')), 'C')`,
    ),
  },
  (table) => [
    check('ck_adrs_adr_number', sql`${table.adrNumber} > 0`),
    check('ck_adrs_title_length', sql`length(${table.title}) BETWEEN 1 AND 300`),
    check('ck_adrs_status', sql`${table.status} IN (${valueList(ADR_STATUSES)})`),
    uniqueIndex('ux_adrs_project_number').on(table.projectId, table.adrNumber),
    index('ix_adrs_project_status').on(table.projectId, table.status),
    index('ix_adrs_superseded_by').on(table.supersededByAdrId),
    index('ix_adrs_source_session').on(table.sourceSessionId),
    index('ix_adrs_search_tsv').using('gin', table.searchTsv),
  ],
);
