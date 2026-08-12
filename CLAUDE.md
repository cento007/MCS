# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**Design phase — no application code exists yet.** The repository contains `Requirements.md` (PRD v2.1) for **Mission Control**, a self-hosted AI Engineering Operating System, plus the Technical Design Specification in `docs/tds/`.

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

- **Backend:** Node.js 22 LTS + Fastify 5. **Frontend:** React 19 + Vite SPA + Tailwind 4 (no SSR; the Backend serves the built SPA in production).
- **Data:** PostgreSQL 16+ via Drizzle ORM + drizzle-kit over `pg`. IDs are app-generated UUIDv7; tables/columns plural snake_case; API JSON camelCase; all timestamps `timestamptz` UTC.
- **Realtime:** a single multiplexed WebSocket at `/api/v1/ws` (SSE was rejected — live session chat is bidirectional).
- **Claude Code runtime:** the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) embedded in the Backend for managed sessions; observed sessions ingest via Claude Code hooks posting to `POST /api/v1/hook-events` plus version-tolerant transcript JSONL tailing.
- **Tests:** Vitest (unit + integration) and Playwright (E2E), on a Windows + Ubuntu CI matrix.
- **Bootstrap config** (env/file only, everything else is DB-stored via the Settings page): `DATABASE_URL`, `MC_HOST`, `MC_PORT`, `MC_ENCRYPTION_KEY`, `MC_DATA_DIR`, `NODE_ENV`, `LOG_LEVEL`. Single root `.env`, real environment variables take precedence.

## Working in This Repo

- There are no build, lint, or test commands yet — scaffolding has not been generated. When it is, replace this line with the actual commands.
- Design documents live in `docs/`: TDS in `docs/tds/`, research in `docs/research/`, review registers in `docs/reviews/`. ADRs will follow the PRD §7.3 template.
- Before designing or implementing anything, read `Requirements.md` and `docs/tds/01-foundation-decisions.md`. The Foundation Contract is not advisory — workstreams consume it verbatim and escalate conflicts rather than amending it locally.
