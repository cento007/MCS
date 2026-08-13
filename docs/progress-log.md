# Mission Control — Progress Log

Running record of completed work, decisions, and milestones. Newest entries at the bottom of each section. Maintained by the orchestrator; updated at every milestone.

## 2026-08-11 — Planning phase kickoff

### Completed

- **PRD updated to v2.1** — added §4.4 Settings Management (full Settings page: general, integrations with encrypted secrets + test-connection actions, notifications, memory, agents, security, service health; bootstrap settings in env/config file) and §8.6 (Settings as dashboard page). (`Requirements.md`)
- **Project plan created** — `docs/project-plan.md` by project-manager agent. Structure: WS0 foundation decisions (F1–F9) gate six parallel workstreams (WS1 service architecture, WS2 API contracts/events, WS3 database schema, WS4 frontend architecture, WS5 wireframes/design system, WS6 test strategy) followed by WS7 integration/review by architect-reviewer. Includes risk register (top risks: Claude wrapper feasibility, Redis-on-Windows, scope creep, parallel drift, cross-platform gaps) and scope guard (Phases 1–2 deep, Phases 3–5 interfaces only).
- **Agent tooling reviewed (aitmpl.com / claude-code-templates catalog)** — decided to add: `websocket-engineer` (live session chat), `security-auditor` (auth/secrets/audit design), `api-documenter` (API contracts), `postgres-schema-design` skill. Rejected devops-infrastructure catalog (Terraform/Azure/K8s — irrelevant to native no-Docker deployment).
- **Agents/skill installed** — `websocket-engineer`, `security-auditor`, `api-documenter` into `.claude/agents/`; `postgres-schema-design` skill into `.claude/skills/` (raw files from the claude-code-templates repo; the npx installer was blocked by permission policy).
- **Reference repo identified** — https://github.com/builderz-labs/mission-control (user-designated). Same product category; validates TypeScript/Node + Next.js stack, REST/OpenAPI + WebSocket/SSE realtime, governance-above-runtimes model. PRD constraints win on conflicts (PostgreSQL not SQLite, Qdrant, no Docker, Windows-native dev). Findings forwarded to WS0.

