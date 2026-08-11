# Mission Control — Product Requirements Document (PRD)

- **Document Version:** 2.0
- **Product Type:** Self-Hosted AI Engineering Operating System
- **Target Platform:** Ubuntu Home Server (production); Windows 11 (local development)
- **Primary Runtime:** Claude Code CLI
- **Deployment Model:** Native installation (no Docker)

---

## 1. Executive Summary

### 1.1 Product Vision

Mission Control is a self-hosted AI Engineering Operating System that serves as the central command center for AI-assisted software development.

The platform provides:

- Claude Code session management
- GitHub repository governance
- Persistent engineering memory
- Obsidian knowledge synchronization
- Agent orchestration
- Semantic search
- Development workflow automation
- Telegram notifications

### 1.2 Problem Statement

Current AI-assisted development suffers from:

- Lost session context
- Missing decision history
- Fragmented knowledge
- Poor traceability
- No persistent memory
- Lack of agent specialization

### 1.3 Product Goals

**Primary:**

- Centralize development operations
- Preserve engineering knowledge
- Enable session continuity
- Create reusable AI agents
- Provide searchable memory

**Secondary:**

- Reduce repeated conversations
- Improve design consistency
- Improve project governance
- Accelerate development

---

## 2. Product Scope

### Included

- **Development Operations:** session management, repository management, branch tracking, PR tracking
- **Knowledge:** ADRs, documentation, Obsidian sync
- **AI:** agents, memory, search

### Excluded (V1)

- SaaS deployment
- Multi-tenant support
- Public marketplace
- Production deployment automation

---

## 3. User Personas

### Primary User

**AI-Assisted Developer** — responsible for software development, architecture, requirements, and documentation.

### Future Personas

- Technical Lead
- Architect
- Team Member
- Product Owner

---

## 4. Functional Requirements

### 4.1 Session Management

**Objective:** Track and manage all Claude Code activity.

**Session Types:**

- **Managed Session** — launched through Mission Control (Dashboard → Mission Control → Claude Code)
- **Observed Session** — Mission Control attaches to an existing session

**Stored Metadata:**

- Session: Session ID, Project, Branch, Status, Duration, User, Runtime, Cost
- Runtime: Claude Version, Machine, Environment

**Session States:** Created → Running → Paused → Completed → Archived / Failed

**Session Features:**

- Resume Session
- Clone Session
- Archive Session
- Export Session
- Generate Context Package

### 4.2 Live Session Chat

**Goal:** Interact with running Claude sessions through the browser.

**Features:**

- **Prompt Transmission:** User → Dashboard → Claude Session
- **Response Streaming:** real-time updates
- **Message History:** store User, Assistant, System, and Tool messages
- **Multi-Session Support:** multiple sessions (A, B, C, …) active simultaneously

### 4.3 GitHub Integration

**Repository Discovery:** automatic detection.

**Repository Metadata:** Name, URL, Remote, Visibility, Default Branch

**Commit Tracking:** SHA, Author, Timestamp, Files, Message

**Pull Request Tracking:** Created, Opened, Reviewed, Merged, Rejected

**Workflow Modes:**

- **Manual** — full user control
- **Assisted** — system assists with PR creation, descriptions, and review summaries
- **Future** — automated merges

---

## 5. Agent Framework

### 5.1 Agent Philosophy

Agents are not AI models. Agents are specialized personas operating through runtimes.

```
Runtime → Agent → Task
```

### 5.2 Agent Types

- **Global Agents** — available to all projects. Examples: Architect, Security, QA, Documentation
- **Project Agents** — repository-specific. Examples: ERP Architect, Mission Control Product Owner
- **Session Agents** — temporary. Examples: Release Manager, Refactoring Assistant

### 5.3 Agent Structure

```yaml
id:
name:
description:
scope:
runtime:
permissions:
knowledge:
memory:
instructions:
```

### 5.4 Agent Runtimes

- **V1:** Claude Code (primary), Ollama (optional)
- **V2:** Anthropic API, OpenAI API, Gemini API

### 5.5 Agent Permissions

- **Repository:** Read, Write, Commit, Create PR, Merge, Delete
- **Memory:** Read, Write, Delete
- **Documentation:** Create ADR, Create Notes, Edit Notes

### 5.6 Agent Workflows

Example: `Developer → QA → Security → Architect`

### 5.7 Agent Teams

Example team: Product Owner, Architect, Developer, QA, Security.

Teams can be assigned per project.

### 5.8 Agent Builder

UI-based configuration with sections: Name, Description, Prompt, Scope, Permissions, Runtime, Knowledge Sources.

---

## 6. Memory System

### 6.1 Memory Architecture

- **Session Memory** — temporary
- **Project Memory** — repository-specific
- **Agent Memory** — agent-specific
- **Global Memory** — organization-wide

### 6.2 Vector Storage

Technology: **Qdrant**

### 6.2.1 Structural Code Memory (Optional)

