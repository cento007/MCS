-- `sessions.runtime` admitted 'ollama'; nothing could ever write it.
--
-- `ck_agents_runtime` admits only 'claude_code', `AgentBindingResolver` copies an agent's runtime
-- onto the Session it binds, `insertSession` defaults to 'claude_code', and `ManagedRuntime`
-- drives the Claude Agent SDK unconditionally (F1.5). So the wider CHECK described a capability
-- the build does not have — the dishonest half of a pair, the other half being
-- `integrations.ollama.enabled` (withdrawn in 0011).
--
-- Checked before writing this: `SELECT runtime, count(*) FROM sessions GROUP BY 1` on the live
-- database returns a single row, `claude_code`. The ADD CONSTRAINT below therefore validates
-- against existing rows rather than failing on them; it is not NOT VALID, deliberately, because a
-- constraint that has never been checked is a constraint nobody can rely on.
--
-- Widening again is one edit to `AGENT_RUNTIMES` plus a CHECK alter on `agents` and `sessions` —
-- the schema now derives both lists from that one array, so they cannot drift apart a second time.
ALTER TABLE "sessions" DROP CONSTRAINT "ck_sessions_runtime";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "ck_sessions_runtime" CHECK ("sessions"."runtime" IN ('claude_code'));
