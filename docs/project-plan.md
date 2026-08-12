# Mission Control — TDS Project Plan

- **Deliverable:** Technical Design Specification (TDS)
- **Source of truth:** `Requirements.md` (PRD v2.1 — includes §4.4 Settings Management and §8.6 Settings page); constraints in `CLAUDE.md`
- **Execution model:** Multiple specialist AI agents working in parallel, coordinated by an orchestrator
- **Output location:** `docs/tds/` (one file per workstream, merged under a single overview)
- **Date:** 2026-08-11

---

## 1. TDS Scope

Per the PRD (§ Next Steps), the TDS must contain:

1. Database schemas
2. API contracts
3. Deployment architecture (native, no Docker; Ubuntu prod / Windows 11 dev)
4. Service boundaries
5. Event models
6. Wireframes

**Global scope guard:** The TDS designs the *full* system architecture (all phases must fit the skeleton), but only **Phase 1 (Foundation)** and **Phase 2 (Knowledge)** are specified in implementation-ready depth. Phases 3–5 (Memory/Qdrant, Agents, Multi-runtime) get *interfaces, placeholders, and extension points only* — no detailed schemas, endpoints, or wireframes. Every workstream section below repeats this rule with its own specifics. Any agent that finds itself writing Phase 3–5 detail beyond an interface stub is out of scope and must stop.

---

## 2. Foundation Workstream (WS0) — runs FIRST, blocks everything

Parallel work cannot start until shared decisions are locked, otherwise the six documents will contradict each other on names, IDs, stacks, and events.

**Agent:** `backend-architect` (single instance), with a fast sign-off pass by `architect-reviewer` before the gate opens.
**Output:** `docs/tds/01-foundation-decisions.md`
**Duration target:** One focused pass; this is a decision document, not a design document. Each decision gets 3–10 lines of rationale, not an essay.

### Decisions that MUST be locked (the "Foundation Contract")

| # | Decision | Notes / constraints |
|---|----------|---------------------|
| F1 | **Tech stack** | Backend language + framework, frontend framework, ORM/migration tool, WebSocket/SSE approach. Must run natively on Windows 11 AND Ubuntu. Justify against the Claude Code CLI wrapping requirement (child-process control, PTY/stdio streaming). |
| F2 | **Service topology & boundaries (canonical list)** | Confirm/refine the PRD's 7 services (Frontend, Backend, PostgreSQL, Redis, Qdrant, Telegram Worker, Sync Worker; Ollama/Graphify optional). Decide: are workers separate processes or modules of the backend in V1? Which services are Phase 1 vs. later? |
| F3 | **Queue/cache strategy (the Redis decision)** | Redis has no official native Windows build. Choose: abstraction layer with a dev substitute (e.g., in-process queue / Memurai / PostgreSQL-backed queue) vs. avoiding hard Redis dependency entirely in V1. This decision shapes the event model and worker design. |
| F4 | **Canonical entity list + ID conventions** | Fix the entity names from PRD §11 (Workspace, Project, Repository, Session, Message, Agent, AgentTeam, ADR, MemoryItem, Notification) plus any the design requires (e.g., User, Setting, SecretItem, AuditLogEntry — Setting/SecretItem are mandated by PRD §4.4). Fix ID type (e.g., UUIDv7), naming case for DB (snake_case) vs. API (camelCase), timestamp conventions (UTC, `created_at`/`updated_at`). |
| F5 | **API style conventions** | REST vs. RPC-ish, URL scheme (`/api/v1/...`), pagination, error envelope, auth mechanism (single local account — session cookie vs. token), real-time channel (WebSocket vs. SSE) for live session chat. |
| F6 | **Event naming & envelope** | Event name grammar (e.g., `session.completed`, `sync.failed`), envelope fields (id, type, timestamp, source, payload), delivery semantics (at-least-once?), and where events live given F3. |
| F7 | **Session state machine (canonical)** | Lock the PRD states: Created → Running → Paused → Completed → Archived / Failed, plus allowed transitions. Consumed by schema, API, events, and UI alike. |
| F8 | **Cross-platform process model & config split** | How services run in dev (console processes / process manager on Windows) vs. prod (systemd units on Ubuntu), path conventions. Config split per PRD §4.4: **bootstrap settings** (PostgreSQL connection, listen port, encryption key) live in an env/config file; all other settings are database-stored and managed via the Settings page. No systemd assumptions in app code. |
| F9 | **Doc conventions for the TDS itself** | File map (see §3), heading structure, how Phase 3–5 placeholders are marked (e.g., a standard `> Phase N — interface only` callout), diagram format (Mermaid). |