- **Spike completed: Claude Code programmatic control** — full report at `docs/research/claude-code-control-spike.md`. Verdict: managed sessions via the Claude Agent SDK (TypeScript) — streaming, resume/fork, per-session cost; observed sessions via hooks (HTTP POST to backend) + version-tolerant transcript JSONL tailing; permission gating maps to permission modes / allowedTools / PreToolUse hook decisions; concurrency safe, real limit is Anthropic rate limits. (Task #2 ✓)
- **WS0 Foundation decisions drafted** — `docs/tds/01-foundation-decisions.md`. Highlights: TypeScript everywhere (Node 22 + Fastify 5 backend; React 19 + Vite SPA + Tailwind 4; Drizzle ORM; pnpm monorepo; Vitest/Playwright). **No Redis in V1** — pg-boss queue on PostgreSQL behind a QueuePort abstraction (solves the Windows-dev Redis problem outright). Workers = separate OS processes talking only via the Postgres queue. UUIDv7 IDs; REST `/api/v1` + cursor pagination + single multiplexed WebSocket (SSE rejected); event grammar `domain.entity.verb-past` with at-least-once delivery; session state machine locked (resume of a completed session creates a new linked session); bootstrap env vars `DATABASE_URL`/`MC_HOST`/`MC_PORT`/`MC_ENCRYPTION_KEY`/`MC_DATA_DIR`, all else DB-stored settings.

- **WS0 Foundation Contract FINAL and APPROVED** — spike incorporated into §F1.5 (Agent SDK wrapper final, hooks + transcript tailing for observed sessions); architect-reviewer sign-off recorded in the doc (Approved 2026-08-11, zero blocking findings). Non-blocking findings routed: pause-state physical semantics → WS1; WebSocket Origin validation → WS2; outbox transaction mechanism pinning → WS3; PRD Redis-deviation note → WS7. (Task #1 ✓)

### In progress — parallel TDS fan-out (dispatched 2026-08-11)

- ~~WS1~~ **WS1 COMPLETE** — `docs/tds/02-service-architecture-and-deployment.md`. Highlights: four app processes, queue-only worker IPC; ManagedSessionController per session (SDK streaming-input mode, durable session.launch queue jobs, restart recovery: orphaned running → failed with resume-as-new); cold-pause semantics (SDK child disposed, in-place resume, concurrency slot released); observed sessions get an applicability matrix (no pause/resume; end = stop observing; tailer degrades to hook-only on parse drift); heartbeat-row health model; systemd units in deploy/, nightly pg_dump backups; single root `.env` decided. §12 handoff notes forwarded to WS2/WS3/WS5/WS6 mid-flight. (Task #3 ✓)
- ~~WS2~~ **WS2 COMPLETE** — `docs/tds/04-api-contracts-and-events.md`. Full `/api/v1` resource catalog incl. settings/test-connection/health, WebSocket frame protocol, event catalog, error-code registry, OpenAPI 3.1 sessions snippet. Reviewer finding resolved: WS upgrade Origin allowlist stored as a DB security setting (`security.allowedOrigins`) rather than a new bootstrap env var. WS1 handoff absorbed: `POST /api/v1/hook-events` ingest endpoint with ingest-scoped token, `OPERATION_NOT_SUPPORTED` (409) for transitions inapplicable to a session type. Note for WS7: `session.message.delta_appended` is deliberately WS-only/non-durable. (Task #4 ✓)
- ~~WS3~~ **WS3 COMPLETE** — `docs/tds/03-database-schema.md`. 19 Phase 1–2 tables + 3 Phase 3/4 skeletons + vendored pgboss schema; typed settings table + fully separated secret_items (AES-256-GCM, AAD-bound, key_version rotation); outbox finding resolved (pg-boss send() on the caller's Drizzle transaction via db adapter, mandatory tx in QueuePort, singletonKey dedupe); app-assigned message ordinals with runtime dedupe; WS1 handoff integrated (service_heartbeats, transcript_tail_states, messages.status for cold pause, recovery semantics pinned). No conflicts. (Task #5 ✓; reassigned from postgresql-dba to backend-architect + postgres-schema-design skill)
- ~~WS4~~ **WS4 COMPLETE** — `docs/tds/05-frontend-architecture.md`. TanStack Query v5 + three small Zustand stores; refcounted channel subscriptions on the single WebSocket with reconnect → resubscribe → invalidate mapped query groups; two-layer live chat (committed REST messages + ephemeral rAF-batched streaming buffer, virtualized reverse-infinite list); composer state matrix per F7 (paused = disabled, completed/failed = resume-as-new banner, observed = monitor-only); schema-driven Settings forms with write-only SecretField and save-first Test Connection. No conflicts. (Task #6 ✓)
- **WS5 Wireframes & design system** — document written: `docs/tds/06-wireframes-and-design-system.md` (71 KB; design tokens + component inventory, all PRD §8 screens, full §4.4 Settings page with masked secrets/Test Connection/Services health, mobile monitoring variants, accessibility notes). Two closing items handled by the orchestrator directly: (a) WS1 observed-session handoff applied — `[Stop observing]` as the sole action with explicit "your terminal session keeps running" confirm copy, no Pause/Resume (`OPERATION_NOT_SUPPORTED`), plus a `⚠ Degraded fidelity` chip for hook-only ingest that renders known events rather than a blank conversation; (b) worker-health vocabulary drift with WS1 reconciled (WS1 `stale` → WS5 `▲ degraded`, thresholds cited). Remaining: critique findings being applied. (Task #7)

- **WS5 UX critique COMPLETE** — findings register persisted at `docs/reviews/ws5-ux-critique-register.md`. Verdict on PRD §4.4 Settings coverage: **complete** (all seven categories, all six integrations, every named field; defects were interaction-semantic, not coverage gaps). 12 must-fix accepted, 8 of 13 secondary accepted. Highest-value catches: UUIDv7 prefixes are useless as human labels (leading bits are a timestamp); `Ctrl+1…9` is browser-reserved and would never have fired; three design tokens fail WCAG AA by computed contrast; the streaming ARIA spec was self-contradictory and would have excluded screen-reader users from the product's core output; a mid-stream failure discarded the partial turn that is the entire triage signal; and PRD §4.3 Workflow Modes had no UI surface anywhere. Also surfaced six genuine WS4↔WS5 contradictions (composer model, navigation model, test-connection semantics, archived action set, secret-save path, terminology) — resolutions pre-arbitrated by the orchestrator so both documents converge in one pass rather than ping-ponging through WS7.
- **WS4 reconciliation COMPLETE** — `05-frontend-architecture.md` revised: right-panel session layout (§6.7), shell-level session switcher with both surfaces projecting one `uiStore` set (§6.5), start-with-prompt composer, `[Stop]` control (§6.8), four-case partial-turn reconciliation replacing "committed always wins" (§6.2), `Alt+1…9` + `Ctrl+K` palette (§9.4), title-first session identity (§9.3), self-hosted woff2 fonts (§9.1). It also independently caught that WS4 listed `Clone` for archived sessions while WS2 forbids cloning an archived session — removed.
- **WS5 critique application COMPLETE** — `06-wireframes-and-design-system.md` marked Final. All 12 must-fix and 8 accepted secondary findings applied: title-first session identity (§2.2), Needs Attention widget + Dashboard services strip, connection-liveness chip with frozen (`~`-prefixed) durations, shell-level OpenSessionsStrip rendering one persisted open set three ways, `[Stop]` control, partial-turn retention on mid-stream failure, Settings dirty-state contract with guard modal, corrected contrast tokens + a 10-row WCAG assertion table for WS6, the five-part streaming-a11y spec, `Alt+1…9` + `Ctrl+K` palette, and per-F7-state glyphs so colour is never the sole carrier. Two judgement calls accepted: it declined to rename API-token `[Revoke]` to `[Clear]` (different entity operation, and WS4 agrees), and it independently flagged the same missing turn-interrupt contract the orchestrator had already fixed. Both of its new §8.2 flags marked resolved in place. (Task #7 ✓, Task #10 ✓)

### Orchestrator fixes applied directly (gaps surfaced by the reconciliation)

1. **Missing interrupt API** — the new `[Stop]` control in WS4/WS5 had no endpoint. Added `POST /api/v1/sessions/{id}/interrupt` (WS2 §6.3.1): stops the in-flight turn with **no F7 transition** and no `session.state_changed`; persists the partial assistant Message with `status = 'interrupted'` (reusing WS3's existing `messages.status`), so the partial turn is retained rather than discarded. New error code `NO_TURN_IN_FLIGHT`.
2. **Error-code drift** — WS1 provisionally named the observed-session rejection `UNSUPPORTED_FOR_SESSION_TYPE`; WS2 (which owns the error registry per F5.4) had assigned `OPERATION_NOT_SUPPORTED`, used consistently in six places. Marked WS1's name superseded in both documents so one canonical code remains.
4. **`CLAUDE.md` corrected and brought current** (WS7 finding N14) — it still described the repo as containing only `Requirements.md`, cited PRD v2.0, and listed **"Docker architecture"** as a TDS deliverable three lines above the no-Docker constraint. Rewritten: design-phase status with the TDS document map, an explicit **no-Redis** constraint recording the pg-boss deviation, the chosen stack (F1) with bootstrap config vars, and a pointer that the Foundation Contract is binding rather than advisory.
3. **Stale WS4 preamble** — §6.6 still deferred observed-session lifecycle to WS1 "until WS1 defines them"; WS1 §5.2 had defined it. Rewritten to state the resolved matrix (Stop observing, no pause/resume, degraded-fidelity indicator).

### Orchestrator verification sweep (independent of agent self-reports)

- **No-Docker constraint verified** across all 7 TDS files — all 8 "docker" occurrences are prohibitions; WS6 explicitly rejects GitHub Actions `services:` containers because they are Docker, keeping CI provisioning identical to native local dev.
- **Settings coverage verified** — 31 "Test Connection" references across WS2/WS4/WS5/WS6; all six integrations (GitHub, Claude Code, Telegram, Obsidian, Qdrant, Ollama) specified in the API contract.
- **No illegitimate TBDs** — remaining TBDs are Phase 3/4 event consumers only (permitted by the scope guard); both real TBDs (pause semantics, `.env` layout) are marked resolved in WS1's header.
- ~~WS6~~ **WS6 COMPLETE** — `docs/tds/07-test-strategy.md` (65/25/10 pyramid; disposable native-PostgreSQL template DBs, no containers; AgentRuntimePort mock seam + recorded stream-json contract corpus; dual-OS CI matrix with Windows E2E smoke; coverage floors + flake quarantine). WS1 addendum verified applied: restart recovery, durable `session.launch` jobs, rate-limit backoff tests. (Task #8 ✓)

### Incident: session limit (2026-08-11 ~20:16)

The WS2 and WS5 agents were killed by an account session limit **after** writing their complete documents — both files verified complete on disk (closing sections and handoff notes present). No work lost; no relaunch needed. WS5's remaining internal step (UX critique) was re-dispatched afterwards.

### WS7 integration review — first pass complete, PROVISIONAL (not accepted)

`docs/tds/00-overview.md` written: document map, system Mermaid, canonical vocabulary pointer, **sanctioned deviations register** (10 entries led by D1 Redis→pg-boss), 10 arbitrated decisions, acceptance checklist, blocking/non-blocking findings, sign-off table.

**Verdict:** the architecture holds — zero Foundation changes required, no Phase 3–5 over-build found, F9 callouts present in all six downstream docs, constraint audit passes (no Docker, systemd confined to `deploy/`, PostgreSQL not SQLite, single-user auth). What failed is **integration debt at the seams between documents written in parallel**: WS2 specified resources and fields WS3 never stored, and WS3 chose vocabularies WS2 never adopted. Two acceptance criteria fail as a result (zero contradictions; developer can start Phase 1 without inventing contracts).

**12 blocking findings, dispatched as two parallel packages (Task #11):**
- *Package 1 → WS3 schema:* missing `sync_runs` table (3 endpoints + 4 events keyed on it), no full-text search index despite WS2 promising FTS over five entity types, PR state enum contradiction, undiscriminated clone/resume lineage, five API fields with no column (incl. `api_tokens.scopes`, on which the whole hook-ingest auth model rests), notification-type semantics, workflow-mode storage.
- *Package 2 → WS2 API:* launch-at-capacity 409 contradicting WS1's durable queue job, `Message` missing `ordinal`/`status` and sorting by `id` (the exact ordering WS3 rejected), ADR status enum, audit-entry field/actor mismatch, observation-degradation event missing entirely (so WS5's degraded badge had no data source), workflow-mode setting, and the `GET /schedule` endpoint backing the arbitrated Upcoming Tasks decision.

**Notable arbitration (A1):** the Dashboard "Upcoming Tasks" widget resolves to a **computed schedule read model**, not WS4's empty-state placeholder — the reviewer's reasoning being that a permanently empty widget on the most-visited page is not the simpler option but the dishonest one, and that the schedule needs no new entity since it is derivable from settings plus last-sync timestamps.

- **WS7 package 2 (WS2 API) COMPLETE** — `04-api-contracts-and-events.md`. B3: the at-capacity `409` is gone — `start`/`resume` now return `200 { meta: { launch: 'started' | 'queued' } }` and a durable pg-boss job carries it, so saturation is never an error (new §6.2.1). B6: `Message` exposes `ordinal`/`status`/`occurredAt`, lists sort by `ordinal` with the cursor keyed on it, and `createdAt` is explicitly marked "never an ordering key". B12: new `Session.observation` field plus `session.observation_degraded` / `session.observation_restored` events, so WS5's degraded badge renders on load and not only on a live event. B5/B9/B11b/B13 applied. Non-blocking N1 (`sessionType` chosen), N4 (timeline `kind` demoted to a presentation projection over F6 event names, phantom `note` kind removed), N5, N10 (**WS2 owns the settings key registry** — no third document) also resolved. Judgement call accepted: it added `session.observation_restored` but deliberately did not invent a re-attach policy, since that is WS1's anti-flap territory.

- **WS7 package 1 (WS3 schema) COMPLETE** — `03-database-schema.md`, now 20 tables. B1: `sync_runs` added with a partial unique index on non-terminal runs, turning WS2's "a run is already running" 409 into a database guarantee rather than an application check. B2: stored generated `search_tsv` + GIN per searchable table (a consolidated `search_documents` table was considered and rejected with reasons); text search config, `websearch_to_tsquery` parser, `ts_rank_cd` normalized to (0,1) so the five UNION branches are comparable, `ts_headline` applied outside the LIMIT, and core-PostgreSQL-only (no `pg_trgm`/`unaccent`) for Windows/Ubuntu parity. B4/B7/B8/B10/B11a applied, incl. `api_tokens.scopes text[]` with a containment CHECK. Non-blocking N2/N3/N11 closed with explicit API-mapping tables; N1 closed by renaming the column to **`sessions.session_type`** so the API mapping is mechanical rather than a special case.
- **Cross-document items the orchestrator closed:** WS2 §11's search cursor documented as the `(rank, occurredAt, id)` triple rather than a UUIDv7 keyset (WS3 pinned the keyset but could not edit the API doc), and the `sessions.session_type` rename landed in time via a mid-run message.

### WS7 final pass — TDS **APPROVED** for Phase 1 implementation

All 12 blocking findings verified closed **by reading the revised files, not the summaries**. Zero cross-document contradictions remain. **No Foundation Contract change was required at any point** across two review passes over seven documents — the strongest available signal that WS0's gate did its job. Acceptance criteria: 10 of 10 met.

**Three arbitrations made at the closure gate:**

- **A11 — observation degradation is terminal for the life of a Session; `session.observation_restored` withdrawn.** The reviewer traced the event and found it had *no producer anywhere*: WS2 deferred the trigger to WS1, and WS1 has no re-attachment policy by design (`degraded` is deliberately sticky so the badge cannot flap). The deciding argument was truthfulness rather than cost — re-attaching the tailer would not recover the transcript lines already skipped, so "restored" would tell the operator fidelity came back when only *future* fidelity did.
- **A12 (UX WC5) — no `+` FAB for new sessions on mobile.** Resume-as-new and Clone remain, since they inherit working directory, repository, and branch from a Session already vetted on a desktop. What mobile omits is composing a *new* launch target, because the launch modal's mandatory working-tree disclosure and branch-change acknowledgement cannot be honestly reviewed on a phone — and a FAB would give the most consequential, least-verifiable action the highest-prominence slot on the smallest screen.
- **A13 — session-title derivation belongs to the Backend.** Decisive argument: WS3 weights `sessions.title` as rank class A in the search index, and Telegram, Obsidian, and exports all read it, so a client-only derivation would leave every non-browser surface saying "Untitled".

**Both flagged judgement calls adjudicated:** WS3's `ON DELETE RESTRICT` change **confirmed** (with the lineage invariant in place, `SET NULL` would fire and then fail the check anyway, so RESTRICT just produces the honest error earlier). WS2's observation-recovery contract **rejected as incomplete** and resolved via A11 rather than left as a gap.

**Two new findings**, both traceable to accepted UX work, both recorded as open WS2 leaf items off the critical path: no spend-aggregate endpoint (the Dashboard shows spend-vs-budget but `costUsd` is per-session on cursor-paginated lists, so a client cannot compute a daily total), and no session Files endpoint (the panel is specified by both WS4 and PRD §8.3, but `files[]` exists only on single-commit fetches, making it N+1).

**Orchestrator closed A11's outstanding half (2026-08-12).** WS7 recorded the WS2 edits as still outstanding — a live contradiction, since WS1/WS5/WS6 already stated terminality while WS2 still defined a `_restored` event with producer `backend`. Removed from all six locations (§6.9, §6.7 timeline mapping, §14.3 channels, §15.2 event 12, both §17 hand-off notes); the only surviving mention is the explicit statement that the event does not exist. `00-overview.md` §7.2 item 3 updated from outstanding to closed.

### Sign-off

`docs/tds/00-overview.md` §9 — **WS7 architect-reviewer: APPROVED, 2026-08-11**, with four standing conditions: the remaining §7.2 leaf items land before the sprints that need them; A13 gets transcribed into WS1; any change to an arbitrated value set must land across all affected documents in one revision or it re-opens what this gate closed; and `pgboss` stays vendored while `MC_ENCRYPTION_KEY` stays backed up out-of-band.

## 2026-08-12 — Brand direction supplied

The user added `Design.md`, a Supabase-inspired token set (white canvas, near-black ink, single emerald CTA, Circular display type). Assessed against the approved TDS before adoption; three findings drove the decision:

1. **The emerald is unusable as a foreground on white.** Computed: `#3ecf8e` on `#ffffff` = **2.00:1**, failing even the 3:1 non-text floor — which is why the source design only ever uses it as a button fill. On the dark canvas `#1c1c1c` it is **8.54:1**. The palette therefore performs *better* in the dark-first direction PRD §14 already mandates.
2. **Circular is commercially licensed** (Lineto) and cannot be self-hosted, which WS5/WS4 require because the product runs on an offline LAN server; the fallback chain would silently degrade to Helvetica/Arial and lose the character that defines the look.
3. **The component vocabulary is a landing page** — pricing cards, feature cards, hero nav, footer — not the dense operator console the TDS needs. Geometry transfers; components do not.

Also flagged: an emerald brand accent collides with the F7 `running` state green `#3FB950`, so a running badge would read as a primary button.

**User decisions:** dark-first with the emerald accent (adopting Design.md's neutral near-black canvas, radii, spacing and type metrics), and substitute an open-licensed humanist face rather than buying Circular.

**COMPLETE — `06-wireframes-and-design-system.md` rev. 2.** Neutral near-black canvas (`#1c1c1c`/`#202020`/`#2b2b2b`) replaces the cool blue-blacks; emerald accent (`#3ecf8e`, 8.54:1 on canvas); Design.md's radii, spacing and type ladder adopted verbatim on self-hosted Inter. **74 contrast ratios recomputed from the shipped file with zero mismatches** — orchestrator independently verified three samples (`#ededed` 14.56:1, `running #4fa8bd` 6.225:1, `--mc-border-control` on raised 3.297:1); all matched exactly.

Notable decisions beyond the brief:

- **Accent/state collision resolved by rule, not just hue:** "`--mc-accent` marks operator intent and position — actionable, selected, focused, current. It never reports a system condition." `--mc-success` was moved off green too, on the reasoning that "emerald means CTA except when it means healthy" fails on the one screen operators watch constantly. Two accent-as-state usages were removed (the spend meter's under-threshold fill and the `live` connection dot).
- **Colourblind distinctness verified by simulation, not assumption.** Viénot–Brettel–Mollon simulation scored by ΔE *in simulated space*. The agent's first pick — a rose-red `failed` chosen on the theory that added blue helps deuteranopes — was **disproved by its own test** (ΔE 7.4 against the emerald under deuteranopia, 5.4 against `archived` under protanopia); the warmer coral `#f47460` scores 23.5/23.7. Recorded in §2.1.6 so it is not "corrected" back.
- **A genuine a11y finding the brief missed:** rev. 1 used one `--mc-border` for both card edges and input outlines with no stated floor. SC 1.4.11 needs 3:1 for control boundaries, and on a near-black canvas *no darker fill can ever reach it* (black on `#202020` tops out at 1.29:1), so the field's fill mathematically cannot carry identification — the border must. New `--mc-border-control` `#7a7a7a`. Only visible once the palette was rebased.
- **Sharpest implementation trap, recorded:** `--mc-radius-sm` changed *meaning* (4px badges → 6px buttons/inputs). Every badge must repoint to `--mc-radius-xs` or it silently grows — and both names still compile.
- **Rejected beyond the three flagged:** Design.md's six unused accent hues (admitting them contradicts the restraint principle taken from the same file), its hairlines as control boundaries (`#dfdfdf` on white is 1.33:1 — landing-page decoration), `ink-mute #707070` as body text (3.44:1), and `accent-yellow #ffdb13` for `paused` (12.49:1 — passes, but the loudest possible mark for the calmest state).

**WS4 absorbed the changes** (`05-frontend-architecture.md` §9.1): added `--color-border-control` and `--color-text-disabled` to the token structure, split line-height/weight/tracking into separate axes (the scale carries 18px at two line-heights, which a fused token cannot express), retired weight 600, recorded the two consumption rules (accent never reports state; control boundaries never come from the fill), and recorded the Circular licensing rejection so it is not re-introduced. (Task #12 ✓)

## 2026-08-12 — Post-approval leaf contracts and scaffolding

**WS7's two open contracts closed** (Task #13) — `04-api-contracts-and-events.md`:

- **`GET /api/v1/spend`** — bounded read model serving the Dashboard stat, top-bar chip, Needs Attention row and Settings line from one server-computed `dayStatus`, so the four surfaces cannot disagree about when the bar turns amber. Period semantics pinned explicitly to the instance timezone setting (**not** server `TZ`, PostgreSQL session `TimeZone`, browser zone, or UTC), with DST-correct bounds computed by adding the interval to the *local* timestamp before conversion, and `periodStart`/`periodEnd` echoed as UTC instants so no client recomputes a boundary from its own clock. Buckets on `started_at` — the agent reasoned through why `created_at` (a session created 23:55 and started next morning) and `completed_at` (a long session reading $0.00 all day then dumping into whichever day it ended) are both wrong. Refused to cache, on the grounds that the two moments the number matters most — right after a session completes, and at local midnight — are exactly where a TTL lies.
- **`GET /api/v1/sessions/{id}/files`** — de-duplicates commit files against tool-activity files, normalizing absolute tool paths against the repo root while deliberately preserving out-of-tree paths verbatim with `outsideRoot: true`, because an agent reading `~/.ssh/config` must appear rather than be normalized away. Degraded observed sessions report `completeness: 'partial'` with a reason, and WS5 is instructed to render that visibly — a short file list is otherwise indistinguishable from a session that genuinely touched few files. Pagination declined on structural grounds, not volume: the sort key is a computed aggregate with heavy ties (a poor keyset) and must be computed in full to rank at all, so paginating would make the server repeat the work for the same bytes.

**Two WS3 additions, both from disproved assumptions.** WS7's §7.2 assumed a suitable date-ranged index already existed for the spend aggregate; it did not (the existing index leads with `project_id`, the partial index covers non-terminal states while spenders are mostly `completed`, and `created_at` is the wrong column) — so `ix_sessions_started_at ... INCLUDE (total_cost_usd)` was added. And `messages.tool_file_path` was added rather than extracting from `tool_payload` at read time, since that JSONB column is documented as "input or result" with no discriminator, and a read-time extraction would bury runtime-version knowledge in a SQL expression that fails silently.

**Setting gap closed:** WS5 renders `alert at [80] %` and the progress rule needs a threshold, but no document stored one. Added inside an existing JSONB settings object, so no registry entry and no schema change.

**Cosmetics:** N16 and N17 closed; N18–N20 correctly identified as WS5's and routed. A13 (session-title derivation) correctly flagged as never having been in the brief — dispatched separately rather than left to a claim of completeness.

### Environment (verified 2026-08-12)

Node v26.4.0, pnpm 10.29.3, npm 11.17.0, git 2.50 — present. **PostgreSQL is not installed** (no `psql`, `pg_ctl`, or service); install steps supplied to the user, PostgreSQL 17 recommended so the Windows dev box, the Ubuntu server, and WS6's CI plan all share one major version. **Node version discrepancy:** F1 pins Node 22 LTS but 26.4.0 is installed and 22 is now maintenance-LTS — scaffold instructed to admit both via `engines` rather than silently pick, pending a decision on whether the Foundation Contract moves to the current LTS.

**A13 and the last cosmetics closed.** WS2 §6.11 now carries the session-title contract: a deterministic derivation (no LLM step) that skips blank lines and lone code fences, collapses whitespace, and truncates at 60 **Unicode code points** — code points rather than UTF-16 units specifically so a cut can never split a surrogate pair. Idempotence is enforced by `WHERE title IS NULL` rather than a `title_derived` flag, on the reasoning that a boolean carries the same information while adding a column that can disagree with the value it describes. Derivation runs inside the same transaction as the first user-Message insert and only when that insert actually created a row, so a deduplicated replay derives nothing. Observed sessions take their title from whichever ingest channel wins, both converging on one row via the dedupe key. **No new event:** the title write already sits in the transaction that emits `session.message.appended` on `session:{id}`, which every title-rendering surface already receives — adding `sessions` to that event's channel list was explicitly rejected as a firehose. No WS3 change; `sessions.title` already existed, and the guard was chosen so none was needed.

N18–N20 applied to WS5, with the ADR status chip designed so **colour carries exactly one bit — in force or not** (only `accepted` is filled; the rest are outline tags), borrowing neither the F7 state ramp nor the accent, and using only token pairs already asserted in §7.1 so it adds no new contrast obligation.

**Stale-pointer cleanup (orchestrator).** The agent flagged that WS5 still described Upcoming Tasks as an open arbitration in two places, three sections from a new footnote stating the outcome. Both retired: §5.2 and §8.2 item 1 now record A1's decision and its reasoning rather than posing the question.

### Monorepo scaffold COMPLETE and independently verified (Task #14)

Six workspace projects: `apps/{backend,frontend,telegram-worker,sync-worker}`, `packages/shared`, plus `deploy/{systemd,windows}` and `e2e/`. Orchestrator re-ran the gates rather than accepting the agent's report: **typecheck** clean across all five packages, **lint** 85 files clean (Biome), **test** 57 passing in 8 files. Then proved the database chain the scaffold could not test when it started: `pnpm db:generate` read the root `.env` and resolved the Drizzle config (0 tables — correct, WS3's DDL is not authored yet), and `pnpm db:migrate` connected to the live `mission_control` database and applied migrations successfully. Config loader → `.env` → Drizzle → PostgreSQL works end to end on Windows.

**Two real bugs its own tests caught, both worth keeping:**

1. **Empty secret sealing.** An empty plaintext seals to exactly the 16-byte auth tag, which WS3's `secret_items.ciphertext CHECK (octet_length > 16)` forbids — so the row would be rejected at write time. `encryptSecret` now rejects it explicitly: clearing a secret is a DELETE, never an encryption of `""`. WS1's settings service must not assume otherwise.
2. **Workers exited 0 in ~300 ms.** The no-op queue holds nothing and the heartbeat timer is `unref`'d, so nothing referenced the event loop. Under systemd `Type=simple` that is a silent failure the operator never sees. A documented keep-alive was added, marked deletable the moment the pg-boss driver holds a real connection.

**Node version resolved (F1.2 amended).** F1 pinned "Node.js 22 LTS"; 22 is now maintenance-LTS and the dev host runs 26.4.0, so a literal pin would have created a dev/prod split on day one — exactly what F8's cross-platform rule exists to prevent. Restated as a **floor (≥22) plus a policy**: production installs whichever release is active LTS at deploy time (24 today; 26 enters LTS in October 2026, before this reaches a server), and WS6's CI matrix now tests floor and target separately so a version regression is attributed rather than discovered in production. Nothing in the stack uses a version-specific API.

**Scaffold deviations recorded by the agent:** `GET /api/v1/health` is not in WS2's contract — implemented as an unauthenticated, DB-free *liveness* probe, explicitly distinct from the authenticated `GET /api/v1/services/health` operator read model, for WS2 to adopt or replace; drizzle-kit config lives beside the schema in `packages/shared` rather than in the backend app; `@font-face` rules are written but commented out pending the four woff2 files (Vite fails a build on a missing asset, and the agent was told not to download binaries); `@fastify/websocket` deliberately not installed so the lockfile carries no unused transport; the integration tier is configured-out rather than stubbed, since inventing the template-database mechanism before WS3's DDL would be guesswork.

`CLAUDE.md` now carries the real command table, replacing the "no build/lint/test commands yet" placeholder.

## 2026-08-12 — Phase 1 begins: database schema live (Task #15)

WS3's DDL authored as Drizzle definitions in `packages/shared/src/db/schema/` (12 files by domain), migrated and **verified against the live database by introspection, not by assertion**. Orchestrator independently confirmed the counts: **23 tables, 49 named indexes, 60 CHECK constraints, 18 foreign keys, 5 generated `tsvector` columns** — matching the document exactly, nothing missing, nothing extra. Index shapes in the DB: 66 btree, 5 GIN, 1 BRIN; 10 partial, 2 expression, 1 covering.

Only **two** items needed hand-written SQL (`0001_include_and_fillfactor.sql`) — `INCLUDE (total_cost_usd)` on the spend index, which Drizzle's index builder cannot express, and `fillfactor = 90` as an `ALTER TABLE ... SET`. Everything the brief flagged as risky turned out expressible declaratively, including the table-level lineage invariant, all 10 partial indexes, the stored generated `tsvector` columns, the partial GIN, and the BRIN. Raw `sql` was used for descending index columns rather than Drizzle's `.desc()`, which would have emitted `DESC NULLS LAST` and diverged from the document.

The F7 vocabulary is **imported rather than restated** — the state CHECKs render from `SESSION_STATES`, and `ix_sessions_active`'s predicate is derived by subtracting the terminal states, so the index cannot drift from the state machine.

### A real defect found and fixed

`ck_api_tokens_scopes` did not do what it claimed. The guard read `array_length(scopes, 1) >= 1` with the stated intent "never an empty (= powerless) token" — but `array_length('{}'::text[], 1)` evaluates to **NULL**, not 0, and a CHECK constraint **passes** when its expression is NULL. An empty-scope token inserted successfully; confirmed against the live database before fixing. `cardinality('{}')` returns 0 and fails the comparison, so `cardinality` is the correct function. Fixed in the schema and the document (migration `0002`), and re-verified: the empty array is now rejected while a valid `['ingest']` scope still inserts.

### A second finding, documented rather than discovered later

WS3 §3.11 said "every ingest write is `ON CONFLICT DO NOTHING`" against the dedupe key — but that index is **partial**, so the conflict target must repeat the predicate. Omitting it does not silently skip deduplication; PostgreSQL raises *"no unique or exclusion constraint matching the ON CONFLICT specification"* and the write fails outright. The correct form is now written into the document, along with the same caveat for `ux_sync_runs_active`.

Other deviations recorded by the agent: the `search_tsv` columns were folded into `CREATE TABLE` rather than following the document's separate additive-migration sequence (identical end state, zero rewrite cost on a greenfield database); the 57 inline unnamed CHECKs were given stable `ck_<table>_<subject>` names, which the document's own "widened by CHECK alter" evolution story requires; and `numeric(12,6)` maps to TypeScript `string` in Drizzle, so the serializer must convert explicitly for WS2's `numeric → JSON number` mapping.

All gates green after the fix: typecheck across 5 packages, Biome clean on 97 files, 57 tests passing, and `db:generate` reports no drift.

## 2026-08-12 — Phase 1: authentication + integration harness (Task #16)

Login/logout/me, password change, API token CRUD, a global authenticated-by-default guard, and audit logging — implemented to the WS2 contract. Orchestrator re-ran every gate: **100 unit tests passing with no database present** (that property is now *enforced* rather than assumed — the health unit test builds the app with a `Proxy` that throws on any DB property access), **59 integration tests**, typecheck across 5 packages, Biome clean on 124 files.

**argon2 dependency chosen for deployability, not popularity.** `@node-rs/argon2` ships NAPI prebuilds for Windows and both Linux libc variants plus a WASM fallback — no `node-gyp`, no build script, nothing that works on the dev box and fails on the server. The obvious `argon2` package compiles from source and was rejected for exactly that reason. OWASP argon2id parameters, stored per-row in the PHC string so they can be raised later without a migration.

**The `ingest` scope is a real authorization decision.** Tested: an `ingest` token is rejected with 403 on full-access routes and accepted only on the ingest policy route; a cookie is rejected *on* the ingest route. The constant is exported so the future hook endpoint declares the same decision rather than re-deriving it — which is what stops the hook profile installed on a dev machine from quietly holding full API access.

**Integration tier stood up** (WS6 §3): a migrated `mc_test_template` rebuilt only when a content hash of the migration set changes, per-file `CREATE DATABASE ... TEMPLATE` clones, orphan sweep, dropped `WITH (FORCE)`. Verified behaviourally rather than by inspection — a planted orphan database was swept, a corrupted template hash triggered a re-migration, and three files ran in parallel on separate databases.

### Contract defect found and fixed: `audit_log_entries.request_id`

The column was `uuid`, but F5.4 deliberately honours an inbound `X-Request-Id` so an external caller can supply its own correlation id — and those are frequently not UUIDs. That left only two options, both wrong: fail the audit insert, or store `NULL`. The implementation had chosen `NULL`, which loses the correlation in **exactly the externally-originated case that most needs it** — a Claude Code hook POST. Widened to `text` bounded 1–128 (matching the request-id generator's own cap), in the document, the schema and the writer; migration `0003` applied and the live column verified as `text`. The test that asserted the old behaviour now asserts the correlation survives, plus a new case clamping an over-long id rather than failing the insert.

Also corrected: WS3's audit-action comment exemplified `auth.login_succeeded` while WS2 — which owns the registry — specifies `auth.login`. The schema comment now points at WS2 rather than offering a competing example.

### First-run bootstrap — the TDS was silent, and the gap is recorded

No document said where the first account's credentials come from, and there is no answer a server can invent: auto-seeding needs a default password, and omitting it leaves a migrated database with no way in, since login is the only public route. Implemented as an explicit operator command, `pnpm auth:create-user`, with the gap flagged in a header comment. Password from `MC_BOOTSTRAP_PASSWORD` (tooling-only, so the F8.2 bootstrap set stays locked), then piped stdin, then a hidden TTY prompt — **never from argv**, which is rejected explicitly. Re-running reports `already_exists` and changes nothing; `--reset-password` is the deliberate lockout escape hatch. Runs under `pg_advisory_xact_lock`, so concurrent invocations create exactly one account.

## 2026-08-12 — Phase 1: session domain, WebSocket hub, managed wrapper, observed ingest

Four workstreams landed. **Note on provenance:** the managed-wrapper and observed-ingest agents were killed by a process exit before they could report, so their work was verified by inspection and by running the gates — not from their own summaries. Everything below is what the tree actually demonstrates.

**Gates (orchestrator-run):** typecheck clean across 5 packages · **491 unit tests** (13 files → 38 files since auth; the no-database property still holds) · **252 integration tests** · Biome clean on 215 files.

### Session domain, queue and outbox

pg-boss behind `QueuePort` with a **second, deliberately separate job surface** — `session.launch` is a pg-boss job name, not an F6 event, and giving it the event API would have made that distinction unenforceable. The outbox emits on the caller's transaction and publishes the in-process relay only *after* commit, with ephemeral event types refused at both layers.

**The single-writer rule on `sessions.state` is enforced three ways**, not asserted: `SessionUpdate` is typed `Omit<…, 'state'>` so a state write is a compile error; `insertSession` writes the literal initial state and takes no state parameter; and a guard test scans every `src/**/*.ts` for a state-setting update outside `state-machine.ts`, carrying positive *and* negative control cases so the regex cannot quietly become vacuous.

Three defects found in its own work, all worth keeping: pg-boss relaxes a notify-enabled queue's poll to 30 s on the assumption that NOTIFY announces new work — but for `session.launch` the trigger is a *freed concurrency slot*, which nothing announces, so a queued launch could sit up to 30 s after capacity appeared; `offWork` waits for the in-flight handler, so shutting down with a launch parked on the semaphore hung shutdown forever; and the test harness's orphan sweep was dropping databases belonging to concurrently-running suites.

### WebSocket hub

Single multiplexed endpoint with cookie/bearer auth at upgrade and an **Origin allowlist that is tested end-to-end** — real login, real cookie, real socket, `Origin: https://evil.example` → 403 — because `SameSite=Lax` does not protect the upgrade handshake. The DB-sourced half of the allowlist can only *widen* it, so a failed settings read can never admit an untrusted origin.

It also found and fixed a genuine resource leak: `@fastify/websocket` only destroys the hijacked socket when *its own* hook has run, but the auth guard runs earlier by design, so a **rejected upgrade left a TCP connection open and `server.close()` waited on it forever** — one unauthenticated attempt hung graceful shutdown. Regression test named for the symptom.

Backpressure is two-tier: drop ephemeral deltas first (self-healing — the turn ends with a durable message the client renders from the API), then close with the new `4002` code if durable events back up, because a client that believes it is live while its state is stale is the one failure mode an operator console must not have.

### Managed wrapper and observed ingest

`@anthropic-ai/claude-agent-sdk@^0.3.228` installed and confined to a **single import site** (`managed/claude-agent-runtime.ts`), so an SDK change has one blast radius. Managed side: controller, normalizer with contract tests against real stream shapes, cost accumulation, retry/backoff, restart recovery. Observed side: hook-events endpoint, session binding, hooks installer, transcript tailer with a parse/degradation path, and tail-state persistence.

### Contract corrections applied

- **`services:health` was never a channel.** WS1 §2 named one; WS2 §14.3 — authoritative for channel naming — does not. Health rides `settings`. Corrected in WS1.
- **Close code `4002` (slow consumer)** adopted into WS2 §14.6 with its rationale, plus the malformed-frame vs refused-`ack` distinction (answering a refused `subscribe` with an `error` frame would leave the client's pending-request map waiting forever), Origin enforcement across both credential types, and the note that Phase 3/4 channels are subscribable and silent.
- **Resume from `failed` — a genuine cross-document contradiction.** WS2 §6.3 allowed resume only from `completed`/`archived`, while WS1 §4.4 marks restart-orphaned sessions `failed(backend_restart)` and offers one-click resume as *the* recovery path, and both WS4 §6.6 and WS5 §5.5 render `[Resume as new session]` on the `failed` composer. WS2 was the outlier; corrected, and the implementation updated with tests. **F7 is untouched** — resume-as-new does not transition the source Session, so which states permit it is an API policy question, not a state-machine one. Refusing `failed` would have made the restart-recovery story unimplementable, which is exactly how the contradiction surfaced.

## 2026-08-12 — Frontend: shell, auth, and the sessions screens

Mission Control is now operable in a browser. **750 unit tests** (still DB-free), **253 integration tests**, 315 files lint-clean.

**Foundation:** routing, API client with F5.4 envelope mapping, TanStack Query + three Zustand stores, the `SocketClient` (refcounted channels, equal-jitter backoff, dedupe, app-level ping/pong, and reconnect → **resubscribe-then-invalidate**, with the ordering asserted because the reverse leaves a window where the refetch completed but the subscription had not), login with deep-link preservation, and the shell with ConnectionChip and OpenSessionsStrip.

**The dead-socket rule is implemented once, centrally:** `socketStore` records `frozenAt` on the falling edge of `open` and `useLiveClock` stops advancing, so every duration freezes together and renders `~00:42:10`. Freezing at the leaf would guarantee some future component forgets. Finished durations never freeze — a completed session's duration is server truth about the past.

**Sessions screens:** list with F7 filters and cursor pagination; the live view with a virtualized transcript, streaming buffer rendered *outside* the measured set (it resizes every frame), composer × F7 state matrix, `[Stop]`, tool-call blocks, the four-tab right panel, and the launch modal with its working-tree disclosure. Two anti-blanking mechanisms were added that the contracts did not call for but the running app demanded: a settling hold so `commit` does not blank the turn for a round trip, and pending-prompt retirement only after the refetch lands, so the operator's own words never vanish.

Running it caught three defects unit tests did not: `Ctrl+K` crashed the shell because the palette's query key was structurally identical to the list's but held a different shape; the palette never merged its background fetch (imperative cache read inside a `useMemo`); and the detail view did not fill the viewport. All fixed with regression cover.

### Two backend bugs, both verified by hand rather than by report

**`POST /sessions/{id}/start` hung forever.** Root cause: when the runtime is unreachable the SDK iterator never yields `session_started`, and `ready()` awaited it with no bound — while interrupt and dispose already had timeouts. Now bounded (30 s default), failing the session with `spawn_error` and returning `503 RUNTIME_UNAVAILABLE`. **Verified live: HTTP 503 after 32 s with a proper envelope.** The slot leak I was worried about is covered twice — `launch()` releases in a `catch` on any throw, and a state-change listener releases whenever a session leaves `running`; `#release` is idempotent so they cannot double-release.

**Framework rejections were reported as server faults.** Found while reproducing the above: `POST …/start` with an empty JSON body answered `500 INTERNAL` while the underlying Fastify error carried `statusCode: 400`. The handler special-cased oversized bodies and schema validation, but every *other* 4xx framework rejection — empty body, malformed JSON, unsupported media type — fell through to the unclassified branch. That tells a caller "the server broke" about a request only they can fix, and it trips retry and alerting logic that should stay quiet. Generalised: any framework error carrying a 4xx now answers with that status and an F5.4 registry code, passing through the framework's message (which describes the malformed request and leaks no internals). 5xx and unknown still disclose nothing beyond the requestId. Verified live and covered by `http/error-handler.test.ts`.

Also fixed: the documented `pnpm auth:create-user --username <name>` failed with `Unknown argument: --` because pnpm forwards a bare separator into argv. Fixed in the parser rather than the script, so it works however it is invoked.

### Known gaps (specified, not yet built)

`/projects`, `/repositories`, `/services/health`, `/spend`, `/schedule`, `/notifications` all 404. The frontend deliberately ships **without** the spend chip and notification bell rather than rendering zeros from a 404 — and the launch modal cannot compose a session until `/projects` exists. Also unsourced: the working-tree disclosure needs the repository's current branch and dirty-file count, which no endpoint exposes (§5.4.1 mandates showing them); the UI treats "cannot verify" as a branch change and requires the acknowledgement.

## 2026-08-13 — Projects, repositories, and the four read models

The last Phase 1 endpoints. **861 unit tests** (still DB-free), **368 integration**, 366 files lint-clean.

**Projects and repositories** — full CRUD, plus `GET /repositories/{id}/status`, the working-tree read model WS5 §5.4.1 mandates but no endpoint exposed. One `execFile` (no shell, per F8), `--no-optional-locks` so the probe can never take `index.lock` and break a `git commit` the operator is running in another terminal, `GIT_TERMINAL_PROMPT=0` so it cannot block on credentials, and `LC_ALL=C` so the "not a repository" classification is not locale-dependent. The 10 s bound was **measured, not guessed** — `git status` on this repo runs 3.3 s cold, so a 5 s guess would have degraded the modal back to "cannot verify" on the first repository an operator registers. Nothing throws: missing path, not-a-directory, not-a-repo and git-unavailable are all 200 with an `unavailableReason`. Verified live against this repository: branch `DEV`, 27 uncommitted files, matching `git status --porcelain` exactly.

**Health, spend, schedule, notifications.** Spend's timezone handling was tested rather than asserted — `Pacific/Kiritimati` (UTC+14) for boundary placement, and DST pinned at fixed instants through a seam: `America/New_York` yields a **25-hour** day on 2026-11-01, a **23-hour** day on 2026-03-08, and a **721-hour** November, with a session inside the repeated 01:30 hour landing on the correct day. Health probes are bounded and never reject; a failed heartbeat *read* reports the workers `unknown` rather than `down`, because the broken dependency there is the database and blaming the worker would be a different lie.

### One product decision made at review: never-ran ≠ stopped

The agent implemented TDS 02 §7.2 verbatim — "down (older **or no row**)" — and flagged the consequence honestly: Phase 1 ships no workers, so a perfectly healthy install would show **two permanently red rows** in the Services panel and two standing entries in WS5's Needs Attention widget, forever, until Phase 2.

Changed. Heartbeat rows are upserted and persist, so the absence of a row means the worker has *never started*, which is not a failure; a worker that ran and went silent leaves a row behind that still ages through `degraded` into `down`. Never-reported now reads `disabled` — the same reading already given to Qdrant and Ollama, "specified, not deployed yet" — with `heartbeatStatus: 'never_reported'` in `meta`. A panel that always shows failures is one operators learn to ignore, which costs more than the fidelity it buys. Both the unit and integration tests now assert the distinction in both directions.

### Contract gaps found and handled

- **§5.1 had no way to create a Repository at all** — only discovery through a settings service that does not exist. Without it no Repository could exist in Phase 1 and the launch picker would be permanently empty. `POST`/`DELETE /repositories` added and marked as additions.
- **No `project.*` events and no `projects` WS channel**, so one tab's project change cannot invalidate another's. Escalated rather than invented — the F6 event vocabulary is not a single workstream's to extend.
- **`last_sync_error` had no API surface** despite WS3 justifying the column with "so the Repositories view can explain a `failed` badge"; added to the resource.
- **Frontend type drift**: `ServiceHealthRow.status` in the SPA declares `'ok'|'not_configured'|…` against the API's `'healthy'|'disabled'|…`, and lacks `label`/`meta`. Must be reconciled before the Settings → Services panel is wired.
- Health status *changes* are specified to ride the `settings` channel; not implemented, and deliberately so — WS5 §5.2 specifies 10 s polling because health must stay observable when the socket is the sick component.

### Dev-environment fix

The backend exited fatally on `EADDRINUSE`. Under `tsx watch` the outgoing process can hold the port for a moment, so one edit killed the dev server and every later edit re-ran the same doomed bind — visible in the browser only as `MALFORMED_RESPONSE`, because Vite proxies a dead upstream as an empty 500 that no client can parse as an F5.4 envelope. Now retried in development with explicit log lines, still fatal on the first failure in production, where a busy port means another instance is already serving.

## 2026-08-13 — Dashboard and Settings

**959 unit tests** (still DB-free), 420 files lint-clean, typecheck clean.

**Dashboard** — the eight §5.2 widgets in one DOM order that is simultaneously grid order, mobile stack order and screen-reader order. Needs Attention aggregates four sources (failed sessions in 24 h, unhealthy services, last `sync.failed`, budget breach) through a pure function taking `now` from the **frozen** live clock, so the 24 h window stops moving when the socket does. It excludes `disabled` services — Qdrant, Ollama and both Phase 2 workers — which would otherwise pin four permanent rows to the most-visited page on a correct install; the predicate lives in `lib/service-health.ts` so the widget and the Settings panel cannot disagree. Empty **and** all sources readable collapses to "All clear"; a source that *errored* names what it could not check rather than claiming all clear. Spend uses the server's `dayStatus` rather than re-deriving the threshold, so the widget, the top-bar chip and Settings cannot disagree about when the bar turns amber.

**Settings** — all seven categories, six integration cards, the write-only secret contract, and the dirty-state guard. `usePanelForm` publishes to a page-level registry and `guard.tsx` uses a **single** `useBlocker` predicate, because a category change *is* a route change — one rule covers the rail, the nav, the palette and browser back/forward, plus `beforeunload`. Test Connection reads only `summary.isDirty`, so the "paste a token, see ✓ Connected, navigate away, save nothing" hazard is structurally impossible. Untouched secrets are omitted from the request body entirely; `[Clear]` commits against the persisted baseline so unrelated pending edits cannot ride along.

### The bug that mattered most was invisible to every test

**`.inset-0` was never emitted anywhere in the application.** `theme.css` clears `--spacing` to close the arbitrary spacing ladder — deliberate and correct — but that also makes Tailwind resolve any numeric spacing utility outside the namespace to `calc(var(--spacing) * n)`, which is invalid and **silently dropped**. `Modal`'s `fixed inset-0` scrim therefore collapsed to its own content: **every dialog in the product** — confirms, Launch Session, the token reveal, the unsaved-changes guard — rendered wherever it happened to sit in the DOM, with buttons potentially off-screen and unclickable. Pre-existing, affecting the Sessions screens too, and found only by opening a browser. One line (`--spacing-0: 0px`), with the reasoning recorded so nobody deletes it as "obviously zero". The same silent drop applied to `p-0`, `gap-0` and `top-0`.

Two more found the same way: disabled `<select>`s displayed fabricated configuration (Timezone read `Africa/Abidjan` with nothing loaded, indistinguishable from a saved setting) — now an explicit `— not loaded` option; and a freshly-loaded panel opened *dirty* because the draft was seeded before the query resolved.

### Settings has no backend — this is the next task

`apps/backend` has a `settings/` module of internal typed readers but registers **no settings HTTP routes at all**, and WS2 §7.6's key registry does not exist. Missing: `GET/PUT /settings/{general,notifications,security}`, `GET /settings/integrations`, `PUT /settings/integrations/{six}`, `POST /settings/integrations/{x}/test-connection`, and `GET /audit-log-entries`. Every affected panel renders its real fields **disabled with an inline note naming the exact route** — no client-side store, no seeded defaults, nothing invented.

### Contract items raised

- **§7.1's `SecretFieldRead` is `{ isSet: boolean }`, but WS5 §4.4 makes `(saved ‹timestamp›)` the only honest confirmation possible for a write-only value.** The API must return `updatedAt`; the client degrades to a bare "(saved)" until it does.
- **§7.2 says "send only dirty fields", §7.3 says "full-category replace"** — mutually exclusive, and a partial body against a full replace erases untouched fields. Implemented as full replace; needs arbitrating.
- `Session.failureReason` was stored but never serialized, so both the Needs Attention row and the failure banner could only say "Session failed" without saying why. **Fixed** — added to the resource.
- `unknown` is a fifth `ServiceStatus` with no glyph specified in §5.7.12; both agents converged on `?` independently.
- `endpoints.settings.test` pointed at `…/test` rather than §7.4's `…/test-connection` — never called, so it would have 404'd on first use.

Also fixed en route: the shared fetch mock built `new Response('', {status: 204})`, which throws, so every mocked 204 surfaced as a network error.

## 2026-08-13 — GitHub integration and Projects: **Phase 1 complete**

**1355 unit tests** (still DB-free), **438 integration**, 493 files lint-clean.

### GitHub integration

**Discovery makes zero GitHub API calls.** "Is this a GitHub repository" is answered by the working tree's `origin` remote, which is where the answer actually lives — so discovery works before a token exists, cannot fail on a rate limit, and is fast enough to be synchronous. Verified live against the real `D:\Repos`: 15 working trees found, 5 registered, 10 skipped with reasons, correctly identifying `cento007/MCS` and classifying eight Azure DevOps remotes as `remote_not_github`. Re-running registered 0 and emitted 0 events.

**Rate limits never retry.** GitHub uses 403 *and* 429 for both primary and secondary limits, disambiguated by `x-ratelimit-remaining`. Sleeping would hold a pg-boss lease for up to an hour and retrying burns the secondary limit that exists to prevent exactly that — so the failure is recorded with the reset instant in `last_sync_error`, and a process-wide budget means a poll over 20 repositories discovers an exhausted window **once**, not 20 times.

**Token safety is tested adversarially**: all 13 failure kinds × 5 endpoints scanned across `JSON.stringify`, `String()` and deep inspection, including the two hostile cases — GitHub echoing the token back in an error body, and a transport error quoting a credentialed URL. A full-database scan (every text/jsonb column, pg-boss payloads, events, audit rows, API responses) found zero occurrences. A git remote can also carry an embedded credential, so `remote.ts` **rebuilds** the canonical URL from parsed coordinates rather than trimming — there is no "we forgot that form" case.

**Commit→session attribution declines when it cannot be sure**: five conditions including *exactly one* candidate session, no skew tolerance, committer date not author date (a rebase rewrites the latter), and `session_id` written once at insert so a later session cannot retroactively claim a commit. Author identity, working-directory containment and message trailers were all considered and rejected as non-evidence. The stated limit is honest: commits are polled from the default branch, so feature-branch sessions get no attribution rather than a wrong one.

### Projects screens

List and detail with the per-project workflow-mode override as a genuine three-way control (Manual / Assisted / inherit), naming the effective mode — and saying "not readable" rather than guessing when the global setting fails to load. Working-tree status renders **"cannot verify"** in amber for every `unavailableReason`, never as "clean", because it is a condition to weigh before launching rather than a missing optional field.

The agent dropped the wireframe's VISIBILITY / OPEN PRs / LAST COMMIT columns: nothing populates them before a first sync, and "0 open PRs" under a confident header makes a screen that looks synced and is not. It also found the sync/discovery endpoints had landed mid-flight and wired them for real rather than shipping the placeholder note.

### Accessibility bug found and fixed (orchestrator)

The session panel's tablist changed selection on arrow keys **without moving DOM focus**. Since `tabIndex` is derived from selection, the button under the user's focus became `tabIndex={-1}` while focus stayed on it — so the roving tabindex broke, the next `Tab` left the widget entirely, and the newly selected tab was unreachable from the keyboard. That is also how a phase-gated tab becomes unreachable *without ever being marked disabled*, which is precisely the affordance lie WS5's WC9 rule exists to prevent. Fixed, plus `Home`/`End`, with four regression tests asserting focus follows selection and exactly one tab stop survives.

### Contract items raised

- **§5.1's `202 { jobId }` is unresolvable** — the catalog defines no job resource, so a client has nothing to poll. Harmless for `/sync` (the outcome lands on the resource and the WS channel), actively lossy for `/discover`, whose skip reasons have no table to live in. Implemented as a synchronous report and flagged.
- **No read routes exist for the rows this now writes** — `GET /repositories/{id}/commits`, `/pull-requests` and friends are specified but unbuilt, so the Repository detail screen has no PR or commit source. This is the next backend gap.
- `repositories.last_polled_sha` structurally scopes commit tracking to the default branch, which is what limits attribution; widening it is a design change, not a code change.
- GitHub Enterprise is unrepresentable — the settings keys carry no API base URL. Correct for V1, recorded.

## 2026-08-13 — Phase 2 finalization: the five outstanding items

All five closed. Two agents were cut off mid-verification (one stopped by the user, one by a session limit), so their work was verified by running it rather than from their reports.

**A16 — one queue, one consuming process.** The event catalog listed both workers as consumers of a shared `events` queue. pg-boss is competing-consumer: subscribers to one queue *share* the work, so each envelope reaches exactly one of them and two workers silently take events from each other, with correct-looking logs on both sides. Ruled and recorded: the Backend produces (it needs an open transaction for row-and-job atomicity anyway), each worker consumes exactly one dedicated queue, and fan-out to browsers is `LISTEN/NOTIFY` — the only mechanism in the design with broadcast semantics. Not a Foundation change: F3 chose pg-boss behind a port and never specified consumer topology.

**A17 — Obsidian V1 scope.** PRD §7.2 lists four note types; V1 delivers two. **There is no Feature entity and no Requirements entity in F4.1**, so there is nothing to project — building them would mean inventing entities locally, which is exactly what workstreams escalate rather than do. Recorded with the precise boundary: ADRs export *and* import (six fields); Sessions export-only, terminal states only; notes without an `mcId` are invisible to sync entirely; deletions propagate in neither direction; and Mission Control never renames a note it wrote, because Obsidian rebuilds its `[[wikilink]]` index on rename.

**OpenAPI**, **body-field strictness** (closing the `removeAdditional` class that produced the token privilege-escalation and the silent no-op `PATCH`), and the **worker→WebSocket relay** all landed with tests.

### Obsidian conflict handling, verified against the report

The two things a green test run cannot show:

- **Nothing is overwritten before its loser is preserved.** The conflict copy is taken *before* the write and throws on failure, so there is no path that overwrites a version it did not first save. `mission_control_wins` leaves a `.conflict-<timestamp>.md` beside the note; `obsidian_wins` records the replaced fields in `audit_log_entries`; `manual` writes nothing on either side and stays a conflict every run until the operator acts. Detection is two content hashes, never timestamps — one for our projection, one for the file — because a single hash would report a change on every run forever, given the file legitimately contains operator-owned sections.
- **`newer_wins` ties break toward `mission_control_wins` for a measured reason:** on Windows a file written *before* a row update came back 2 ms *newer*. Inside the 2 s skew margin it picks the outcome whose loser survives in the operator's own vault rather than only in an audit row.

Atomic writes are temp-file-and-rename in the same directory, proven by a test that throws from an injected pre-rename hook and asserts the previous content is byte-identical and no temp file remains.

### Two more pre-existing bugs found

- **`isUniqueViolation` never returned true.** Drizzle 0.45 wraps query failures in its own error type with the PostgreSQL error on `cause`, so a top-level SQLSTATE check answered `false` for every violation — turning every duplicate into `500 INTERNAL` instead of `409 CONFLICT`, and silently disabling the `repositories.local_path` uniqueness guard. Now walks the cause chain, bounded.
- **The Sync Worker never provisioned the `events` queue.** pg-boss 10+ refuses to `send` to a queue that does not exist, so on a fresh install whose worker started before the Backend, every event it emitted failed and no sync could complete. Caught by an integration test. Note the distinction it drew: *provisioning* (`createQueue`) is required to produce; *subscribing* (`work()`) is the hazard A16 forbids.

### Integration tier: worker cap lowered 8 → 4

Three tests failed at eight workers with single files taking 279 s and 331 s; the same state-machine file passes 32/32 alone in 40 s. Connections were never the constraint (`pg_stat_activity` showed 6 against a limit of 100) — **argon2id is**: deliberately memory-hard at 19 MiB, paid by every seeded user and every login, so eight forks hashing concurrently starve each other and push unrelated tests in the same fork past the 30 s timeout. The symptom is indistinguishable from a real bug, which is why the reasoning is pinned in the config. Four trades wall-clock for a tier where red means broken code rather than a busy machine.

### Remaining before implementation

- Two open WS2 leaf contracts (spend aggregate, session Files) — needed by the Dashboard and session-detail sprints, not by Phase 1 foundation work.
- Scaffolding: generate the pnpm monorepo, then replace the "no build/lint/test commands yet" line in `CLAUDE.md` with the real ones.

## 2026-08-13 — Settings backend: the key registry, the routes, Test Connection, the audit log

**1089 unit tests** (still DB-free) and **402 integration tests**, lint and typecheck clean. The Settings panels that rendered disabled behind "route not served yet" notes now have their routes.

**The key registry landed first, and everything else derives from it.** `packages/shared/src/settings/registry.ts` (WS2 §7.6) declares every settable field once: its API path, its `(category, key)`, its `value_type`, its **default**, its JSON Schema, whether it is a secret, and a `normalize` that repairs an untrusted stored row. Storage coordinates are *derived from the path* by one function, so an entry whose DB key disagrees with its API path cannot be written. The five pre-existing typed readers (`general.ts`, `claude-code.ts`, `integrations.ts`, `notifications.ts`, `security.ts`) now source their defaults and keys from it rather than declaring their own — that was the actual drift risk, since `main.ts` reads `maxConcurrentSessions` before the HTTP server exists and the Settings page writes it.

Defaults are **applied at read time, never seeded**: a fresh install has zero rows and still serves a complete, correct document, which is what lets the panels show the truth on first boot instead of a form full of blanks that look like configuration.

**Two contract contradictions arbitrated** (`docs/tds/00-overview.md` §5):

- **A14 — full-category replace wins** over TDS 05 §7.2's "send only dirty fields". A partial body against a full replace silently erases untouched fields. An omitted non-secret field resets to its default; an omitted *secret* is kept (a client forbidden to read a secret cannot resend one); `null` clears it. An unknown field is rejected **by name**, because Fastify's Ajv would otherwise strip it under `removeAdditional: true` — and a stripped field, under full-replace, is a silent reset of the field the caller meant to set. That is why the write schemas deliberately omit `additionalProperties: false`.
- **A15 — `SecretFieldRead` gains `updatedAt`**. WS5 §4.4 is right that `(saved ‹timestamp›)` is the only honest confirmation a write-only value can give; `{ isSet }` alone cannot distinguish "saved" from "silently failed to save".

**Secrets.** Sealed with AES-256-GCM into `secret_items`, AAD bound to `"{category}/{key}"`, `key_version` 1. The read path cannot decrypt — it reads presence and `updated_at` and nothing else. The only unseal in the Backend is Test Connection's. A row this process cannot decrypt is reported as a **failed check with a specific message** ("sealed with a different `MC_ENCRYPTION_KEY` … re-enter the value"), not a 500: the integration is configured, this process simply cannot read the credential, and a generic error sends the operator looking in the wrong place. Proved live by restarting the backend with a rotated key.

**Test Connection is bounded everywhere.** Network 5 s, filesystem 2 s, CLI 10 s, each enforced *in this process* rather than trusting the transport — a stub that ignores an `AbortSignal` still cannot hang a request, which is what the unit tests assert. GitHub does an identity call and reports the token's scopes; Telegram does `getMe` and **says in words that it sent no message**; Obsidian stats the vault without writing to it; Claude Code runs `--version` through `execFile` with no shell, falling back to PATH when `cliPath` is unset (`''` is the documented "use the SDK's binary", so refusing to test would be refusing a question that has an answer). Qdrant and Ollama answer `INTEGRATION_NOT_CONFIGURED` naming Phase 3 — an honest "not yet" rather than a fabricated pass. Every failure is a `200` with `ok: false`.

**Telegram's token travels in the URL**, so every message built from a transport error passes through a redactor before it can reach a result, a log line or an audit row — the test suite asserts the plaintext is absent from the serialized output rather than trusting the code path.

**Audit and events.** Each write emits `setting.updated` (DB keys only, never values) and writes audit rows in the *same* transaction as the change — `setting.updated` for the values, one `secret_item.updated` per secret with `before`/`after` of `{ set: true|false }` per TDS 03 §3.13. A save that changes nothing writes nothing and emits nothing. `GET /api/v1/audit-log-entries` is the "View audit log →" target, cursor-paginated on `(createdAt, id)` — a shared millisecond is the *normal* case here, since one settings save writes several rows in one transaction.

### Found and fixed en route

- The integration harness dropped `testConnectionDeps`, so the first run of the settings integration suite quietly made real HTTPS requests to `api.github.com`. Forwarded — a suite that reaches the network is a suite that fails on a train.

### Contract problems raised

- **An unknown *query parameter* is silently dropped** on every list route (Fastify's `removeAdditional: true`), so `?actor=` reads as no filter and returns more rows than asked for. Known-filter *values* are validated strictly (`?from=lastTuesday` is a 400, never "everything"), and the fix for unknown keys belongs in one place for all routes rather than in the audit route.
- **The Telegram card's note says Test Connection "sends a test message to the chat"; it does not.** Frontend copy change needed (`TelegramCard.tsx`), or a decision to send one.
- `apps/frontend/src/features/settings/types.ts` was written as a provisional copy "deleted when the registry lands". It has landed and the shapes match; the panels can import from `@mc/shared/types` now.

---

## 2026-08-13 — Phase 3 memory foundation: the two ports, their fakes, and the embedding stamp

**1906 unit tests** (still DB-free, and now also network-free — no Qdrant, no Ollama) and **720 integration tests**, lint, typecheck and `pnpm build` clean. Foundation only: the ports, adapters, schema and provisioning that ingestion and retrieval will sit on. No ingestion pipeline, no search API, no Memory UI.

**The whole design turns on one failure mode.** Vectors are only comparable within one embedding model. Change the configured model, or its dimension, and every stored vector becomes noise relative to every new one — and the failure is *silent*, because cosine distance is a total order over whatever numbers it is given, so a query against mismatched vectors does not error. It returns a ranked list of confident nonsense, and an operator cannot tell that answer from a good one. That is worse than a crash: a crash is found in seconds by whoever caused it.

So the stamp — model + dimension — is carried in three deliberately redundant places, each catching a different mistake: **Qdrant collection metadata** (`config.metadata`, the authoritative model name), **`config.params.vectors.size`** (which Qdrant enforces itself on every request and which survives even on a server too old to store metadata), and **per `memory_items` row** (so a partial re-index has a work list and a straggler is identifiable). A disagreement **throws** — `EmbeddingStampMismatchError`, naming both values and the two ways out — everywhere except the health probe, which catches it and renders the reddest row on the page. That is the one deliberate inversion of this codebase's "a broken dependency is data" rule, and the reason is exactly why the rule exists elsewhere: Qdrant being down is something an operator can see, and a mismatched index is not.

**`EmbeddingPort` is batch-shaped** (`embed(texts) -> vectors`) because measurement, not taste, says so: against the real Ollama, 32 chunks cost 1009 ms one request each and 210 ms batched — 31.5 vs 6.6 ms/chunk. A per-text signature would make the slow shape the default and the fast one something to remember, so the port does not offer it.

**`VectorStorePort`'s filter is a closed shape**, not Qdrant's DSL passed through. The reason is the fake: a fake that accepts arbitrary Qdrant JSON and honours a subset of it is worse than none, because every test it passes is evidence about the subset. `MemoryFilter` is small, total and implemented identically by both stores, so a retrieval test written against the in-memory fake means something in production — confirmed live, where Qdrant's own cosine matched the fake's arithmetic to four decimal places.

**Both fakes are what the unit tier runs on.** The embedder is deterministic (signed trigram feature-hashing, unit length, no clock, no randomness); the store computes real exhaustive cosine and applies the same shared filter predicate the Qdrant adapter's translation is checked against. `pnpm test` stays green on a clean checkout with nothing installed, and the integration harness installs a *denying* transport for both services by default — a developer machine with a local Qdrant would otherwise pass here and fail on CI.

### Measured against the real services, not assumed

Ollama 0.32.9 + `nomic-embed-text`, Qdrant 1.19.0 (native Windows binary — no Docker):

- **A chat model handed to `/api/embed` fails *slowly*: `501` after 28.6 seconds**, having loaded the full 8B model first, with an error blaming a server flag that has nothing to do with the operator's actual problem. So the adapter gates on `POST /api/show`, which reports `capabilities` from the manifest without loading weights: `nomic-embed-text -> ["embedding"]`, `deepseek-r1:8b -> ["tools","thinking","completion"]`. Live, the same rejection now takes **16 ms** and says `ollama pull nomic-embed-text`.
- **`model_info.<family>.embedding_length` is not a capability signal** — `deepseek-r1:8b` reports `qwen3.embedding_length: 4096`, which is its hidden size. Only `capabilities` distinguishes them, which is why the dimension the collection is stamped with is **measured** from a real probe vector rather than read off a manifest.
- **The two Ollama embedding endpoints return differently-scaled vectors**: `/api/embed` L2-normalized (norm 1.000000), the legacy `/api/embeddings` raw (norm ≈ 4.9 for the same text and model). Cosine ranking would survive the difference; "the same text embeds to the same numbers" should not depend on which endpoint answered, so the adapter normalizes on the way out.
- **Qdrant silently ignores unknown fields in a create body**, so a server too old to store collection metadata answers `200 {"result":true}` and stores nothing. The adapter therefore reads the stamp back rather than trusting the write, and reports `stampPersisted: false` when it did not stick.
- **`POST /api/embed` vs an unknown route are both 404s** — the former JSON (`model "x" not found`), the latter plain text (`404 page not found`). Only the plain-text form justifies falling back to the legacy endpoint, or one clear "pull the model" would become N slow retries.

### `memory_items` graduated from skeleton to table (migration `0004`)

Tier and scope, provenance (row id *or* vault-relative ref, never both), the chunk text or a pointer to it, its `sha256`, the model and dimension that produced it, and the Qdrant point id. `ck_memory_items_tier_scope` makes a project-tier row with no project unrepresentable — that row is storable without it, invisible to every project-scoped query, and reported missing by nothing. Two partial unique indexes key on `(source, chunk, embedding_model)`, so a re-index is idempotent *and* a second model's rows coexist with the first's, which is what lets the old vectors keep answering while the new set is built. `agent` stays in the tier CHECK with no producer until Phase 4.

### Contract problems raised

- **`memory_items.qdrant_point_id` names a driver in a schema whose store is behind a port.** Kept verbatim because TDS 03 §6 names it and inventing a parallel name is what F9.5 forbids, but it is a vocabulary debt to settle if a second driver ever appears.
- **Ollama silently truncates over-long input.** A 108 000-character string returned a 200 and a normal 768-dimensional vector against a 2048-token context — no warning, no error, and a vector representing only the first fraction of the text. Chunking must bound input by tokens; the ingestion follow-up cannot rely on the runtime complaining.
- **Test Connection still answers `INTEGRATION_NOT_CONFIGURED` for Qdrant and Ollama**, and `VectorCards.tsx` still tells the operator that "semantic memory arrives in Phase 3" and that nothing is indexed. Both are now understatements: the clients exist and the health rows are real. Deliberately left — Test Connection was not in this task's scope — but the copy and the two executors should land together.
- **`TDS 04 §7.5`'s Services table lists Qdrant/Ollama as "Phase 3+ placeholder".** That row is now real; the TDS text is stale.

---

## 2026-08-13 — Phase 3: ingestion, retrieval, and a relevance floor that was measured

**2012 unit tests, 754 integration**, lint and typecheck clean. Qdrant left at 0 collections. The pipeline that fills the index and the route that queries it, on top of the previous section's ports and stamp.

**The relevance floor is the substance of this work.** Cosine similarity always returns something: an unfiltered top-5 over an unrelated corpus is five confident irrelevancies, and the operator cannot tell them from five good answers. So retrieval has a floor, and an empty result is a first-class answer carrying a **reason** rather than an empty array the client must interpret.

The floor was **measured, not guessed**, over 758 chunks of this repository's own documentation. On-topic queries bottom out at **0.552**; off-topic ones top out at **0.509** — *"What is the best recipe for sourdough bread?"* scores 0.509, *"Which football team won the league in 1997?"* 0.472. The usable gap is **0.043 wide**. The first guess of 0.45 sat *below* the off-topic ceiling and returned five confident irrelevancies for the bread query. `DEFAULT_MIN_SCORE = 0.52` sits inside the band, and a regression test pins it there against both edges — a future edit that drifts the floor out of the band silently restores the failure, and nothing else would catch it.

**Chunking is bounded by tokens because the runtime will not complain.** The previous section's finding — Ollama silently truncating a 108 000-character input to a normal-looking 768-dimensional vector — is what shapes the budget, derived from the model's declared context window rather than a constant.

**Settings stopped lying.** The Qdrant and Ollama Test Connection executors are real (reachability *and* stamp agreement), and the copy telling the operator that "semantic memory arrives in Phase 3" is gone — it had become an understatement rather than a promise.

---

## 2026-08-13 — The Memory screen, session export, and context packages

**2159 unit tests, 775 integration**, lint and typecheck clean across 699 files. Databases and Qdrant left as found. Commit `ad9cc51`.

### Four empty screens, because they mean four different things

The backend distinguishes not-configured, nothing-indexed, nothing-above-the-floor and index-cannot-be-trusted. Rendering all four as "No results" would be actively misleading, because in three of them the operator's next action is completely different — and it would throw away the entire point of the previous section's floor and stamp work. Each state gets its own words, its own affordance and its own ARIA role:

- **`not_configured`** — a link to Settings, and *no* backfill button, because there is nothing to backfill into. Shown before a query is typed, not after one fails.
- **`index_empty`** — offers a backfill, and says plainly that **rephrasing will not help**, since there is nothing to match against.
- **`below_threshold`** — the one empty answer where rephrasing *does* help, and the only one offering "show the closest matches anyway" (`floor=0`).
- **`stamp_mismatch` / `unavailable`** — `role="alert"`, not a quiet empty list. The mismatch screen says the index **cannot be trusted** and offers a rebuild; the unavailable one says *"this is not an empty result — nothing was searched."*

A live run exposed one contradiction between panels: the index panel showed a green "Indexed with nomic-embed-text" directly above the red refusal. Both statements were true and the pair was incoherent — the rows are real, but the *vectors* are the index. It now reads "rows stored, none queryable".

### Scores are cosine, and are not dressed up as confidence

Raw cosine to two decimals, never a percentage. "65% match" claims a probability cosine does not carry, and rescaling 0–1 onto 0–100% puts every honest answer this system can produce between 52 and 66 — a bar permanently two-thirds full. Three decimals were rejected for the opposite reason: with 0.043 of total separation, a 0.001 gap invites a comparison the embedding cannot support. A floor-relative meter carries the discrimination instead, with a **stated unit** (floor → best observed on-topic score, captioned `0.52–0.66`), and rank leads each card as the one compressed-list property that is unambiguously meaningful.

### Session export omits things and says so

Markdown only. The specified `format: 'json'` was **narrowed to one value** rather than accepted and answered with Markdown: `GET /sessions/{id}` and `/messages` are already the canonical paginated JSON, nothing in V1 imports a session, and a second JSON shape would exist only to drift out of agreement with the first.

**Tool inputs and outputs are excluded, with counts stated in the document.** They are the two unbounded columns — a `Write` input is a whole file, an image arrives base64-inlined — and the only place a credential from a shell command could reach a document designed to leave the machine. The one thing read out of `tool_payload` is `isError`, projected to a boolean in SQL. Proven rather than asserted: an integration test seeds `AWS_SESSION_TOKEN=canary-value-that-must-not-be-exported` into real JSONB and scans both documents for it.

Three format hazards are handled and **announced in the document**: control characters escaped as `<U+001B>` rather than stripped (ANSI from terminal captures is routine), unterminated code fences closed with a note saying the exporter closed them, and prompts block-quoted so stray fences and `---` are inert by construction.

### Context packages justify every inclusion, and never invent

Nine sections, each tested against *"would someone resuming abandoned work be worse off without it?"* rather than "is this true". Notably the **working tree as of now** — the only fact not in the transcript at all, and the one that decides whether resuming is safe, stamped "true at that instant and no longer". Prompts use a first-3 + last-9 window rather than a blind head, because original intent and current thread are different things, and the middle is counted rather than hidden. ADRs are **pointers, not copies**: an ADR is a live two-way-synced document and a paste would be a second version.

Deliberately absent: a summary and next steps. There is no model in this request path, and inventing either is exactly what the ADR generator refuses to do with "Alternatives considered". Degraded memory is never silently omitted — eight named reasons, each a warning callout with an actionable sentence, plus a machine-readable `relatedContext.gapReason` so the UI never has to parse the prose.

### A Phase 3 bug the UI work surfaced

**`MemoryRuntime.invalidate()` was never called.** `runtime.ts` documented that a `setting.updated` naming qdrant or ollama "is how changing the embedding model takes effect without a restart, and how it is *caught* without a restart" — and no module subscribed. `invalidate()` appeared only in failure paths.

The consequence is the exact scenario the stamp exists to refuse, in its most silent form: an operator who changes the embedding model in Settings keeps being served ten confident results retrieved from the collection the **previous** model built, and `stamp_mismatch` is unreachable until the process restarts. Demonstrated by tampering a collection's stamp against a running backend, then restarting to see the same query correctly refuse.

Fixed by subscribing in `registerMemory` — at registration rather than in `start()`, since dropping a cached object does no I/O while the routes it protects go live immediately, and the integration tier builds an app per test without ever calling `start()`. The regression test was verified to **fail against the old code** before being accepted.

*Correction recorded:* the fix's `changedKeys` branch was initially justified as covering a full-category `PUT /settings/integrations`. That route does not exist — `integrations` is deliberately excluded from `DOCUMENT_CATEGORIES` because it is written one integration at a time. The branch is kept as defence in depth and is now labelled as such in both the code and its tests, and the same slug-only check in the GitHub module is correct as written rather than the parallel bug it briefly appeared to be.

### Contract problems raised

- **`GET /memory-items/backfill` cannot distinguish "not configured" from "configured but never indexed."** Both answer `indexedModels: []` with an all-null run, yet the operator's next action differs completely. Worked around by projecting `GET /services/health`; the natural home is a `configured` boolean on the backfill document (task #28).
- **A check/unique violation on sync-run insert surfaces as an opaque `500 INTERNAL`.** Found because the dev database was one migration behind (`0005_memory_index_runs`, since applied) and `ck_sync_runs_kind` rejected the insert. Same class as the earlier `isUniqueViolation` fix — Drizzle puts the pg error on `cause` (task #30).
- **Export and Generate Context Package are served but unreachable from the SPA** — `overflowActions()` still omits them with a comment saying the backend does not serve them (task #29).
- `TDS 04 §6.7`'s `format` enum and its `MC_DATA_DIR/exports` note are both now inaccurate; `openapi.yaml` records the narrowing. No file is written to disk — §6.7 returns the document in the response, no route reads such a file back, and nothing would delete one.

---

## 2026-08-13 — Two backend answers that were being thrown away (tasks #28 and #30)

Backend only. Both items closed here were raised as contract problems by the previous section.

### `GET /memory-items/backfill` can say which of four situations it is in (task #28 ✓)

The document was all-`null` for **two** situations that share nothing — no embedding model configured, and one configured with nothing ever indexed — and the fix for each is a different button. The fact was already in hand and discarded: `status()` was awaiting `runtime.ready()` for `currentModel` and using nothing else from it. It now also reports `configured`, `runtime` and `runtimeReason`, for no extra I/O.

**A bare `configured` boolean was rejected, deliberately.** The runtime has four arms and three of them are "configured": *Ollama is down* (`unavailable`) and *the index cannot be trusted* (`stamp_mismatch`) are two further distinct operator actions, and neither is a trip to Settings. Sending someone whose Ollama is stopped to re-enter a model that is already correct is the failure a boolean would have shipped. `configured` still exists and means exactly one thing — `runtime !== 'not_configured'` — so the screen never has to derive it twice. The four words are `MemoryRuntimeState['kind']` verbatim, which is the same vocabulary `POST /memory-items/search` already answers with in `emptyReason`.

This retires the Memory screen's second round trip to `GET /services/health` for `meta.configured`. Recorded in TDS 04 §13.1, which had reserved these routes with "no payload detail"; `openapi.yaml` is unchanged because it carries request shapes only (every operation is still `x-mc-response-schema: undeclared`).

### A `CHECK` violation on a sync-run insert names the command that fixes it (task #30 ✓)

`23514` from `ck_sync_runs_kind` — the shape of the original report, a database that never applied `0005_memory_index_runs` — was an opaque `500 INTERNAL`. It is now `500 DATABASE_SCHEMA_MISMATCH` naming the constraint, the rejected value and `pnpm db:migrate`.

**Why 500 and not 409.** A 409 promises the caller that changing something and retrying will work, and on both routes that insert a run a 409 already means one specific thing — *a run is already active*, decided by `ux_sync_runs_active`. Overloading it would make two situations with opposite remedies indistinguishable. The request was valid; the database is wrong; that is a server fault.

**Why its own code and not `INTERNAL`.** `INTERNAL` is defined as "unhandled, disclose nothing", and concretely the SPA maps it to the fixed string *"Mission Control hit an unexpected error."* — so under `INTERNAL` the actionable sentence would have been written and then discarded by the only client that reads it. An unrecognised code falls through to the server's own message, so a new registry entry is what makes the message reach the operator. `503` was rejected because it promises that waiting helps.

**The message stops short of asserting a missing migration**, because that cannot be known from the error. What is stated is what is known: the value is a compile-time constant of this build, not anything the request supplied, so the schema and the code disagree — with a pending migration named as the usual cause.

**Scoped, not blanket.** Only `ck_sync_runs_kind` is translated; a violation of `ck_sync_runs_state` or `ck_sync_runs_trigger` still surfaces as `INTERNAL`, and a test proves it by narrowing the trigger CHECK and asserting the generic answer. Translating every `23514` would paper over a genuinely bad value with confident, wrong advice.

The predicates moved to `apps/backend/src/db/violations.ts` so the one non-obvious fact behind them — **Drizzle 0.45 puts the `pg` error on `cause`**, the fact that once made `isUniqueViolation` always return `false` — is learned in a single place. Re-verified against a real database before the code was written: `DrizzleQueryError` → `cause` → `DatabaseError { code: '23514', constraint: 'ck_sync_runs_kind', table: 'sync_runs' }`.

Both fixes are covered by integration tests that alter the constraint on real PostgreSQL rather than mocking an error, and each was **verified to fail against the old code** before being accepted.

---

## 2026-08-13 — Phase 3 closes: repository documentation, and a Memory settings category that is obeyed

**2287 unit tests, 808 integration** (including the two live-service tests against real Qdrant and Ollama), lint and typecheck clean, `openapi.yaml` regenerated, no migration needed. Commit `7e38ede`.

### A source that existed only as a type

`document` — PRD §6.3's "Documentation" — was declared in `MEMORY_SOURCE_TYPES`, classed as path-addressed in `REFERENCE_MEMORY_SOURCE_TYPES`, given a label and a link case in the Memory screen, and offered as a filter chip. `grep` found it in **exactly two type declarations**. Nothing produced it, so the screen shipped a filter that could only ever return nothing — the precise dishonesty `PRODUCIBLE_MEMORY_TIERS` exists to prevent for the `agent` tier. There was already circumstantial evidence of the need: an earlier agent, wanting a corpus to measure against, pointed the *Obsidian vault path* at `D:\Repos\MCS\docs`.

**What counts as documentation** is deliberately a floor rather than a ceiling: root-level Markdown, plus anything beneath a root-level `docs/`, `doc/` or `documentation/`. The walk never descends into any other root-level directory, so a 40 000-file `node_modules` costs one `readdir` of the root — and the same `NEVER_DESCEND` denylist applies at every depth, because `docs/node_modules` is a real thing. Source-adjacent Markdown is the natural widening and belongs behind an explicit setting, not behind a default that triples the corpus.

**Where the vault and a repository overlap, the vault wins.** The vault path is something the operator *declared*; the documentation set is *derived* from repository rows, and a derived rule should yield to a declared one. Reversing it would also make the note stage depend on the `repositories` table, so "index my vault" would come to depend on GitHub discovery having run.

**Tier is `project`**, which `ck_memory_items_tier_scope` describes exactly — and the corollary is enforced upstream: a repository with no Project is not indexed at all, because its scope is *undecided*, not global. One repository's deployment guide answering every other project's questions is the failure that rule prevents.

**"The scan did not see it" is not "it is gone."** A repository whose local path is absent from this machine is skipped and its documents are **not** purged. What *is* purged is a deleted repository row and one that lost its Project — both facts this database holds, rather than guesses about a filesystem.

*Correction accepted from the implementer:* the brief framed the file-size and extension bounds as the guard against Ollama's silent truncation. They are not — that guard is `ChunkBudget` in `chunk.ts`, which every source already passes through. The new bounds are run-cost and index-quality bounds and are documented as such. A comment claiming a guarantee that lives in another module is how the next person stops looking for the real one.

### A settings category that is actually read

`memory` routed `GET`/`PUT /settings/memory` and defined **zero registry keys**. PRD §4.4 item 4 wants retention per tier and indexed-source toggles; PRD §6.1 calls session memory "temporary", which nothing made true — session-tier chunks accumulated forever.

The rule applied throughout: **a setting nothing reads is a lie**, and this codebase keeps paying for it (`integrations.ollama.enabled` is still read by nothing; the Telegram chat-id double-parse silently skipped every notification).

- **`indexedSources` gates both ends.** A disabled source stops being indexed *and* is intersected out of the search filter before the query runs. Its rows are **kept**: a settings save must not be a destructive action, re-enabling then costs nothing, and the irreversible path stays explicit and typed (`backfill {"mode":"rebuild"}`). Leaving rows queryable while the toggle read "off" would have been the lie; this closes it from the other side.
- **`retentionDays` is enforced** by a self-rescheduling `memory.retention` job modelled on `github.poll`, deleting rows and Qdrant points together and **only inside a `ready` runtime** — if Ollama or Qdrant is unreachable it deletes nothing, because a row removed without its vector strands an index answering from a chunk that no longer exists. Cutoff is `created_at`: `indexed_at` would mean a weekly-edited document never expires under a 30-day policy, and the source's own timestamp would make a first backfill delete most of what it had just embedded. Default `0` = never, so loss is opt-in.

Deliberately not added, each stated as a decision rather than an omission: no `agent`-tier window (nothing produces those rows), no `minScore`/chunk-size knobs (one is a per-request field with a measured default, the other is derived from the model's context window), no retention tick-interval setting (nobody can set it correctly), and no "purge on disable" — two ways to destroy data is one too many.

### A rebuild that reported success and answered nothing

`MemoryIndexService.#rebuild()` reset the collection, then deleted only *other* models' rows. Under an **unchanged** model that deleted nothing, so the sweep that followed found every row hash-matching with `indexed_at` set and skipped all of them: the run reported success with a full `memory_items` table beside an empty collection. It was correct only when a rebuild happened to follow a model change — and `{"mode":"rebuild"}` is reachable without one. Verified failing against the old code before the fix was accepted.

### Found by reading the built CSS rather than the class names

`max-h-80` and `w-20` in the command palette emitted nothing, because `theme.css` deliberately closes Tailwind's arbitrary spacing ladder. The results listbox therefore had `overflow-y-auto` with **no height to overflow** — no scroll cap at all, so the list ran off-screen once enough sessions matched. Same failure as the `.inset-0` incident and as the `min-w-56` overflow menus found in the same sweep. The curated set is `0, 05, 1, 2, 3, 4, 6, 8, 16`; anything else needs a `--mc-*` constant, and the check that matters is `grep` over `dist/assets/*.css`, not over the source.

### Contract corrected mid-flight

The shape handed to the frontend agent was wrong in a way that mattered: `retention` with `null` meaning "never expire". What landed is `retentionDays` as `integer, minimum: 0` where **`0` means never** — so under the briefed contract a `null` would have been a 400 and a `0` would have meant *expire everything now*, on a field that destroys data irreversibly. The panel reads both dialects and writes back the one it received.

### Outstanding

- **`SpendChip` can evict the whole app.** It reads `data.budget.alertsEnabled` guarding only `data === undefined`, and the only error boundary sits on the `RequireAuth` *parent* of `AppShell` — so one malformed `/spend` body replaces the entire authenticated area, navigation included. Only reachable with a bad payload today, but `lib/api/types.ts` is hand-written against prose because `openapi.yaml` declares no response schemas, so a field rename would do it.
- `GET /schedule` has no `memory_retention` row, so the retention chain is invisible in Settings → Services.
- The nav and Settings rails still badge Memory `P3`, which now has both a screen and a panel.
- **Graphify** (PRD §6.2.1) remains untouched and explicitly optional: its adoption path begins "trial as a per-repository Claude Code skill first; if proven, integrate". That is a judgement to form by hand, not an assumption to implement.

---

## 2026-08-13 — One bad field could evict the whole app

Commit `92cc3e4`. **2310 unit tests**, lint, typecheck and build clean.

The only error boundary in the route table sits on the `RequireAuth` element — the **parent** of `AppShell`. So a render failure in any shell widget replaced the entire authenticated area with "Something broke on this page", *including the navigation that would have let the operator go somewhere else*. The only recovery was a reload onto the same broken route. `RouteErrorBoundary`'s own comment calls it "deliberately the last line rather than the first"; there was no first line.

`SpendChip` could trigger it: `data.budget.alertsEnabled`, guarded only against `data === undefined`. **This is not paranoia about a Backend that is currently correct.** `lib/api/types.ts` is hand-written against the prose contract, because `openapi.yaml` declares no response schemas — so nothing checks that the shape arriving at runtime is the shape the component compiled against. A renamed field takes the app.

Fixed at two layers, deliberately different in kind:

- **`readSpendChip` handles what it can anticipate.** A body it cannot read returns `null` — hidden, which is this chip's *own documented rule* for such a body ("Not loaded / failed to load → hidden. A chip is a glance affordance with no room for an error state, and the Dashboard widget already reports a failed `GET /spend` properly"). The one falsy-looking value that must survive is `dailyUsd: null`, the real `no_budget` case, which renders.
- **`ShellBoundary` catches what nobody anticipated.** One per widget, so they fail independently — and one per chip rather than one around the pair, because the ConnectionChip is how an operator distinguishes "the server is down" from "this screen is wrong", which is the question a broken shell makes urgent. In `NavRail` the boundaries sit *inside*, around the running count and the open-sessions strip: the links above are the escape hatch and are built from a static table, so wrapping the whole `<nav>` would let a failing counter take navigation away.

**The fallback is never `null`, and that is the design.** `SpendChip` has three deliberate reasons to render nothing. A crashed widget that also rendered nothing would make a defect indistinguishable from "the operator turned cost alerts off" — the same mistake the Memory screen's four empty states exist to prevent, reproduced in one corner of the top bar. It renders a marker that cannot be read as data, and deliberately not `—`, which already means "no value" here (`RunningCount` on a failed `GET /sessions`, `TopBar` on an unknown username). It also deliberately does **not** claim `role="status"`: the ConnectionChip owns that role, and a second live region would make `getByRole('status')` ambiguous precisely when something is already broken.

### Both claims were verified against the old behaviour

The first attempt at the guard's regression test was **not good enough and was rewritten**. Rendered bare, the old code threw and the run reported "1 error" while the test itself said *passed* — a signal that would mean nothing to whoever breaks this next. Asserted through a real `ShellBoundary` instead, it fails cleanly: the throw is caught and the ⚠ fallback appears on a condition the chip is supposed to handle silently.

`TopBar.resilience.test.tsx` exists for a separate reason: `ShellBoundary.test.tsx` proves the boundary contains a throw, and nothing there proved the boundary was actually *wrapped around anything*. Removing the `<ShellBoundary>` from `TopBar` left every other suite in the directory green. All three of its tests fail with the boundary removed — the same gap that file's own header warns about for chips ("a chip with a perfect unit suite and no call site").

The fallback's utilities were checked against the **built CSS** rather than the class names, per the `.inset-0` lesson.
