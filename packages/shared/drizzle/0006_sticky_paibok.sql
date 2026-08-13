ALTER TABLE "sessions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "scope" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime" text DEFAULT 'claude_code' NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "permissions" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "instructions" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ix_sessions_agent_id" ON "sessions" USING btree ("agent_id") WHERE "sessions"."agent_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agents_global_name" ON "agents" USING btree ("name") WHERE "agents"."scope" = 'global' AND "agents"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agents_project_name" ON "agents" USING btree ("project_id","name") WHERE "agents"."scope" = 'project' AND "agents"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agents_session_name" ON "agents" USING btree ("session_id","name") WHERE "agents"."scope" = 'session' AND "agents"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "ix_agents_scope_project" ON "agents" USING btree ("scope","project_id");--> statement-breakpoint
CREATE INDEX "ix_agents_session" ON "agents" USING btree ("session_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_scope" CHECK ("agents"."scope" IN ('global', 'project', 'session'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_runtime" CHECK ("agents"."runtime" IN ('claude_code'));--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_scope_target" CHECK (CASE "agents"."scope"
            WHEN 'global'  THEN "agents"."project_id" IS NULL AND "agents"."session_id" IS NULL
            WHEN 'project' THEN "agents"."project_id" IS NOT NULL AND "agents"."session_id" IS NULL
            WHEN 'session' THEN "agents"."session_id" IS NOT NULL AND "agents"."project_id" IS NULL
            ELSE false
          END);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_name_length" CHECK (length("agents"."name") BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_description_length" CHECK ("agents"."description" IS NULL OR length("agents"."description") BETWEEN 1 AND 2000);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_instructions_length" CHECK ("agents"."instructions" IS NULL OR length("agents"."instructions") BETWEEN 1 AND 20000);--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_permissions_shape" CHECK (jsonb_typeof("agents"."permissions") = 'object'
          AND jsonb_typeof("agents"."permissions" -> 'repository') = 'object'
          AND jsonb_typeof("agents"."permissions" #> '{repository,read}') = 'boolean'
          AND jsonb_typeof("agents"."permissions" #> '{repository,write}') = 'boolean'
          AND jsonb_typeof("agents"."permissions" #> '{repository,shell}') = 'boolean');--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_permissions_shell_subsumes" CHECK (NOT ("agents"."permissions" #> '{repository,shell}' = 'true'::jsonb
               AND ("agents"."permissions" #> '{repository,read}' <> 'true'::jsonb
                    OR "agents"."permissions" #> '{repository,write}' <> 'true'::jsonb)));