-- Corrects the two `agents` permission CHECKs shipped in 0006, which were unsound in
-- exactly the case they existed to catch.
--
-- A CHECK constraint **passes when it evaluates to NULL**, and `jsonb_typeof(permissions
-- #> '{repository,write}')` is NULL precisely when `write` is missing. So 0006's version
-- accepted `{"repository":{"read":true}}` — a half-written document that
-- `disallowedToolsFor` reads as a *smaller* deny list, i.e. a more capable agent than the
-- row describes. Every subexpression is now coalesced. Caught by
-- `agents.int.test.ts > REJECTS a half-written permission object`; kept as its own
-- migration rather than folded into 0006 because 0006 has already been applied.
ALTER TABLE "agents" DROP CONSTRAINT "ck_agents_permissions_shape";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "ck_agents_permissions_shell_subsumes";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_permissions_shape" CHECK (coalesce(jsonb_typeof("agents"."permissions"), '') = 'object'
          AND coalesce(jsonb_typeof("agents"."permissions" -> 'repository'), '') = 'object'
          AND coalesce(jsonb_typeof("agents"."permissions" #> '{repository,read}'), '') = 'boolean'
          AND coalesce(jsonb_typeof("agents"."permissions" #> '{repository,write}'), '') = 'boolean'
          AND coalesce(jsonb_typeof("agents"."permissions" #> '{repository,shell}'), '') = 'boolean');--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "ck_agents_permissions_shell_subsumes" CHECK (NOT (coalesce("agents"."permissions" #> '{repository,shell}', 'false'::jsonb) = 'true'::jsonb
               AND (coalesce("agents"."permissions" #> '{repository,read}', 'false'::jsonb) <> 'true'::jsonb
                    OR coalesce("agents"."permissions" #> '{repository,write}', 'false'::jsonb) <> 'true'::jsonb)));