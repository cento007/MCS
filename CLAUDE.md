# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

**Greenfield — no code exists yet.** The repository currently contains only `Requirements.md`, the Product Requirements Document (PRD v2.0) for **Mission Control**, a self-hosted AI Engineering Operating System.

Remote: https://github.com/cento007/MCS. Development work happens on the `DEV` branch; `main` is the stable branch.

Per the PRD, the next deliverable is a **Technical Design Specification (TDS)** — database schemas, API contracts, Docker architecture, service boundaries, event models, and wireframes — before implementation begins.

## What Mission Control Is

A self-hosted command center for AI-assisted development, installed natively (no Docker) on a single Ubuntu home server. Core capabilities: Claude Code session management (managed + observed sessions with live browser chat), GitHub integration (repos, commits, PRs), an agent framework (agents = personas running on runtimes, not models), a four-tier memory system (session/project/agent/global) backed by Qdrant semantic search, two-way Obsidian sync with ADR generation, and Telegram notifications. Graphify (local code knowledge graph, Claude Code skill) is planned as optional structural code memory alongside Qdrant's episodic memory (Phase 3+, pending a hands-on trial).

Read `Requirements.md` in full before making design or implementation decisions — it is the single source of truth for scope, data model, and roadmap.

## Key Constraints from the PRD

- **No Docker.** Services run natively on the Ubuntu server (e.g., under systemd). Planned service topology: Frontend, Backend, PostgreSQL, Redis, Qdrant, Telegram Worker, Sync Worker; Ollama optional.
- **Dev environment is Windows 11, production is Ubuntu.** The full stack must run natively on this Windows 11 machine during development — pick cross-platform tech, keep scripts/paths OS-agnostic, and don't bake systemd (or any Linux-only dependency) into application code. Watch Redis: it has no official native Windows build, so dev needs a Windows-compatible substitute or the design must avoid a hard Redis dependency.
- **Agent runtimes:** Claude Code CLI is the primary runtime in V1 (Ollama optional). Anthropic/OpenAI/Gemini API adapters are deferred to V2.
- **V1 explicitly excludes:** SaaS deployment, multi-tenancy, public marketplace, production deployment automation. Single local user account for auth.
- **Build order (roadmap phases):** 1) Foundation (auth, session tracking, Claude wrapper, GitHub, dashboard) → 2) Knowledge (Obsidian, ADRs, Telegram, search) → 3) Memory (Qdrant) → 4) Agents → 5) Multi-runtime/advanced. Don't build later-phase features before their dependencies.
- **UI principles:** fast, minimal, operator-focused, dark mode first, mobile-friendly monitoring.

## Working in This Repo

- There are no build, lint, or test commands yet. When the tech stack is chosen and scaffolding is added, update this file with the actual commands.
- New design documents (e.g., the TDS, ADRs) belong alongside `Requirements.md` in the repo root or a `docs/` directory.