**Gate criteria (orchestrator checks before dispatching WS1–WS6):** all nine decisions present, each with a chosen option and rationale; `architect-reviewer` sign-off recorded in the file; no open "TBD" on F1–F7 (F8/F9 may carry minor TBDs).

---

## 3. Parallel Workstreams (WS1–WS6) — run AFTER the gate

All six run in parallel. Each consumes `01-foundation-decisions.md` plus `Requirements.md` and `CLAUDE.md`. If an agent believes a foundation decision must change, it does NOT change it — it flags the conflict to the orchestrator, who routes it to `architect-reviewer`.

Note for the orchestrator: `backend-architect` appears twice (WS1, WS2). Dispatch these as **separate agent instances**; their scopes are disjoint by design.

### Workstream table

| WS | Name | Agent | Output file | Inputs (foundation artifacts) | Depends on |
|----|------|-------|-------------|-------------------------------|------------|
| WS0 | Foundation decisions | backend-architect (+ architect-reviewer sign-off) | `docs/tds/01-foundation-decisions.md` | PRD, CLAUDE.md | — |
| WS1 | Service architecture & deployment | backend-architect (instance A) | `docs/tds/02-service-architecture-and-deployment.md` | F1, F2, F3, F8 | WS0 |
| WS2 | API contracts & event models | backend-architect (instance B) | `docs/tds/04-api-contracts-and-events.md` | F1, F4, F5, F6, F7 | WS0 |
| WS3 | Database schema | postgresql-dba | `docs/tds/03-database-schema.md` | F4, F7, (F3 for any DB-backed queue tables) | WS0 |
| WS4 | Frontend architecture | frontend-developer | `docs/tds/05-frontend-architecture.md` | F1, F5, F6 (client-side event handling) | WS0 |
| WS5 | Wireframes & design system | ui-designer (authoring) + ui-ux-designer (critique pass) | `docs/tds/06-wireframes-and-design-system.md` | F4 (entity vocabulary), F7 (session states) | WS0 |
| WS6 | Test strategy | test-engineer | `docs/tds/07-test-strategy.md` | F1, F2, F8 | WS0 |
| WS7 | Integration & review | architect-reviewer | `docs/tds/00-overview.md` + review report to orchestrator | All of the above | WS1–WS6 |

### WS1 — Service architecture & deployment
- **Scope:** Service boundaries and responsibilities for all seven services + optional Ollama/Graphify; inter-service communication; the Claude Code CLI wrapper design (managed vs. observed sessions, process lifecycle, stdio/PTY streaming to the backend); deployment architecture for Ubuntu prod (systemd unit sketches, ports, data directories, backup notes) and Windows 11 dev (how to run everything natively); startup/health/failure behavior, including how each service reports health for the Settings → Services view (PRD §4.4.7); bootstrap config file handling per F8.
- **Phase guard:** Deep for Frontend, Backend, PostgreSQL, Telegram Worker, Sync Worker (Phases 1–2). Qdrant, Ollama, Graphify: placement in topology + integration interface only.
- **Non-goals:** No endpoint definitions (WS2), no table definitions (WS3), no UI (WS4/WS5), no install scripts or code.

### WS2 — API contracts & event models
- **Scope:** Full API contract for Phase 1–2 surfaces: auth, sessions (create/start/pause/resume/archive, resume/clone/export/context-package), live session chat (message send + streaming protocol), GitHub (repos/commits/PRs), Obsidian sync, ADRs, notifications, search, and **Settings (PRD §4.4)**: read/update per category (general, integrations, notifications, security), write-only secret semantics (masked on read), per-integration Test Connection actions (GitHub, Telegram, Obsidian path, Qdrant, Ollama) with success/failure responses, service health endpoint for the Services view, and audit-log entries on setting changes. Request/response shapes per F5 conventions. Complete event catalog per F6 (session lifecycle, sync, notification, git events) with payloads and producers/consumers.
- **Phase guard:** Memory APIs (Search/Store/Delete), Agent APIs (Create/Update/Assign/Execute), and the Memory/Agents settings categories as *stub contracts only* — route names, one-line semantics, reserved namespaces; no payload detail. Qdrant/Ollama test-connection endpoints: stubs (their settings exist in the UI but the integrations are Phase 3+).
- **Non-goals:** No storage design (WS3), no service placement (WS1), no client code (WS4).

