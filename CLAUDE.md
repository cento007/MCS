# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**Phases 1, 2 and 3 are complete. Phase 4 (Agents) is next.** The Technical Design Specification (`docs/tds/`) is complete and approved; `Requirements.md` (PRD v2.1) remains the product source of truth. `docs/progress-log.md` is the running record and is the fastest way to learn *why* something is built the way it is.

**Phase 1 (Foundation).** The pnpm monorepo; the full database schema (23 tables, migrated); authentication (argon2id, DB-backed cookie sessions, hashed scoped API tokens, route guards, audit logging); session tracking with the F7 state machine and transactional outbox; the Claude Code wrapper (managed via the Agent SDK, observed via hook ingest and a version-tolerant transcript tailer); the WebSocket hub; projects/repositories with working-tree status; the health/spend/schedule/notifications read models; the settings backend with its key registry and test-connection executors; and the SPA — login, app shell, sessions list, live session view, Dashboard, Settings. GitHub integration: local discovery from `origin` remotes (no API calls, so it works before a token exists), repository sync of metadata/commits/PRs, a self-rescheduling poll job, and commit→session attribution that declines when ambiguous.

**Phase 2 (Knowledge).** Keyword search across five branches, two-way Obsidian sync, ADR generation, and Telegram notifications.

**Phase 3 (Memory).** Qdrant + Ollama behind `EmbeddingPort`/`VectorStorePort` with fakes the unit tier runs on; the embedding **stamp** (model + dimension) carried redundantly in three places, because mismatched vectors return confident nonsense rather than an error; ingestion of all six PRD §6.3 sources including repository documentation; semantic retrieval with a **measured** relevance floor (`DEFAULT_MIN_SCORE = 0.52`, inside a 0.043-wide gap between on- and off-topic scores); the Memory screen, whose four distinct empty states are its reason for existing; session export and context packages; and `settings.memory` — indexed-source toggles and per-tier retention, both actually enforced.

Known gaps, none blocking Phase 4: `openapi.yaml` is emitted but declares **no response schemas** (`x-mc-response-schema: undeclared` on every operation) and types `error.code` as a pattern rather than an enum, so `apps/frontend/src/lib/api/types.ts` is still hand-written and response types are not yet derivable from the spec; a malformed read-model body can throw inside `AppShell`, whose only error boundary is on the `RequireAuth` parent, so one bad payload replaces the whole authenticated area; `GET /schedule` has no `memory_retention` row; and `integrations.ollama.enabled` is still read by nothing. **Graphify (PRD §6.2.1) is untouched and explicitly optional** — its adoption path starts with a hands-on trial as a per-repository Claude Code skill.

Remote: https://github.com/cento007/MCS. Development work happens on the `DEV` branch; `main` is the stable branch.

The TDS (`docs/tds/00-overview.md` → `07-test-strategy.md`) covers database schemas, API contracts, deployment architecture, service boundaries, event models, and wireframes. **`docs/tds/01-foundation-decisions.md` is the Foundation Contract** — tech stack, service topology, entity/ID/timestamp conventions, API and event conventions, and the session state machine. It is binding: consume its vocabulary verbatim rather than inventing parallel names. `docs/tds/00-overview.md` carries the document map, the sanctioned-deviations register, and arbitrated cross-document decisions.

Supporting documents: `docs/project-plan.md` (workstream plan and risk register), `docs/progress-log.md` (running record of completed work), `docs/research/claude-code-control-spike.md` (evidence base for the Claude Code wrapper), `docs/reviews/` (review findings registers).

## What Mission Control Is

A self-hosted command center for AI-assisted development, installed natively (no Docker) on a single Ubuntu home server. Core capabilities: Claude Code session management (managed + observed sessions with live browser chat), GitHub integration (repos, commits, PRs), an agent framework (agents = personas running on runtimes, not models), a four-tier memory system (session/project/agent/global) backed by Qdrant semantic search, two-way Obsidian sync with ADR generation, and Telegram notifications. Graphify (local code knowledge graph, Claude Code skill) is planned as optional structural code memory alongside Qdrant's episodic memory (Phase 3+, pending a hands-on trial).

Read `Requirements.md` in full before making design or implementation decisions — it is the single source of truth for scope, data model, and roadmap.

## Key Constraints from the PRD

