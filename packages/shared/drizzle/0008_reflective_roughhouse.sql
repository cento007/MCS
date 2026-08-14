-- PRD §5.7 agent teams: `agent_teams` graduates out of the skeleton set, and its two join
-- tables are created.
--
-- **The statement order below is not drizzle-kit's, and the difference is load-bearing.**
-- The generator emitted every FOREIGN KEY before every CREATE INDEX, which PostgreSQL refuses
-- here: a composite FK requires a unique index covering its target columns, and
-- `agent_team_members (agent_id, agent_scope) -> agents (id, scope)` needs `ux_agents_id_scope`
-- to exist first. The statements are therefore grouped as
--   1. tables and columns, 2. the referenceable unique indexes, 3. the foreign keys,
--   4. the remaining indexes and CHECKs
-- with the SQL itself unchanged. The snapshot drizzle-kit diffs against is unaffected.
--
-- `agent_teams` has been an empty two-column skeleton since 0000, so `ADD COLUMN scope text
-- NOT NULL` has nothing to rewrite — the same situation, and the same statement, as 0006's
-- `agents`.
CREATE TABLE "agent_team_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"team_scope" text NOT NULL,
	"team_project_id" uuid,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_team_assignments_scope" CHECK (CASE "agent_team_assignments"."team_scope"
            WHEN 'global'  THEN "agent_team_assignments"."team_project_id" IS NULL
            WHEN 'project' THEN coalesce("agent_team_assignments"."team_project_id" = "agent_team_assignments"."project_id", false)
            ELSE false
          END)
);
--> statement-breakpoint
CREATE TABLE "agent_team_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"team_scope" text NOT NULL,
	"team_project_id" uuid,
	"agent_id" uuid NOT NULL,
	"agent_scope" text NOT NULL,
	"agent_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ck_agent_team_members_agent_scope_value" CHECK ("agent_team_members"."agent_scope" IN ('global', 'project', 'session')),
	CONSTRAINT "ck_agent_team_members_team_scope" CHECK (CASE "agent_team_members"."team_scope"
            WHEN 'global'  THEN "agent_team_members"."team_project_id" IS NULL
            WHEN 'project' THEN "agent_team_members"."team_project_id" IS NOT NULL
            ELSE false
          END),
	CONSTRAINT "ck_agent_team_members_agent_scope" CHECK (CASE "agent_team_members"."agent_scope"
            WHEN 'global'  THEN "agent_team_members"."agent_project_id" IS NULL
            WHEN 'project' THEN coalesce("agent_team_members"."agent_project_id" = "agent_team_members"."team_project_id", false)
            ELSE false
          END)
);
--> statement-breakpoint
ALTER TABLE "agent_teams" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD COLUMN "scope" text NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD COLUMN "project_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agents_id_scope" ON "agents" USING btree ("id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agents_id_project" ON "agents" USING btree ("id","project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_teams_id_scope" ON "agent_teams" USING btree ("id","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_teams_id_project" ON "agent_teams" USING btree ("id","project_id");--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_assignments" ADD CONSTRAINT "agent_team_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_assignments" ADD CONSTRAINT "agent_team_assignments_team_scope_fk" FOREIGN KEY ("team_id","team_scope") REFERENCES "public"."agent_teams"("id","scope") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_assignments" ADD CONSTRAINT "agent_team_assignments_team_project_fk" FOREIGN KEY ("team_id","team_project_id") REFERENCES "public"."agent_teams"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_team_scope_fk" FOREIGN KEY ("team_id","team_scope") REFERENCES "public"."agent_teams"("id","scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_team_project_fk" FOREIGN KEY ("team_id","team_project_id") REFERENCES "public"."agent_teams"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_agent_scope_fk" FOREIGN KEY ("agent_id","agent_scope") REFERENCES "public"."agents"("id","scope") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_members" ADD CONSTRAINT "agent_team_members_agent_project_fk" FOREIGN KEY ("agent_id","agent_project_id") REFERENCES "public"."agents"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_team_assignments_project" ON "agent_team_assignments" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ix_agent_team_assignments_team" ON "agent_team_assignments" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_team_members_team_agent" ON "agent_team_members" USING btree ("team_id","agent_id");--> statement-breakpoint
CREATE INDEX "ix_agent_team_members_agent" ON "agent_team_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_teams_global_name" ON "agent_teams" USING btree ("name") WHERE "agent_teams"."scope" = 'global';--> statement-breakpoint
CREATE UNIQUE INDEX "ux_agent_teams_project_name" ON "agent_teams" USING btree ("project_id","name") WHERE "agent_teams"."scope" = 'project';--> statement-breakpoint
CREATE INDEX "ix_agent_teams_scope_project" ON "agent_teams" USING btree ("scope","project_id");--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "ck_agent_teams_scope" CHECK ("agent_teams"."scope" IN ('global', 'project'));--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "ck_agent_teams_scope_target" CHECK (CASE "agent_teams"."scope"
            WHEN 'global'  THEN "agent_teams"."project_id" IS NULL
            WHEN 'project' THEN "agent_teams"."project_id" IS NOT NULL
            ELSE false
          END);--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "ck_agent_teams_name_length" CHECK (length("agent_teams"."name") BETWEEN 1 AND 100);--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "ck_agent_teams_description_length" CHECK ("agent_teams"."description" IS NULL OR length("agent_teams"."description") BETWEEN 1 AND 2000);