Technology: **Graphify** (open-source, Apache 2.0)

Complements Qdrant's episodic memory (sessions, decisions, ADRs) with structural codebase memory:

- Parses repositories locally with tree-sitter into a queryable knowledge graph (entities and relationships)
- Agents query code structure instead of grepping, reducing token cost on large codebases
- Runs fully local (no cloud, no telemetry, no API keys) — consistent with the self-hosted, no-Docker model
- Ships as a Claude Code skill, matching the primary V1 runtime

Adoption path: trial as a per-repository Claude Code skill first; if proven, integrate into repository onboarding with graph refresh handled by the Sync Worker.

### 6.3 Memory Sources

- Sessions
- Commits
- ADRs
- Obsidian Notes
- PR Descriptions
- Documentation

### 6.4 Memory Retrieval

Support natural-language queries such as:

- "When did we adopt Redis?"
- "Show authentication discussions."
- "Find deployment decisions."

---

## 7. Knowledge Management

### 7.1 Obsidian Integration

**Sync:** two-way.

**Vault Layout:**

```
Projects/
Sessions/
ADRs/
Agents/
Features/
Daily/
```

### 7.2 Documentation Generation

Automatically create:

- Session Notes
- Feature Notes
- ADRs
- Requirements

### 7.3 ADR Management

Template sections: Context, Decision, Alternatives, Consequences.

---

## 8. Dashboard

### 8.1 Home

Widgets: Active Projects, Active Sessions, Recent ADRs, Upcoming Tasks, Notifications.

### 8.2 Projects

Display: Repositories, Agents, Memory, Sessions.

### 8.3 Sessions

Display: Conversation, Commits, Files, Timeline, Notes.

### 8.4 Memory

Semantic search interface.

### 8.5 Agents

Manage: global agents, project agents, teams, permissions.

---

## 9. Telegram Integration

- **Session Complete notification:** Summary, Commits, Duration
- **Daily Report:** Projects, Sessions, PRs, ADRs
- **Alerts:** Failed Syncs, Repository Problems, Session Errors

---

## 10. Security

### Authentication

Local account. Future: OIDC, GitHub OAuth.

### Secrets Storage

Encrypted. Stores: Tokens, Keys, Credentials.

### Audit Logs

Track: Agent Actions, Git Actions, Memory Updates.

---

## 11. Data Model

Core entities:

- Workspace
- Project
- Repository
- Session
- Message
- Agent
- Agent Team
- ADR
- Memory Item
- Notification

---

## 12. API Design

- **Session APIs:** Create, Start, Pause, Resume, Archive
- **Agent APIs:** Create, Update, Assign, Execute
- **Memory APIs:** Search, Store, Delete
- **GitHub APIs:** Repositories, Commits, PRs

---

## 13. Infrastructure

### Production

**Ubuntu Server** — single-node deployment, services installed natively (no Docker) and managed as system services (e.g., systemd).

**Services:**

1. Frontend
2. Backend
3. PostgreSQL
4. Redis
5. Qdrant
6. Telegram Worker
7. Sync Worker

**Optional:** Ollama, Graphify (structural code memory, see 6.2.1)

### Development Environment

The full development environment must run locally on **Windows 11** (no Docker). This constrains technology choices:

- All services (Frontend, Backend, workers) must run cross-platform on both Windows 11 and Ubuntu.
- Dependencies (PostgreSQL, Redis, Qdrant) must be installable and runnable natively on Windows, or have a Windows-compatible development substitute. Note: Redis has no official native Windows build — the design must either use a Windows-compatible alternative (e.g., Memurai, or an embedded/in-process substitute for dev) or avoid hard Redis dependencies in development.
- No systemd assumptions in application code — service management is an OS-level concern (systemd on Ubuntu, manual/console processes or Windows services in development).
- File paths, process management, and scripts must be cross-platform.

---

## 14. UI/UX Specifications

### Design Principles

- Fast
- Minimal
- Operator-focused
- Dark mode first
- Mobile-friendly monitoring

### Major Pages

Dashboard, Projects, Sessions, Agents, Memory, ADRs, Settings.

---

## 15. Development Roadmap

- **Phase 1 (Foundation):** Authentication, session tracking, Claude wrapper, GitHub integration, dashboard
- **Phase 2 (Knowledge):** Obsidian sync, ADR generation, Telegram, search
- **Phase 3 (Memory):** Qdrant, context recovery, semantic search, Graphify structural code memory (optional)
- **Phase 4 (Agents):** Agent framework, agent builder, agent teams, agent workflows
- **Phase 5 (Advanced):** Anthropic/OpenAI/Gemini adapters, multi-runtime orchestration, advanced automation, autonomous review flows

---

## Next Steps

This PRD is the master blueprint. The next document should be a **Technical Design Specification (TDS)** containing database schemas, API contracts, deployment architecture, service boundaries, event models, and wireframes for implementation.
