/**
 * Project structure: `workspaces`, `projects`, `repositories` (TDS 03 §3.4–§3.6).
 */

import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { createdAt, primaryKeyId, timestamptz, updatedAt, valueList } from './columns.js';

const PROJECT_STATUSES = ['active', 'archived'] as const;

/**
 * Per-project override of the global Manual/Assisted setting; NULL = inherit
 * (`integrations.github.workflowMode`, WS2 §7.2). Three-valued by design — arbitration A10.
 */
const WORKFLOW_MODES = ['manual', 'assisted'] as const;

const REPOSITORY_VISIBILITIES = ['public', 'private', 'unknown'] as const;

/** WS2 §5.1 — outcome of the most recent sync attempt, not derivable from `last_synced_at`. */
const REPOSITORY_SYNC_STATUSES = ['ok', 'failed', 'never'] as const;

/** Single default workspace in V1 (F4.1); the row is seeded at first startup. */
export const workspaces = pgTable(
  'workspaces',
  {
    id: primaryKeyId(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [check('ck_workspaces_name_length', sql`length(${table.name}) BETWEEN 1 AND 200`)],
);

export const projects = pgTable(
  'projects',
  {
    id: primaryKeyId(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').notNull().default('active'),
    /** NULL = inherit the global setting (PRD §4.3, arbitration A10 / finding B11a). */
    workflowMode: text('workflow_mode'),
    archivedAt: timestamptz('archived_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_projects_name_length', sql`length(${table.name}) BETWEEN 1 AND 200`),
    check('ck_projects_status', sql`${table.status} IN (${valueList(PROJECT_STATUSES)})`),
    check(
      'ck_projects_workflow_mode',
      sql`${table.workflowMode} IN (${valueList(WORKFLOW_MODES)})`,
    ),
    index('ix_projects_workspace_id').on(table.workspaceId),
    uniqueIndex('ux_projects_workspace_name').on(table.workspaceId, sql`lower(${table.name})`),
  ],
);

/**
 * `project_id` is nullable: repository discovery (PRD §4.3) scans configured root paths and
 * may register a repo before the user assigns it to a Project.
 *
 * No index on `sync_status` — this table holds tens of rows in V1 and the Repositories view
 * reads all of them; filtering it is a sequential scan by design (TDS 03 §3.6).
 */
export const repositories = pgTable(
  'repositories',
  {
    id: primaryKeyId(),
    /** NULL = discovered, unassigned. */
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** Absolute native path (F8.1 path rules). */
    localPath: text('local_path').notNull(),
    /** NULL for local-only repos. */
    remoteUrl: text('remote_url'),
    remoteName: text('remote_name').notNull().default('origin'),
    visibility: text('visibility').notNull().default('unknown'),
    defaultBranch: text('default_branch').notNull().default('main'),
    /** Sync Worker poll cursor (default branch head). */
    lastPolledSha: text('last_polled_sha'),
    /** Last *successful* sync. */
    lastSyncedAt: timestamptz('last_synced_at'),
    /** Outcome of the last attempt (WS2 §5.1, finding B8). */
    syncStatus: text('sync_status').notNull().default('never'),
    /** Populated when `sync_status = 'failed'`. */
    lastSyncError: text('last_sync_error'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('ck_repositories_name_length', sql`length(${table.name}) BETWEEN 1 AND 200`),
    check(
      'ck_repositories_visibility',
      sql`${table.visibility} IN (${valueList(REPOSITORY_VISIBILITIES)})`,
    ),
    check(
      'ck_repositories_sync_status',
      sql`${table.syncStatus} IN (${valueList(REPOSITORY_SYNC_STATUSES)})`,
    ),
    index('ix_repositories_project_id').on(table.projectId),
    uniqueIndex('ux_repositories_local_path').on(table.localPath),
  ],
);