- **No Docker.** Anywhere — not in production, not in development, not in CI. Services run natively on the Ubuntu server under systemd (unit files confined to `deploy/systemd`, never referenced from application code).
- **No Redis.** The PRD's §13 service list includes it, but the TDS eliminates it: the job queue is **pg-boss on PostgreSQL**, behind a `QueuePort` abstraction, with `LISTEN/NOTIFY` for cross-process wake-ups and per-process in-memory LRU caches. This is a deliberate, recorded deviation (`docs/tds/00-overview.md` §4, D1) driven by Redis having no official native Windows build. Service topology is Frontend (static artifact), Backend, PostgreSQL, Telegram Worker, Sync Worker; Qdrant/Ollama/Graphify are Phase 3+.
- **Dev environment is Windows 11, production is Ubuntu.** The full stack must run natively on this Windows 11 machine during development — cross-platform tech only, OS-agnostic scripts and paths, no Linux-only dependency in application code. Automated tests must pass natively on both.
- **Agent runtimes:** Claude Code CLI is the primary runtime in V1 (Ollama optional). Anthropic/OpenAI/Gemini API adapters are deferred to V2.
- **V1 explicitly excludes:** SaaS deployment, multi-tenancy, public marketplace, production deployment automation. Single local user account for auth.
- **Build order (roadmap phases):** 1) Foundation (auth, session tracking, Claude wrapper, GitHub, dashboard) → 2) Knowledge (Obsidian, ADRs, Telegram, search) → 3) Memory (Qdrant) → 4) Agents → 5) Multi-runtime/advanced. Don't build later-phase features before their dependencies.
- **UI principles:** fast, minimal, operator-focused, dark mode first, mobile-friendly monitoring.

## Chosen Stack (Foundation Contract F1)

TypeScript throughout, in a pnpm monorepo: `apps/{backend,frontend,telegram-worker,sync-worker}` + `packages/shared` + `deploy/{systemd,windows}`.

- **Backend:** Node.js (floor ≥22; production runs whichever release is active LTS at deploy time — F1.2) + Fastify 5. **Frontend:** React 19 + Vite SPA + Tailwind 4 (no SSR; the Backend serves the built SPA in production).
- **Data:** PostgreSQL 16+ via Drizzle ORM + drizzle-kit over `pg`. IDs are app-generated UUIDv7; tables/columns plural snake_case; API JSON camelCase; all timestamps `timestamptz` UTC.
- **Realtime:** a single multiplexed WebSocket at `/api/v1/ws` (SSE was rejected — live session chat is bidirectional).
- **Claude Code runtime:** the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) embedded in the Backend for managed sessions; observed sessions ingest via Claude Code hooks posting to `POST /api/v1/hook-events` plus version-tolerant transcript JSONL tailing.
- **Tests:** Vitest (unit + integration) and Playwright (E2E), on a Windows + Ubuntu CI matrix.
- **Bootstrap config** (env/file only, everything else is DB-stored via the Settings page): `DATABASE_URL`, `MC_HOST`, `MC_PORT`, `MC_ENCRYPTION_KEY`, `MC_DATA_DIR`, `NODE_ENV`, `LOG_LEVEL`. Single root `.env`, real environment variables take precedence.

## Commands

Run from the repo root. None of these require a database.

| Command | What it does |
|---|---|
| `pnpm install` | Install all workspace dependencies |
| `pnpm dev` | Backend (`tsx watch`) + Vite dev server (`:5173`), colour-prefixed |
| `pnpm dev:workers` | Telegram + Sync workers (Phase 2) |
| `pnpm build` | Build shared → apps → SPA (`apps/frontend/dist`), topological order |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm lint` / `pnpm lint:fix` | Biome (lint + format + import sort) |
| `pnpm format` | Biome formatter, write |
| `pnpm test` | Vitest unit suites, all packages |
| `pnpm test:e2e` | Playwright (run `pnpm exec playwright install chromium` first) |
| `pnpm --filter @mc/backend <script>` | Scope any script to one package |

These require a running PostgreSQL and fail with an actionable message if it is absent:

| Command | What it does |
|---|---|
| `pnpm db:generate` | drizzle-kit: schema → SQL migrations in `packages/shared/drizzle/` |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | drizzle-kit studio |
| `pnpm test:int` | Vitest integration tier (`*.int.test.ts`) against per-worker template-clone databases; also needs `TEST_DATABASE_URL` and a role with CREATEDB (TDS 07 §3.1) |
| `pnpm auth:create-user --username <name>` | Create the single local account on a fresh install; password from stdin or `MC_BOOTSTRAP_PASSWORD`, never argv. Never overwrites an existing account — `--reset-password` is the explicit escape hatch |

First run: copy `.env.example` → `.env` at the repo root and generate `MC_ENCRYPTION_KEY` with
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`.
See `deploy/windows/README.md` (dev) and `deploy/systemd/README.md` (prod).

**Back up `MC_ENCRYPTION_KEY` out-of-band.** It is the key-encryption key for every stored
secret and is deliberately excluded from database backups — losing it makes those secrets
unrecoverable even from a perfect restore.

## Working in This Repo
- Design documents live in `docs/`: TDS in `docs/tds/`, research in `docs/research/`, review registers in `docs/reviews/`. ADRs will follow the PRD §7.3 template.
- Before designing or implementing anything, read `Requirements.md` and `docs/tds/01-foundation-decisions.md`. The Foundation Contract is not advisory — workstreams consume it verbatim and escalate conflicts rather than amending it locally.