### WS3 — Database schema
- **Scope:** PostgreSQL DDL-level design for all Phase 1–2 entities (per F4): users/auth, workspace, project, repository, session (+ state machine per F7), message, commit/PR tracking, ADR, notification, **settings storage per PRD §4.4** (typed key/value or per-category tables — DBA's call — covering all seven categories) with **encrypted-at-rest secret storage** for integration credentials, explicit exclusion of bootstrap settings (env/config file per F8), audit log (must capture setting changes), sync state; indexes, FKs, constraints, migration approach (per F1 ORM choice); retention/archival notes for messages.
- **Phase guard:** `agent`, `agent_team`, `memory_item` get skeleton tables or reserved-name placeholders with a short "Phase 3/4" note — enough that Phase 1–2 FKs don't paint us into a corner, no more. No Qdrant collection design beyond a one-paragraph pointer.
- **Non-goals:** No API shapes (WS2), no Qdrant/vector schema detail, no seed data or code.

### WS4 — Frontend architecture
- **Scope:** Frontend app structure per F1 stack: routing map for the seven major pages (Dashboard, Projects, Sessions, Agents, Memory, ADRs, Settings), state management, real-time layer (consuming WS2's streaming protocol as defined by F5/F6 conventions), API client conventions, error/loading patterns, dark-mode-first theming approach, mobile-friendly monitoring strategy, build/dev tooling on Windows and Ubuntu.
- **Phase guard:** Full architecture for Dashboard/Projects/Sessions/ADRs/Settings (Phases 1–2). Agents and Memory pages: route stubs and layout placeholders only.
- **Non-goals:** No visual design or wireframes (WS5), no component pixel specs, no backend contracts (WS2 owns those; WS4 consumes conventions, not invented endpoints).

### WS5 — Wireframes & design system
- **Scope:** Low-fi wireframes (ASCII/Mermaid/structured description) for Phase 1–2 screens: Home dashboard (widgets per PRD §8.1), Projects list/detail, Sessions list/detail (conversation, commits, files, timeline, notes), live session chat, ADR list/detail, login, and the **full Settings page (PRD §4.4/§8.6)**: category navigation (General, Integrations, Notifications, Memory, Agents, Security, Services), integration forms with masked write-only secret fields, Test Connection buttons with success/failure feedback states, and the read-only Services health view. Design system tokens: dark-first palette, type scale, spacing, core components (tables, status badges keyed to F7 session states, chat bubbles, notification toasts). `ui-ux-designer` performs one structured critique pass (operator-focus, information density, mobile monitoring) which `ui-designer` incorporates before handoff.
- **Phase guard:** Agents pages (builder, teams) and Memory search page: one navigation placeholder frame each, no detailed wireframes. Within Settings, the Memory and Agents categories get placeholder panels only; Qdrant/Ollama integration forms may be wireframed (they are simple forms) but marked Phase 3+.
- **Non-goals:** No component code, no frontend architecture decisions (WS4), no new entity or state names (must use F4/F7 vocabulary verbatim).

### WS6 — Test strategy
- **Scope:** Test pyramid for the chosen stack (F1); how to test the Claude Code CLI wrapper (fake CLI / recorded transcripts), GitHub integration (mocking strategy), event flows, and the API contract (contract tests against WS2 output); cross-platform CI considerations (must pass on Windows 11 and Ubuntu, no Docker in CI assumptions for local parity); quality gates per roadmap phase; definition of done for Phase 1 features.
- **Phase guard:** Test approach for Qdrant/memory and agent framework: one short "future considerations" section only.
- **Non-goals:** No test code, no tool configuration files, no re-litigating the stack.

---

## 4. Integration & Review (WS7)

**Agent:** `architect-reviewer`
**Outputs:** `docs/tds/00-overview.md` (executive summary, document map, cross-references, consolidated open-questions list) + a review report returned to the orchestrator.

**Process:**
1. Consistency sweep: entity names, ID formats, session states, event names, and API conventions identical across all six documents (F4–F7 are the reference).
2. Contract cross-check: every WS2 endpoint maps to WS3 storage and a WS4 consumer where applicable; every event has a producer and at least one consumer; every WS5 screen maps to WS2 endpoints.
3. Constraint audit: no Docker anywhere; nothing Linux-only in application design; Redis handled per F3; no Phase 3–5 deep detail (scope-guard enforcement).
4. Gap list: issues classified as **blocking** (agent must revise — orchestrator re-dispatches the owning workstream with the specific finding) or **noted** (recorded in 00-overview open questions).
5. Final pass: write `00-overview.md`, declare the TDS accepted or list remaining blockers.

**TDS acceptance criteria (all must hold):**
- [ ] All eight files exist under `docs/tds/` and follow F9 conventions.
- [ ] Covers all six mandated TDS elements: schemas, API contracts, deployment architecture, service boundaries, event models, wireframes.
- [ ] Zero naming/ID/state contradictions across documents.
- [ ] A developer could start Phase 1 implementation from WS1+WS2+WS3+WS4 without inventing any contract.
- [ ] Windows 11 dev story and Ubuntu prod story both fully described, no Docker, no hard Redis dependency in dev.
- [ ] Settings Management (PRD §4.4) covered end to end: DB storage + encrypted secrets (WS3), settings/test-connection/health APIs (WS2), Settings wireframes (WS5), bootstrap-settings split honored (F8/WS1).
- [ ] Phase 3–5 content is interface/placeholder-level only, marked with the standard callout.
- [ ] Claude Code wrapper design addresses both managed and observed sessions and real-time streaming, or documents a validated fallback.
- [ ] `architect-reviewer` sign-off recorded in `00-overview.md`.
- [ ] After acceptance: update `CLAUDE.md` "Working in This Repo" with the chosen stack (follow-up task, not part of WS1–WS7).

---

## 5. Risk Register (design phase)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **Claude Code CLI wrapper infeasible as designed** — programmatic control, PTY/stdio streaming, and "observed session" attachment may not work the way the PRD assumes; the whole Phase 1 design hangs on it. | Medium | Critical | WS0/F1 must justify the stack against this specifically; WS1 designs the wrapper with an explicit fallback (e.g., managed-only in Phase 1, observation deferred). If uncertainty remains, orchestrator dispatches a `general-purpose`/`Explore` research spike on Claude Code CLI headless/stream-json capabilities *in parallel with WS0*, feeding F1. |
| R2 | **Redis-on-Windows breaks the dev-parity constraint** — a design with hard Redis dependencies can't run natively on the Windows 11 dev machine. | High | High | F3 is a mandatory foundation decision: queue/cache behind an abstraction with a Windows-compatible dev substitute, or a PostgreSQL-backed queue for V1. WS1 and WS6 both verify the dev story against F3. |
| R3 | **Scope creep beyond Phase 1–2** — agents designing full memory/agent-framework detail balloons the TDS and delays implementation. | High | Medium | Explicit per-workstream phase guards (§3), standard placeholder callout (F9), and scope-guard enforcement as a named check in WS7's constraint audit. Orchestrator rejects deliverables that violate it. |
| R4 | **Parallel drift on shared contracts** — six agents independently invent entity names, event names, or endpoint shapes that don't match. | Medium | High | Foundation gate (WS0) locks F4–F7 before parallel start; agents may not amend foundation decisions unilaterally — conflicts escalate to `architect-reviewer` via the orchestrator; WS7 consistency sweep is blocking. |
| R5 | **Cross-platform process/deployment design gaps** — no Docker and no systemd-in-code means dev (Windows) and prod (Ubuntu) diverge in process management, paths, and config, discovered late. | Medium | Medium | F8 locks the process/config model up front; WS1 must deliver both an Ubuntu systemd sketch and a concrete Windows dev run story; WS6 requires CI/tests to pass on both OSes. |

---

## 6. Execution Sequence (orchestrator runbook)

1. **Dispatch WS0** (`backend-architect`) → optionally in parallel: R1 research spike (`Explore`/`general-purpose`) on Claude Code CLI programmatic control, results feed F1/F2.
2. **Gate check** — orchestrator verifies §2 gate criteria; `architect-reviewer` signs off on `01-foundation-decisions.md`.
3. **Dispatch WS1–WS6 in parallel** (six instances; WS5 includes the `ui-ux-designer` critique sub-step internally).
4. **Dispatch WS7** (`architect-reviewer`) when all six outputs land.
5. **Revision loop** — re-dispatch owning workstreams for blocking findings only; WS7 re-checks.
6. **Accept** — `00-overview.md` finalized; follow-up: update `CLAUDE.md` with stack/commands; commit on `DEV`.

### File map (final)

```
docs/tds/00-overview.md                             (WS7)
docs/tds/01-foundation-decisions.md                 (WS0)
docs/tds/02-service-architecture-and-deployment.md  (WS1)
docs/tds/03-database-schema.md                      (WS3)
docs/tds/04-api-contracts-and-events.md             (WS2)
docs/tds/05-frontend-architecture.md                (WS4)
docs/tds/06-wireframes-and-design-system.md         (WS5)
docs/tds/07-test-strategy.md                        (WS6)
```
