CREATE TABLE "audit_log_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"request_id" uuid,
	"ip_address" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_audit_log_entries_actor_type" CHECK ("audit_log_entries"."actor_type" IN ('user', 'agent', 'system'))
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"scopes" text[] DEFAULT '{"full"}' NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_api_tokens_name_length" CHECK (length("api_tokens"."name") BETWEEN 1 AND 100),
	CONSTRAINT "ck_api_tokens_scopes" CHECK (array_length("api_tokens"."scopes", 1) >= 1 AND "api_tokens"."scopes" <@ ARRAY['full', 'ingest']::text[] AND array_position("api_tokens"."scopes", NULL::text) IS NULL)
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	"ip_address" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_users_username_length" CHECK (length("users"."username") BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repository_id" uuid NOT NULL,
	"session_id" uuid,
	"sha" text NOT NULL,
	"author_name" text NOT NULL,
	"author_email" text,
	"message" text NOT NULL,
	"branch" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('pg_catalog.english', coalesce(message, '')), 'A') || setweight(to_tsvector('pg_catalog.simple', coalesce(author_name, '') || ' ' || coalesce(branch, '')), 'D')) STORED,
	CONSTRAINT "ck_commits_sha" CHECK ("commits"."sha" ~ '^[0-9a-f]{40}$' OR "commits"."sha" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ck_commits_files_array" CHECK (jsonb_typeof("commits"."files") = 'array')
);
--> statement-breakpoint
CREATE TABLE "pull_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repository_id" uuid NOT NULL,
	"number" bigint NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"state" text NOT NULL,
	"author" text,
	"head_branch" text,
	"base_branch" text,
	"url" text,
	"opened_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"merged_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') || setweight(to_tsvector('pg_catalog.english', coalesce(description, '')), 'B')) STORED,
	CONSTRAINT "ck_pull_requests_number" CHECK ("pull_requests"."number" > 0),
	CONSTRAINT "ck_pull_requests_state" CHECK ("pull_requests"."state" IN ('open', 'merged', 'closed', 'draft'))
);
--> statement-breakpoint
CREATE TABLE "adrs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"adr_number" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"context" text DEFAULT '' NOT NULL,
	"decision" text DEFAULT '' NOT NULL,
	"alternatives" text DEFAULT '' NOT NULL,
	"consequences" text DEFAULT '' NOT NULL,
	"superseded_by_adr_id" uuid,
	"source_session_id" uuid,
	"obsidian_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') || setweight(to_tsvector('pg_catalog.english', coalesce(decision, '')), 'B') || setweight(to_tsvector('pg_catalog.english', coalesce(context, '') || ' ' || coalesce(alternatives, '') || ' ' || coalesce(consequences, '')), 'C')) STORED,
	CONSTRAINT "ck_adrs_adr_number" CHECK ("adrs"."adr_number" > 0),
	CONSTRAINT "ck_adrs_title_length" CHECK (length("adrs"."title") BETWEEN 1 AND 300),
	CONSTRAINT "ck_adrs_status" CHECK ("adrs"."status" IN ('proposed', 'accepted', 'rejected', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"payload" jsonb,
	"correlation_id" uuid,
	"read_at" timestamp with time zone,
	"telegram_status" text DEFAULT 'skipped' NOT NULL,
	"telegram_sent_at" timestamp with time zone,
	"telegram_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_notifications_type" CHECK ("notifications"."type" IN ('session_completed', 'session_failed', 'sync_failed', 'repository_problem', 'daily_report', 'cost_budget_alert')),
	CONSTRAINT "ck_notifications_severity" CHECK ("notifications"."severity" IN ('info', 'warning', 'error')),
	CONSTRAINT "ck_notifications_telegram_status" CHECK ("notifications"."telegram_status" IN ('skipped', 'pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "service_heartbeats" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service" text NOT NULL,
	"hostname" text NOT NULL,
	"pid" integer NOT NULL,
	"version" text,
	"stats" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_service_heartbeats_service" CHECK ("service_heartbeats"."service" IN ('telegram_worker', 'sync_worker')),
	CONSTRAINT "ck_service_heartbeats_pid" CHECK ("service_heartbeats"."pid" > 0),
	CONSTRAINT "ck_service_heartbeats_stats_object" CHECK (jsonb_typeof("service_heartbeats"."stats") = 'object')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"workflow_mode" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_projects_name_length" CHECK (length("projects"."name") BETWEEN 1 AND 200),
	CONSTRAINT "ck_projects_status" CHECK ("projects"."status" IN ('active', 'archived')),
	CONSTRAINT "ck_projects_workflow_mode" CHECK ("projects"."workflow_mode" IN ('manual', 'assisted'))
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid,
	"name" text NOT NULL,
	"local_path" text NOT NULL,
	"remote_url" text,
	"remote_name" text DEFAULT 'origin' NOT NULL,
	"visibility" text DEFAULT 'unknown' NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"last_polled_sha" text,
	"last_synced_at" timestamp with time zone,
	"sync_status" text DEFAULT 'never' NOT NULL,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_repositories_name_length" CHECK (length("repositories"."name") BETWEEN 1 AND 200),
	CONSTRAINT "ck_repositories_visibility" CHECK ("repositories"."visibility" IN ('public', 'private', 'unknown')),
	CONSTRAINT "ck_repositories_sync_status" CHECK ("repositories"."sync_status" IN ('ok', 'failed', 'never'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_workspaces_name_length" CHECK (length("workspaces"."name") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"ordinal" bigint NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_blocks" jsonb,
	"model" text,
	"tool_name" text,
	"tool_use_id" text,
	"tool_payload" jsonb,
	"tool_file_path" text,
	"runtime_message_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (CASE WHEN role IN ('user', 'assistant') THEN setweight(to_tsvector('pg_catalog.english', left(coalesce(content, ''), 100000)), 'B') ELSE NULL END) STORED,
	CONSTRAINT "ck_messages_ordinal" CHECK ("messages"."ordinal" >= 0),
	CONSTRAINT "ck_messages_role" CHECK ("messages"."role" IN ('user', 'assistant', 'system', 'tool')),
	CONSTRAINT "ck_messages_status" CHECK ("messages"."status" IN ('complete', 'pending', 'interrupted')),
	CONSTRAINT "ck_messages_content_blocks_array" CHECK (jsonb_typeof("messages"."content_blocks") = 'array')
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"from_state" text,
	"to_state" text,
	"trigger" text NOT NULL,
	"payload" jsonb,
	"correlation_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_session_events_from_state" CHECK ("session_events"."from_state" IN ('created', 'running', 'paused', 'completed', 'failed', 'archived')),
	CONSTRAINT "ck_session_events_to_state" CHECK ("session_events"."to_state" IN ('created', 'running', 'paused', 'completed', 'failed', 'archived')),
	CONSTRAINT "ck_session_events_trigger" CHECK ("session_events"."trigger" IN ('user', 'system'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid,
	"user_id" uuid NOT NULL,
	"resumed_from_session_id" uuid,
	"lineage_kind" text,
	"session_type" text NOT NULL,
	"state" text DEFAULT 'created' NOT NULL,
	"runtime" text DEFAULT 'claude_code' NOT NULL,
	"runtime_session_id" text,
	"runtime_version" text,
	"model" text,
	"machine" text,
	"environment" text,
	"branch" text,
	"working_dir" text,
	"transcript_path" text,
	"title" text,
	"notes" text,
	"failure_reason" text,
	"total_cost_usd" numeric(12, 6),
	"usage" jsonb,
	"num_turns" integer,
	"duration_ms" bigint,
	"duration_api_ms" bigint,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('pg_catalog.english', coalesce(title, '')), 'A') || setweight(to_tsvector('pg_catalog.english', coalesce(notes, '')), 'B')) STORED,
	CONSTRAINT "ck_sessions_lineage_kind" CHECK ("sessions"."lineage_kind" IN ('resumed', 'cloned')),
	CONSTRAINT "ck_sessions_session_type" CHECK ("sessions"."session_type" IN ('managed', 'observed')),
	CONSTRAINT "ck_sessions_state" CHECK ("sessions"."state" IN ('created', 'running', 'paused', 'completed', 'failed', 'archived')),
	CONSTRAINT "ck_sessions_runtime" CHECK ("sessions"."runtime" IN ('claude_code', 'ollama')),
	CONSTRAINT "ck_sessions_total_cost_usd" CHECK ("sessions"."total_cost_usd" >= 0),
	CONSTRAINT "ck_sessions_usage_object" CHECK (jsonb_typeof("sessions"."usage") = 'object'),
	CONSTRAINT "ck_sessions_num_turns" CHECK ("sessions"."num_turns" >= 0),
	CONSTRAINT "ck_sessions_duration_ms" CHECK ("sessions"."duration_ms" >= 0),
	CONSTRAINT "ck_sessions_duration_api_ms" CHECK ("sessions"."duration_api_ms" >= 0),
	CONSTRAINT "ck_sessions_lineage" CHECK (("sessions"."resumed_from_session_id" IS NULL) = ("sessions"."lineage_kind" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "transcript_tail_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"transcript_path" text NOT NULL,
	"byte_offset" bigint DEFAULT 0 NOT NULL,
	"line_no" bigint DEFAULT 0 NOT NULL,
	"drift_count" integer DEFAULT 0 NOT NULL,
	"degraded" boolean DEFAULT false NOT NULL,
	"last_read_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_transcript_tail_states_byte_offset" CHECK ("transcript_tail_states"."byte_offset" >= 0),
	CONSTRAINT "ck_transcript_tail_states_line_no" CHECK ("transcript_tail_states"."line_no" >= 0),
	CONSTRAINT "ck_transcript_tail_states_drift_count" CHECK ("transcript_tail_states"."drift_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "secret_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"nonce" "bytea" NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_secret_items_category" CHECK ("secret_items"."category" IN ('general', 'integrations', 'notifications', 'memory', 'agents', 'security')),
	CONSTRAINT "ck_secret_items_key_length" CHECK (length("secret_items"."key") BETWEEN 1 AND 128),
	CONSTRAINT "ck_secret_items_ciphertext" CHECK (octet_length("secret_items"."ciphertext") > 16),
	CONSTRAINT "ck_secret_items_nonce" CHECK (octet_length("secret_items"."nonce") = 12),
	CONSTRAINT "ck_secret_items_key_version" CHECK ("secret_items"."key_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"value_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_settings_category" CHECK ("settings"."category" IN ('general', 'integrations', 'notifications', 'memory', 'agents', 'security')),
	CONSTRAINT "ck_settings_key_length" CHECK (length("settings"."key") BETWEEN 1 AND 128),
	CONSTRAINT "ck_settings_value_type" CHECK ("settings"."value_type" IN ('string', 'number', 'boolean', 'object', 'array')),
	CONSTRAINT "ck_settings_value_matches_type" CHECK (("settings"."value_type" = 'string'  AND jsonb_typeof("settings"."value") = 'string')  OR
    ("settings"."value_type" = 'number'  AND jsonb_typeof("settings"."value") = 'number')  OR
    ("settings"."value_type" = 'boolean' AND jsonb_typeof("settings"."value") = 'boolean') OR
    ("settings"."value_type" = 'object'  AND jsonb_typeof("settings"."value") = 'object')  OR
    ("settings"."value_type" = 'array'   AND jsonb_typeof("settings"."value") = 'array'))
);
--> statement-breakpoint
CREATE TABLE "agent_teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tier" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_memory_items_tier" CHECK ("memory_items"."tier" IN ('session', 'project', 'agent', 'global'))
);
--> statement-breakpoint
CREATE TABLE "obsidian_sync_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"vault_path" text NOT NULL,
	"entity_type" text,
	"entity_id" uuid,
	"mc_hash" text,
	"vault_hash" text,
	"vault_mtime" timestamp with time zone,
	"status" text DEFAULT 'pending_pull' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_obsidian_sync_states_entity_type" CHECK ("obsidian_sync_states"."entity_type" IN ('project', 'session', 'adr', 'agent', 'feature', 'daily')),
	CONSTRAINT "ck_obsidian_sync_states_status" CHECK ("obsidian_sync_states"."status" IN ('in_sync', 'pending_push', 'pending_pull', 'conflict', 'error'))
);
--> statement-breakpoint
CREATE TABLE "sync_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text DEFAULT 'obsidian' NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"trigger" text NOT NULL,
	"stats" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_sync_runs_kind" CHECK ("sync_runs"."kind" IN ('obsidian')),
	CONSTRAINT "ck_sync_runs_state" CHECK ("sync_runs"."state" IN ('queued', 'running', 'completed', 'failed')),
	CONSTRAINT "ck_sync_runs_trigger" CHECK ("sync_runs"."trigger" IN ('user', 'schedule')),
	CONSTRAINT "ck_sync_runs_stats_object" CHECK (jsonb_typeof("sync_runs"."stats") = 'object')
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pull_requests" ADD CONSTRAINT "pull_requests_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adrs" ADD CONSTRAINT "adrs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adrs" ADD CONSTRAINT "adrs_superseded_by_adr_id_adrs_id_fk" FOREIGN KEY ("superseded_by_adr_id") REFERENCES "public"."adrs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adrs" ADD CONSTRAINT "adrs_source_session_id_sessions_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_events" ADD CONSTRAINT "session_events_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_resumed_from_session_id_sessions_id_fk" FOREIGN KEY ("resumed_from_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_tail_states" ADD CONSTRAINT "transcript_tail_states_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_audit_entity" ON "audit_log_entries" USING btree ("entity_type","entity_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "ix_audit_actor" ON "audit_log_entries" USING btree ("actor_type","actor_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "ix_audit_created_at_brin" ON "audit_log_entries" USING brin ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_api_tokens_token_hash" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_api_tokens_user_id" ON "api_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_auth_sessions_token_hash" ON "auth_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "ix_auth_sessions_user_id" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_auth_sessions_expires_at" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_users_username_lower" ON "users" USING btree (lower("username"));--> statement-breakpoint
CREATE UNIQUE INDEX "ux_commits_repository_sha" ON "commits" USING btree ("repository_id","sha");--> statement-breakpoint
CREATE INDEX "ix_commits_repository_committed_at" ON "commits" USING btree ("repository_id","committed_at" DESC);--> statement-breakpoint
CREATE INDEX "ix_commits_session_id" ON "commits" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_commits_search_tsv" ON "commits" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_pull_requests_repository_number" ON "pull_requests" USING btree ("repository_id","number");--> statement-breakpoint
CREATE INDEX "ix_pull_requests_repository_state" ON "pull_requests" USING btree ("repository_id","state");--> statement-breakpoint
CREATE INDEX "ix_pull_requests_search_tsv" ON "pull_requests" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_adrs_project_number" ON "adrs" USING btree ("project_id","adr_number");--> statement-breakpoint
CREATE INDEX "ix_adrs_project_status" ON "adrs" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "ix_adrs_superseded_by" ON "adrs" USING btree ("superseded_by_adr_id");--> statement-breakpoint
CREATE INDEX "ix_adrs_source_session" ON "adrs" USING btree ("source_session_id");--> statement-breakpoint
CREATE INDEX "ix_adrs_search_tsv" ON "adrs" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "ix_notifications_unread" ON "notifications" USING btree ("user_id","created_at" DESC) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_notifications_user_created" ON "notifications" USING btree ("user_id","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_service_heartbeats_service" ON "service_heartbeats" USING btree ("service");--> statement-breakpoint
CREATE INDEX "ix_projects_workspace_id" ON "projects" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_projects_workspace_name" ON "projects" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "ix_repositories_project_id" ON "repositories" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_repositories_local_path" ON "repositories" USING btree ("local_path");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_messages_session_ordinal" ON "messages" USING btree ("session_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_messages_session_runtime_id" ON "messages" USING btree ("session_id","runtime_message_id") WHERE "messages"."runtime_message_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_messages_session_tool_file" ON "messages" USING btree ("session_id","tool_file_path") WHERE "messages"."tool_file_path" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_messages_search_tsv" ON "messages" USING gin ("search_tsv") WHERE "messages"."search_tsv" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_session_events_session_occurred" ON "session_events" USING btree ("session_id","occurred_at");--> statement-breakpoint
CREATE INDEX "ix_sessions_project_state_created_at" ON "sessions" USING btree ("project_id","state","created_at" DESC);--> statement-breakpoint
CREATE INDEX "ix_sessions_user_id" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_repository_id" ON "sessions" USING btree ("repository_id") WHERE "sessions"."repository_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_sessions_resumed_from" ON "sessions" USING btree ("resumed_from_session_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_active" ON "sessions" USING btree ("created_at" DESC) WHERE "sessions"."state" IN ('created', 'running', 'paused');--> statement-breakpoint
CREATE UNIQUE INDEX "ux_sessions_runtime_session_id" ON "sessions" USING btree ("runtime","runtime_session_id") WHERE "sessions"."runtime_session_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ix_sessions_search_tsv" ON "sessions" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_transcript_tail_session" ON "transcript_tail_states" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_secret_items_category_key" ON "secret_items" USING btree ("category","key");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_settings_category_key" ON "settings" USING btree ("category","key");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_obsidian_sync_vault_path" ON "obsidian_sync_states" USING btree ("vault_path");--> statement-breakpoint
CREATE INDEX "ix_obsidian_sync_entity" ON "obsidian_sync_states" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "ix_obsidian_sync_status" ON "obsidian_sync_states" USING btree ("status") WHERE "obsidian_sync_states"."status" IN ('pending_push', 'pending_pull', 'conflict', 'error');--> statement-breakpoint
CREATE INDEX "ix_sync_runs_kind_created_at" ON "sync_runs" USING btree ("kind","created_at" DESC);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_sync_runs_active" ON "sync_runs" USING btree ("kind") WHERE "sync_runs"."state" IN ('queued', 'running');