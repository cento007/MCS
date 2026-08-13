-- Phase 3: `memory_items` graduates from a TDS 03 §6 skeleton to the real table.
--
-- The NOT NULL columns below carry no DEFAULT, which is safe here and would not be in general:
-- nothing in Phase 1 or Phase 2 ever wrote a `memory_items` row (the skeleton had `id`, `tier`
-- and the two timestamps and no writer anywhere in the codebase), so every existing install has
-- an empty table and PostgreSQL has no rows to backfill. Inventing a default instead would leave
-- a permanent lie in the schema: there is no sensible default embedding model.
ALTER TABLE "memory_items" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "source_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "chunk_ordinal" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "content" text;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "content_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "embedding_model" text NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "embedding_dimension" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "qdrant_point_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_items" ADD COLUMN "indexed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "memory_items_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_memory_items_source_chunk" ON "memory_items" USING btree ("source_type","source_id","chunk_ordinal","embedding_model") WHERE "memory_items"."source_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_memory_items_source_ref_chunk" ON "memory_items" USING btree ("source_type","source_ref","chunk_ordinal","embedding_model") WHERE "memory_items"."source_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_memory_items_qdrant_point" ON "memory_items" USING btree ("qdrant_point_id");--> statement-breakpoint
CREATE INDEX "ix_memory_items_tier_project" ON "memory_items" USING btree ("tier","project_id");--> statement-breakpoint
CREATE INDEX "ix_memory_items_session" ON "memory_items" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ix_memory_items_agent" ON "memory_items" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "ix_memory_items_model" ON "memory_items" USING btree ("embedding_model","embedding_dimension");--> statement-breakpoint
CREATE INDEX "ix_memory_items_indexed_at" ON "memory_items" USING btree ("indexed_at");--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_source_type" CHECK ("memory_items"."source_type" IN ('session', 'commit', 'adr', 'obsidian_note', 'pull_request', 'document'));--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_tier_scope" CHECK (CASE "memory_items"."tier"
            WHEN 'session' THEN "memory_items"."session_id" IS NOT NULL AND "memory_items"."agent_id" IS NULL
            WHEN 'project' THEN "memory_items"."project_id" IS NOT NULL AND "memory_items"."session_id" IS NULL AND "memory_items"."agent_id" IS NULL
            WHEN 'agent'   THEN "memory_items"."agent_id" IS NOT NULL AND "memory_items"."session_id" IS NULL
            WHEN 'global'  THEN "memory_items"."project_id" IS NULL AND "memory_items"."session_id" IS NULL AND "memory_items"."agent_id" IS NULL
            ELSE false
          END);--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_source_identity" CHECK (("memory_items"."source_id" IS NOT NULL) <> ("memory_items"."source_ref" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_source_ref_length" CHECK ("memory_items"."source_ref" IS NULL OR length("memory_items"."source_ref") BETWEEN 1 AND 1024);--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_chunk_ordinal" CHECK ("memory_items"."chunk_ordinal" >= 0);--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_content_presence" CHECK ("memory_items"."content" IS NOT NULL OR "memory_items"."source_ref" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_content_hash" CHECK ("memory_items"."content_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_embedding_model" CHECK (length("memory_items"."embedding_model") BETWEEN 1 AND 200);--> statement-breakpoint
ALTER TABLE "memory_items" ADD CONSTRAINT "ck_memory_items_embedding_dimension" CHECK ("memory_items"."embedding_dimension" BETWEEN 1 AND 65536);