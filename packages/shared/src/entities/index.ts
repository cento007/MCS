/**
 * F4.1 — canonical entity vocabulary.
 *
 * SCAFFOLD STATE: only the identifiers the Phase 1 foundation actually needs are declared
 * here (Session states/types, Message roles, the entity/table name registry). Full entity
 * DTO shapes are generated from / aligned with WS3's Drizzle schema
 * (`docs/tds/03-database-schema.md`) and WS2's API contract
 * (`docs/tds/04-api-contracts-and-events.md`); they land with those workstreams.
 *
 * Naming rules (F4.2): DB is snake_case + plural tables; API JSON is camelCase;
 * entity names are PascalCase in types and docs. IDs are UUIDv7 strings.
 */

export * from './adr.js';
export * from './agent.js';
export * from './agent-team.js';
export * from './agent-workflow.js';
export * from './memory.js';
export * from './notification.js';
export * from './service-health.js';
export * from './session-state.js';

/** Every F4.1 entity, mapped to its table name. Phase tells you when it becomes real. */
export const ENTITY_TABLES = Object.freeze({
  User: 'users',
  Workspace: 'workspaces',
  Project: 'projects',
  Repository: 'repositories',
  Commit: 'commits',
  PullRequest: 'pull_requests',
  Session: 'sessions',
  Message: 'messages',
  Adr: 'adrs',
  Notification: 'notifications',
  Setting: 'settings',
  SecretItem: 'secret_items',
  AuditLogEntry: 'audit_log_entries',
  Agent: 'agents',
  AgentTeam: 'agent_teams',
  AgentWorkflow: 'agent_workflows',
  AgentWorkflowRun: 'agent_workflow_runs',
  MemoryItem: 'memory_items',
} as const);

export type EntityName = keyof typeof ENTITY_TABLES;
export type TableName = (typeof ENTITY_TABLES)[EntityName];

/** UUIDv7 primary key (F4.2), stored as PostgreSQL `uuid`, safe to expose in URLs. */
export type EntityId = string;

/** ISO 8601 UTC with `Z` suffix — the only timestamp representation on the wire (F4.2). */
export type IsoTimestamp = string;
