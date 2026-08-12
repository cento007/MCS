/**
 * Git integration: `commits`, `pull_requests` (TDS 03 §3.7–§3.8).
 */

import { sql } from 'drizzle-orm';
import { bigint, check, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, timestamptz, tsvector, updatedAt, valueList } from './columns.js';
import { repositories } from './projects.js';
import { sessions } from './sessions.js';

/**
 * GitHub truth (arbitration A3 / finding B4). The PRD §4.3 lifecycle words
 * (Created/Opened/Reviewed/Merged/Rejected) are event names, not stored states: a reviewed
 * PR is still `open` on GitHub, and "rejected" is `closed` without `merged_at`.
 */
const PULL_REQUEST_STATES = ['open', 'merged', 'closed', 'draft'] as const;

/** One entry of `commits.files` (TDS 03 §3.7) — read whole, never queried per-element in Phase 1–2. */
export interface CommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/**
 * Git commit tracking (PRD §4.3). `session_id` links commits produced during a Session.
 *
 * The unique index on `(repository_id, sha)` doubles as the FK index for `repository_id`
 * and is the upsert conflict target for the polling job.
 */
export const commits = pgTable(
  'commits',
  {
    id: primaryKeyId(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').references(() => sessions.id, { onDelete: 'set null' }),
    sha: text('sha').notNull(),
    authorName: text('author_name').notNull(),
    authorEmail: text('author_email'),
    message: text('message').notNull(),
    branch: text('branch'),
    files: jsonb('files').$type<CommitFile[]>().notNull().default([]),
    committedAt: timestamptz('committed_at').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Stored generated column (TDS 03 §4.6): message at weight A, identifiers at weight D. */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('pg_catalog.english', coalesce(message, '')), 'A') || setweight(to_tsvector('pg_catalog.simple', coalesce(author_name, '') || ' ' || coalesce(branch, '')), 'D')`,
    ),
  },
  (table) => [
    check(
      'ck_commits_sha',
      sql`${table.sha} ~ '^[0-9a-f]{40}$' OR ${table.sha} ~ '^[0-9a-f]{64}$'`,
    ),
    check('ck_commits_files_array', sql`jsonb_typeof(${table.files}) = 'array'`),
    uniqueIndex('ux_commits_repository_sha').on(table.repositoryId, table.sha),
    index('ix_commits_repository_committed_at').on(
      table.repositoryId,
      sql`${table.committedAt} DESC`,
    ),
    index('ix_commits_session_id').on(table.sessionId),
    index('ix_commits_search_tsv').using('gin', table.searchTsv),
  ],
);

export const pullRequests = pgTable(
  'pull_requests',
  {
    id: primaryKeyId(),
    repositoryId: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    /** GitHub PR number. */
    number: bigint('number', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    description: text('description'),
    state: text('state').notNull(),
    author: text('author'),
    headBranch: text('head_branch'),
    baseBranch: text('base_branch'),
    url: text('url'),
    openedAt: timestamptz('opened_at'),
    /** First review submitted — the PRD "Reviewed" lifecycle fact, not a state. */
    reviewedAt: timestamptz('reviewed_at'),
    mergedAt: timestamptz('merged_at'),
    /** Set for merged and unmerged closes alike. */
    closedAt: timestamptz('closed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Stored generated column (TDS 03 §4.6). */
    searchTsv: tsvector('search_tsv').generatedAlwaysAs(
      sql`setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') || setweight(to_tsvector('pg_catalog.english', coalesce(description, '')), 'B')`,
    ),
  },
  (table) => [
    check('ck_pull_requests_number', sql`${table.number} > 0`),
    check('ck_pull_requests_state', sql`${table.state} IN (${valueList(PULL_REQUEST_STATES)})`),
    uniqueIndex('ux_pull_requests_repository_number').on(table.repositoryId, table.number),
    index('ix_pull_requests_repository_state').on(table.repositoryId, table.state),
    index('ix_pull_requests_search_tsv').using('gin', table.searchTsv),
  ],
);
