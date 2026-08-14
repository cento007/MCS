-- PRD §5.6 agent workflows: the chain (`agent_workflows`, `agent_workflow_steps`) and its
-- execution (`agent_workflow_runs`, `agent_workflow_run_steps`).
--
-- **The statement order below is not drizzle-kit's, and the difference is load-bearing** — the
-- same correction 0008 had to make, for the same reason. The generator emits every FOREIGN KEY
-- before every CREATE INDEX, and PostgreSQL refuses that here: a composite FK requires a unique
-- index covering its target columns, so `agent_workflow_steps (workflow_id, workflow_scope) ->
-- agent_workflows (id, scope)` needs `ux_agent_workflows_id_scope` to exist first. The statements
-- are therefore grouped as
--   1. tables and columns, 2. the referenceable unique indexes, 3. the foreign keys,
--   4. the remaining indexes
-- with the SQL itself unchanged. The snapshot drizzle-kit diffs against is unaffected.
--
-- The agent-side composites (`agents (id, scope)` and `agents (id, project_id)`) already exist —
-- 0008 created them for `agent_team_members`, and this migration reuses them rather than adding a
-- second pair.
CREATE TABLE "agent_workflow_run_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"state" text DEFAULT 'running' NOT NULL,
	"handoff_state" text NOT NULL,
	"handoff_reason" text,
	"prompt" text NOT NULL,
	"prompt_sent_at" timestamp with time zone,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_workflow_run_steps_state" CHECK ("agent_workflow_run_steps"."state" IN ('running', 'completed', 'failed', 'stopped')),
	CONSTRAINT "ck_agent_workflow_run_steps_ordinal" CHECK ("agent_workflow_run_steps"."ordinal" BETWEEN 0 AND 9),
	CONSTRAINT "ck_agent_workflow_run_steps_attempt" CHECK ("agent_workflow_run_steps"."attempt" >= 0),
	CONSTRAINT "ck_agent_workflow_run_steps_handoff" CHECK (CASE "agent_workflow_run_steps"."handoff_state"
            WHEN 'none'     THEN "agent_workflow_run_steps"."handoff_reason" IS NULL
            WHEN 'full'     THEN "agent_workflow_run_steps"."handoff_reason" IS NULL
            WHEN 'degraded' THEN "agent_workflow_run_steps"."handoff_reason" IS NOT NULL
            ELSE false
          END),
	CONSTRAINT "ck_agent_workflow_run_steps_prompt_bytes" CHECK (octet_length("agent_workflow_run_steps"."prompt") BETWEEN 1 AND 262144),
	CONSTRAINT "ck_agent_workflow_run_steps_handoff_state_value" CHECK ("agent_workflow_run_steps"."handoff_state" IN ('none', 'full', 'degraded'))
);--> statement-breakpoint
CREATE TABLE "agent_workflow_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_id" uuid,
	"user_id" uuid NOT NULL,
	"task" text NOT NULL,
	"working_dir" text NOT NULL,
	"branch" text,
	"model" text,
	"state" text DEFAULT 'running' NOT NULL,
	"step_count" integer NOT NULL,
	"max_sessions" integer NOT NULL,
	"sessions_launched" integer DEFAULT 0 NOT NULL,
	"halt_reason" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_workflow_runs_state" CHECK ("agent_workflow_runs"."state" IN ('running', 'completed', 'halted', 'stopped')),
	CONSTRAINT "ck_agent_workflow_runs_task_length" CHECK (length("agent_workflow_runs"."task") BETWEEN 1 AND 20000),
	CONSTRAINT "ck_agent_workflow_runs_step_count" CHECK ("agent_workflow_runs"."step_count" BETWEEN 1 AND 10),
	CONSTRAINT "ck_agent_workflow_runs_max_sessions" CHECK ("agent_workflow_runs"."max_sessions" BETWEEN 1 AND 20),
	CONSTRAINT "ck_agent_workflow_runs_sessions_launched" CHECK ("agent_workflow_runs"."sessions_launched" >= 0 AND "agent_workflow_runs"."sessions_launched" <= "agent_workflow_runs"."max_sessions"),
	CONSTRAINT "ck_agent_workflow_runs_state_fields" CHECK (CASE "agent_workflow_runs"."state"
            WHEN 'running'   THEN "agent_workflow_runs"."halt_reason" IS NULL     AND "agent_workflow_runs"."completed_at" IS NULL
            WHEN 'halted'    THEN "agent_workflow_runs"."halt_reason" IS NOT NULL AND "agent_workflow_runs"."completed_at" IS NULL
            WHEN 'completed' THEN "agent_workflow_runs"."halt_reason" IS NULL     AND "agent_workflow_runs"."completed_at" IS NOT NULL
            WHEN 'stopped'   THEN "agent_workflow_runs"."completed_at" IS NOT NULL
            ELSE false
          END)
);--> statement-breakpoint
CREATE TABLE "agent_workflow_steps" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workflow_id" uuid NOT NULL,
	"workflow_scope" text NOT NULL,
	"workflow_project_id" uuid,
	"ordinal" integer NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_scope" text NOT NULL,
	"agent_project_id" uuid,
	"instructions" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_workflow_steps_agent_scope_value" CHECK ("agent_workflow_steps"."agent_scope" IN ('global', 'project', 'session')),
	CONSTRAINT "ck_agent_workflow_steps_workflow_scope" CHECK (CASE "agent_workflow_steps"."workflow_scope"
            WHEN 'global'  THEN "agent_workflow_steps"."workflow_project_id" IS NULL
            WHEN 'project' THEN "agent_workflow_steps"."workflow_project_id" IS NOT NULL
            ELSE false
          END),
	CONSTRAINT "ck_agent_workflow_steps_agent_scope" CHECK (CASE "agent_workflow_steps"."agent_scope"
            WHEN 'global'  THEN "agent_workflow_steps"."agent_project_id" IS NULL
            WHEN 'project' THEN coalesce("agent_workflow_steps"."agent_project_id" = "agent_workflow_steps"."workflow_project_id", false)
            ELSE false
          END),
	CONSTRAINT "ck_agent_workflow_steps_ordinal" CHECK ("agent_workflow_steps"."ordinal" BETWEEN 0 AND 9),
	CONSTRAINT "ck_agent_workflow_steps_instructions_length" CHECK ("agent_workflow_steps"."instructions" IS NULL OR length("agent_workflow_steps"."instructions") BETWEEN 1 AND 4000)
);--> statement-breakpoint
CREATE TABLE "agent_workflows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" text NOT NULL,
	"project_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_workflows_scope" CHECK ("agent_workflows"."scope" IN ('global', 'project')),
	CONSTRAINT "ck_agent_workflows_scope_target" CHECK (CASE "agent_workflows"."scope"
            WHEN 'global'  THEN "agent_workflows"."project_id" IS NULL
            WHEN 'project' THEN "agent_workflows"."project_id" IS NOT NULL
            ELSE false
          END),
	CONSTRAINT "ck_agent_workflows_name_length" CHECK (length("agent_workflows"."name") BETWEEN 1 AND 100),
	CONSTRAINT "ck_agent_workflows_description_length" CHECK ("agent_workflows"."description" IS NULL OR length("agent_workflows"."description") BETWEEN 1 AND 2000)
);--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflows_id_scope" ON "agent_workflows" USING btree ("id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflows_id_project" ON "agent_workflows" USING btree ("id","project_id");--> statement-breakpoint
ALTER TABLE "agent_workflow_run_steps" ADD CONSTRAINT "agent_workflow_run_steps_run_id_agent_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_run_steps" ADD CONSTRAINT "agent_workflow_run_steps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_run_steps" ADD CONSTRAINT "agent_workflow_run_steps_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_runs" ADD CONSTRAINT "agent_workflow_runs_workflow_id_agent_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."agent_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_runs" ADD CONSTRAINT "agent_workflow_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_runs" ADD CONSTRAINT "agent_workflow_runs_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_runs" ADD CONSTRAINT "agent_workflow_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_steps" ADD CONSTRAINT "agent_workflow_steps_workflow_scope_fk" FOREIGN KEY ("workflow_id","workflow_scope") REFERENCES "public"."agent_workflows"("id","scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_steps" ADD CONSTRAINT "agent_workflow_steps_workflow_project_fk" FOREIGN KEY ("workflow_id","workflow_project_id") REFERENCES "public"."agent_workflows"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_steps" ADD CONSTRAINT "agent_workflow_steps_agent_scope_fk" FOREIGN KEY ("agent_id","agent_scope") REFERENCES "public"."agents"("id","scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflow_steps" ADD CONSTRAINT "agent_workflow_steps_agent_project_fk" FOREIGN KEY ("agent_id","agent_project_id") REFERENCES "public"."agents"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workflows" ADD CONSTRAINT "agent_workflows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflow_run_steps_attempt" ON "agent_workflow_run_steps" USING btree ("run_id","ordinal","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflow_run_steps_session" ON "agent_workflow_run_steps" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_agent_workflow_run_steps_run" ON "agent_workflow_run_steps" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflow_runs_active" ON "agent_workflow_runs" USING btree ("project_id") WHERE "agent_workflow_runs"."state" = 'running';--> statement-breakpoint
CREATE INDEX "ix_agent_workflow_runs_workflow" ON "agent_workflow_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "ix_agent_workflow_runs_project_started" ON "agent_workflow_runs" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflow_steps_ordinal" ON "agent_workflow_steps" USING btree ("workflow_id","ordinal");--> statement-breakpoint
CREATE INDEX "ix_agent_workflow_steps_agent" ON "agent_workflow_steps" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflows_global_name" ON "agent_workflows" USING btree ("name") WHERE "agent_workflows"."scope" = 'global' AND "agent_workflows"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_workflows_project_name" ON "agent_workflows" USING btree ("project_id","name") WHERE "agent_workflows"."scope" = 'project' AND "agent_workflows"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_agent_workflows_scope_project" ON "agent_workflows" USING btree ("scope","project_id");