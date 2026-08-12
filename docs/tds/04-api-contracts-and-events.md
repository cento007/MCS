# TDS 04 — API Contracts & Event Models (WS2)

- **Status:** Revised — WS7 integration-review package 2 applied (2026-08-11): blocking findings B3, B5, B6, B9, B11b, B12, B13 and non-blocking N1, N4, N5, N10, per arbitrations A1–A10 in `docs/tds/00-overview.md` §5.
- **Owner:** WS2 / backend-architect (instance B)
- **Date:** 2026-08-11
- **Inputs:** `docs/tds/01-foundation-decisions.md` (Foundation Contract — consumed verbatim), `docs/tds/00-overview.md` (WS7 arbitrated decisions §5, blocking findings §7 — authoritative), `docs/tds/03-database-schema.md` (WS3 storage shapes this contract matches), `Requirements.md` (PRD v2.1, esp. §4, §5, §8, §12), `docs/project-plan.md` (WS2 row), `docs/research/claude-code-control-spike.md`
- **Foundation decisions consumed:** F1.5 (wrapper/session facts), F4 (entities, ID/naming/timestamp conventions), F5 (API conventions), F6 (event grammar/envelope/delivery), F7 (session state machine), F9 (doc conventions)
- **Non-goals:** process/deployment layout (WS1), table DDL (WS3), frontend consumption (WS4), UI layouts (WS5)

This document is the contract-first source for the OpenAPI 3.1 spec: every endpoint is specified with method, path, request/response shape, and error codes so that `openapi.yaml` can be generated mechanically (Fastify JSON schemas → OpenAPI per F5.1). §16 contains a fully-specified representative OpenAPI snippet for the Sessions resource.

---

## 1. Global Conventions

All conventions below restate or elaborate F4/F5 — none amend them.

### 1.1 Base URL, naming, versioning

- All REST routes live under `/api/v1` (F5.2). Plural kebab-case resources; lifecycle verbs are POST sub-actions (F5.1).
- JSON fields are `camelCase`; timestamps are ISO 8601 UTC with `Z` suffix (F4.2). All IDs are UUIDv7 strings (F4.2) unless explicitly noted (e.g., `runtimeSessionId` is the Claude Code UUIDv4 per F1.5).
- Every response carries `X-Request-Id`. The same value appears as `requestId` in error envelopes and logs (F5.4).

### 1.2 Response envelopes

- **Lists** (F5.3): `{ "data": [ … ], "meta": { "nextCursor": string|null, "limit": number } }`. Query params `limit` (default 50, max 200) and `cursor`. The cursor stays **opaque and base64-encoded** per F5.3; what it encodes is the *stated ordering key of that resource* — the UUIDv7 `id` by default, and the per-session `ordinal` for `GET /sessions/{id}/messages` (§6.6, arbitration A5). Default sort: ascending by `id` (UUIDv7 = time-ordered) unless the resource states otherwise; messages sort by `ordinal`, never by `id`.
- **Fixed read models** (`/services/health` §7.5, `/schedule` §7.7): small, bounded, non-paginated results returned as `{ "data": … }` with no `meta` — F5.3 pagination applies to unbounded collections.
- **Single resources / action results** (WS2 elaboration, applied uniformly): `{ "data": { … } }`.
- **No body**: `204 No Content` for deletes, logout, and ingest acks.
- **Errors** (F5.4, every non-2xx):

```json
{
  "error": {
    "code": "UPPER_SNAKE_CODE",
    "message": "Human-readable summary",
    "details": { "field": "…" },
    "requestId": "018f6b2e-…"
  }
}
```

### 1.3 Error code registry

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | Request body/query failed schema validation; `details` lists field errors |
| `INVALID_CURSOR` | 400 | Unparseable/foreign `cursor` value |
| `UNAUTHORIZED` | 401 | No/invalid session cookie or bearer token |
| `INVALID_CREDENTIALS` | 401 | Login failure (never distinguishes user vs password) |
| `FORBIDDEN` | 403 | Authenticated but not allowed (e.g., `ingest`-scoped token on a non-ingest route) |
| `ORIGIN_NOT_ALLOWED` | 403 | WebSocket upgrade (or cookie-auth cross-origin request) with disallowed `Origin` (§14.2) |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Generic state conflict (e.g., delete project with live sessions) |
| `INVALID_STATE_TRANSITION` | 409 | Session sub-action not legal from current F7 state |
| `SESSION_NOT_RUNNING` | 409 | Prompt submitted to a session that is not `running` |
| `OPERATION_NOT_SUPPORTED` | 409 | Action inapplicable to session type (e.g., `pause` on an observed session — physical semantics per WS1). **Canonical code** for this condition; WS1 §5.2's provisional name `UNSUPPORTED_FOR_SESSION_TYPE` is superseded — the error registry is owned by WS2 per F5.4 |
| `NO_TURN_IN_FLIGHT` | 409 | `interrupt` requested but no assistant turn is currently streaming (§6.3.1) |
| `INTEGRATION_NOT_CONFIGURED` | 409 | Test-connection or dependent action invoked before required settings/secrets exist |
| `PAYLOAD_TOO_LARGE` | 413 | Body exceeds route limit (prompts: 256 KiB; default: 1 MiB) |
| `RATE_LIMITED` | 429 | Throttled (login: 10/min/IP; other routes per WS1 policy) |
| `INTERNAL` | 500 | Unhandled error; `requestId` is the support handle |
| `RUNTIME_UNAVAILABLE` | 503 | Claude Code CLI/SDK not reachable (bad path, spawn failure) |

### 1.4 Authentication (F5.5)

Two principals, both mapped to the single local User (F4.1):

1. **Browser session cookie** — `mc_session`; HTTP-only, `SameSite=Lax`, `Secure` when served over HTTPS; server-side session persisted in PostgreSQL; idle timeout from `security.sessionTimeoutMinutes` (§7).
2. **Bearer API token** — `Authorization: Bearer mct_<token>`; hashed at rest; created/revoked via §3.3. Scopes: `full` (entire API) and `ingest` (only `POST /api/v1/hook-events`, §6.8).

All routes require authentication except `POST /api/v1/auth/login`. There is no RBAC in V1 (single user); scope enforcement (`ingest`) is the only authorization rule.

---

## 2. Resource Catalog

| Resource | Base path | Phase | Section |
|---|---|---|---|
| Auth & API tokens | `/api/v1/auth/*` | 1 | §3 |
| Projects | `/api/v1/projects` | 1 | §4 |
| Repositories | `/api/v1/repositories` | 1 | §5.1 |
| Commits | `/api/v1/commits` (+ nested) | 1 | §5.2 |
| PullRequests | `/api/v1/pull-requests` (+ nested) | 1 | §5.3 |
| Sessions | `/api/v1/sessions` | 1 | §6 |
| Messages | `/api/v1/messages` (+ nested) | 1 | §6.6 |
| Hook events (observed-session ingest) | `/api/v1/hook-events` | 1 | §6.8 |
| Settings | `/api/v1/settings` | 1 | §7 |
| Service health | `/api/v1/services/health` | 1 | §7.5 |
| Schedule (computed read model) | `/api/v1/schedule` | 1 | §7.7 |
| AuditLogEntries | `/api/v1/audit-log-entries` | 1 | §12 |
| Notifications | `/api/v1/notifications` | 2 | §8 |
| Adrs | `/api/v1/adrs` | 2 | §9 |
| Sync runs (Obsidian) | `/api/v1/sync-runs` | 2 | §10 |
| Search | `/api/v1/search` | 2 | §11 |
| MemoryItems | `/api/v1/memory-items` | 3 — stub | §13.1 |
| Agents / AgentTeams | `/api/v1/agents`, `/api/v1/agent-teams` | 4 — stub | §13.2 |
| WebSocket | `/api/v1/ws` | 1 | §14 |

---

## 3. Auth & API Tokens

### 3.1 Session auth

**`POST /api/v1/auth/login`** — no auth required. Rate limited 10/min/IP → `RATE_LIMITED`.

```ts
// Request
{ username: string, password: string }
// 200 — sets mc_session cookie
{ data: { user: { id: string, username: string }, expiresAt: string } }
// Errors: INVALID_CREDENTIALS (401), RATE_LIMITED (429), VALIDATION_FAILED (400)
```

Emits an `audit.entry_recorded` event (action `auth.login` / `auth.login_failed`).

**`POST /api/v1/auth/logout`** → `204`; invalidates the server-side session, clears cookie.

**`GET /api/v1/auth/me`**

```ts
// 200
{ data: {
    user: { id: string, username: string },
    authMethod: 'cookie' | 'token',
    session: { expiresAt: string } | null   // null for token auth
} }
```

**`POST /api/v1/auth/password`** — change password (PRD §4.4.6).

```ts
// Request
{ currentPassword: string, newPassword: string }   // newPassword: min 12 chars
// 204. Errors: INVALID_CREDENTIALS (401 — wrong currentPassword), VALIDATION_FAILED (400)
```

Invalidates all other server-side sessions; audited.

### 3.2–3.3 API tokens (PRD §4.4.6)

**`GET /api/v1/auth/tokens`**

```ts
// 200
{ data: Array<{
    id: string, name: string, prefix: string,          // e.g. "mct_a1b2…" (first 8 chars)
    scopes: Array<'full'|'ingest'>,
    lastUsedAt: string|null, expiresAt: string|null, createdAt: string
}>, meta: { nextCursor: null, limit: 50 } }
```

**`POST /api/v1/auth/tokens`**

```ts
// Request
{ name: string, scopes?: Array<'full'|'ingest'>, expiresAt?: string }  // default scopes: ['full']
// 201 — `token` is shown exactly once, stored only as a hash
{ data: { id: string, name: string, token: string, prefix: string, scopes: string[], expiresAt: string|null, createdAt: string } }
```

**`DELETE /api/v1/auth/tokens/{id}`** → `204`. Errors: `NOT_FOUND`. Audited.

---

## 4. Projects

```ts
interface Project {
  id: string; workspaceId: string;            // single default Workspace in V1 (F4.1)
  name: string; description: string | null;
  workflowMode: 'manual' | 'assisted' | null; // null = inherit integrations.github.workflowMode (§7.2)
  createdAt: string; updatedAt: string; archivedAt: string | null;
}
```

`workflowMode` is the per-Project override of the global GitHub Workflow Mode (PRD §4.3; arbitration A10). `null` means inherit — the effective mode is `project.workflowMode ?? integrations.github.workflowMode`. Storage: `projects.workflow_mode` (WS3, nullable). The *setting* is Phase 1; assisted **actions** are Phase 2 (§5.3).

| Method & path | Purpose | Notes / errors |
|---|---|---|
| `GET /api/v1/projects` | List (cursor) | Filter: `?archived=false` (default) |
| `POST /api/v1/projects` | Create → `201 { data: Project }` | `{ name, description?, workflowMode? }`; `VALIDATION_FAILED` |
| `GET /api/v1/projects/{id}` | Fetch | `NOT_FOUND` |
| `PATCH /api/v1/projects/{id}` | Update `{ name?, description?, archivedAt?, workflowMode? }` (`workflowMode: null` clears the override) | `VALIDATION_FAILED`, `NOT_FOUND` |
| `DELETE /api/v1/projects/{id}` | Delete → `204` | `CONFLICT` (409) if sessions/repositories still reference it |

---

## 5. Repositories, Commits, PullRequests (PRD §4.3)

### 5.1 Repositories

```ts
interface Repository {
  id: string; projectId: string | null;
  name: string; localPath: string;            // absolute native path (F8.1 path rules)
  remoteUrl: string | null; visibility: 'public'|'private'|'unknown';
  defaultBranch: string;
  lastSyncedAt: string | null; syncStatus: 'ok'|'failed'|'never';
  createdAt: string; updatedAt: string;
}
```

| Method & path | Purpose | Notes / errors |
|---|---|---|
| `GET /api/v1/repositories` | List (cursor); `?projectId=` filter | |
| `GET /api/v1/repositories/{id}` | Fetch | `NOT_FOUND` |
| `PATCH /api/v1/repositories/{id}` | `{ projectId? }` — assign to project | `NOT_FOUND`, `VALIDATION_FAILED` |
| `POST /api/v1/repositories/discover` | Scan discovery roots (settings §7.2) → `202 { data: { jobId: string } }` | `INTEGRATION_NOT_CONFIGURED` if no roots configured. Emits `repository.discovered` per new repo |
| `POST /api/v1/repositories/{id}/sync` | Refresh commits/PRs from git + GitHub → `202 { data: { jobId: string } }` | Emits `repository.synced` / `repository.sync_failed` |

Discovery/sync execute as pg-boss jobs (F3): in Phase 1 the Backend is the worker; in Phase 2 scheduled polling moves to the Sync Worker (F2.1) — the API contract is unchanged.

### 5.2 Commits

```ts
interface Commit {
  id: string; repositoryId: string; sessionId: string | null;   // linked when produced during a tracked Session
  sha: string; message: string; authorName: string; authorEmail: string;
  committedAt: string; filesChanged: number; additions: number; deletions: number;
  createdAt: string;
}
```

- `GET /api/v1/repositories/{id}/commits` — cursor list, newest first (`order=desc` default here); filters `?sessionId=`, `?branch=`.
- `GET /api/v1/commits/{id}` — single commit incl. `files: Array<{ path: string, status: 'added'|'modified'|'deleted'|'renamed' }>`.

### 5.3 PullRequests

```ts
interface PullRequest {
  id: string; repositoryId: string;
  number: number; title: string; url: string;
  state: 'open'|'merged'|'closed';                       // lifecycle facts (opened/reviewed/…) are events, §15
  authorLogin: string; sourceBranch: string; targetBranch: string;
  openedAt: string; mergedAt: string | null; closedAt: string | null;
  createdAt: string; updatedAt: string;
}
```

- `GET /api/v1/pull-requests` — cursor list; filters `?repositoryId=`, `?state=`.
- `GET /api/v1/repositories/{id}/pull-requests` — nested convenience list.
- `GET /api/v1/pull-requests/{id}` — single PR.

**Workflow Modes (PRD §4.3) — setting is Phase 1, actions are Phase 2.** The Manual/Assisted selector exists and persists from Phase 1: globally as `integrations.github.workflowMode` (§7.2) and per Project as `Project.workflowMode` (§4, `null` = inherit). Nothing in Phase 1 *behaves* differently — the mode is read by Phase 2 assisted actions.

> **Phase 2 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

Assisted-mode PR **actions** — PR creation, PR description generation, review summaries — are deferred to Phase 2 (sanctioned deviation D8): they depend on Phase 2 knowledge generation. There are therefore **no write endpoints on `pull-requests`** in this contract; `pull-requests` is read-only in Phase 1.

---

## 6. Sessions & Messages

### 6.1 Session resource

**Naming (resolves WS7 non-blocking N1): the session-type field is `sessionType` everywhere in this API** — on the resource, as the list filter `?sessionType=`, and in event payloads (§15.2). The earlier `Session.type` / `?type=` spelling is superseded; there is now exactly one API spelling. It maps to WS3's session-type column (`sessions.kind`, or `session_type` if WS3 adopts N1's rename) — a serialization mapping in `packages/shared`, not a second vocabulary. Values are unchanged: `managed` | `observed`.

```ts
type SessionState = 'created'|'running'|'paused'|'completed'|'failed'|'archived';  // F7, verbatim

interface Session {
  id: string;                                   // UUIDv7 (ours)
  projectId: string; repositoryId: string | null;
  sessionType: 'managed' | 'observed';          // PRD §4.1 session types (N1: one name, API-wide)
  state: SessionState;
  title: string; notes: string | null;
  branch: string | null;
  workingDirectory: string;                     // absolute native path
  runtime: {
    kind: 'claude_code';                        // Ollama/API adapters reserved (Phase 3+/5)
    runtimeSessionId: string | null;            // Claude Code native UUIDv4 (F1.5); null until spawn/attach
    claudeVersion: string | null;
    model: string | null;
    machine: string | null; environment: string | null;
  };
  observation: {                                // observed sessions only; null for managed (§6.9)
    channel: 'hooks_and_transcript' | 'hooks_only' | 'transcript_only';
    degraded: boolean;                          // true = transcript tailer detached (reduced fidelity)
    reason: string | null;                      // last parser/tailer error, when degraded
    driftCount: number;                         // parse failures counted by the tailer
    updatedAt: string;
  } | null;
  costUsd: number | null;                       // canonical source: SDK ResultMessage (F1.5)
  tokenUsage: { input: number, output: number, cacheRead: number, cacheWrite: number } | null;
  durationSeconds: number | null;
  resumedFromSessionId: string | null;          // F7: resume-of-completed creates a NEW Session
  clonedFromSessionId: string | null;           // clone/fork lineage (WS3 may merge with the above; API keeps both)
  createdAt: string; startedAt: string | null; completedAt: string | null;
  archivedAt: string | null; updatedAt: string;
}
```

### 6.2 CRUD

| Method & path | Purpose | Notes / errors |
|---|---|---|
| `GET /api/v1/sessions` | Cursor list; filters `?state=`, `?projectId=`, `?sessionType=`, `?repositoryId=`; `order=desc` default | `INVALID_CURSOR` |
| `POST /api/v1/sessions` | Create **managed** Session in state `created` → `201 { data: Session }` | Body below. Observed Sessions are created only by the system (§6.8) |
| `GET /api/v1/sessions/{id}` | Fetch | `NOT_FOUND` |
| `PATCH /api/v1/sessions/{id}` | `{ title?, notes?, projectId? }` | `VALIDATION_FAILED`, `NOT_FOUND` |

```ts
// POST /api/v1/sessions request
{
  projectId: string,
  workingDirectory: string,        // validated to exist; RUNTIME_UNAVAILABLE if CLI path invalid at start
  repositoryId?: string,
  branch?: string,
  title?: string,
  model?: string                   // overrides integrations.claudeCode.defaultModel
}
```

Emits `session.created`.

#### 6.2.1 Launch at capacity — queued, never rejected (B3 / arbitration A2)

Launch respects `maxConcurrentSessions` (F1.5), but **saturation is not an error**. `start` and `resume` always succeed when the transition is otherwise legal; the response reports whether the launch happened now or was deferred:

```ts
// 200 — POST /sessions/{id}/start and POST /sessions/{id}/resume (in-place)
{ data: Session, meta: { launch: 'started' | 'queued' } }
```

- `launch: 'started'` — a slot was free; the runtime spawned/attached and the Session is `running`.
- `launch: 'queued'` — all `maxConcurrentSessions` slots are busy. A **durable `session.launch` job** is enqueued via pg-boss (WS1 §4.3: FIFO, survives Backend restarts). The Session **stays in its pre-launch state** — `created` for `start`, `paused` for in-place `resume` — and no `session.state_changed` is emitted yet. There is no `409` for this condition and no client-side retry loop; `details.reason = 'max_concurrent_sessions'` is withdrawn.

**How the client learns the transition.** When a slot frees, the Backend's `session.launch` consumer performs the launch and the normal F7 events fire: `session.state_changed` (`created → running` or `paused → running`) **plus** `session.started` / `session.resumed`, on the `sessions` and `session:{id}` channels. A client that received `launch: 'queued'` therefore renders a "Queued for launch" affordance derived from `state ∈ { created, paused }` after a successful launch call, and clears it on the next `session.state_changed` for that id. Because relay is best-effort (F6.3 / §14.7), the state is always re-derivable from `GET /sessions/{id}`.

Failure modes are unchanged: an illegal transition is still `409 INVALID_STATE_TRANSITION`, and a spawn failure at dequeue time still moves the Session to `failed` (with `session.failed`) — for a queued launch that outcome arrives as an event, not as the HTTP response, since the response was already returned.

### 6.3 Lifecycle sub-actions (F5.1 / F7)

Every transition below emits `session.state_changed` **plus** the specific event (F7 rule) and appends a timeline entry with trigger `user` — *at the moment the transition actually happens*, which for a queued launch is when the `session.launch` job runs, not when the request returns (§6.2.1). Illegal transitions → `409 INVALID_STATE_TRANSITION` (`details: { from, action }`). Actions inapplicable to `observed` sessions (per WS0 non-blocking finding #2; physical semantics defined by WS1) → `409 OPERATION_NOT_SUPPORTED`. Concurrency saturation is **never** an error (§6.2.1).

| Action | Path | Legal from | Result |
|---|---|---|---|
| Start | `POST /api/v1/sessions/{id}/start` | `created` | `200 { data: Session, meta: { launch: 'started' \| 'queued' } }` — `running` after spawn/attach confirm, or still `created` while queued (§6.2.1); spawn failure → session `failed` + `503 RUNTIME_UNAVAILABLE` |
| Pause | `POST /api/v1/sessions/{id}/pause` | `running` | `200 { data: Session }` (`paused`) |
| Resume (in-place) | `POST /api/v1/sessions/{id}/resume` | `paused` | `200 { data: Session, meta: { launch: 'started' \| 'queued' } }` — `running`, or still `paused` while queued (§6.2.1) |
| Resume (new record) | `POST /api/v1/sessions/{id}/resume` | `completed`, `archived` | `201 { data: Session }` — **new** Session, state `created`, `resumedFromSessionId` set, runtime-native `resume` used at start (F1.5/F7). States never move backward |
| End | `POST /api/v1/sessions/{id}/end` | `running`, `paused` | `200 { data: Session }` (`completed`, trigger `user`) |
| Archive | `POST /api/v1/sessions/{id}/archive` | `completed`, `failed` | `200 { data: Session }` (`archived`) |
| Clone | `POST /api/v1/sessions/{id}/clone` | any state with a `runtimeSessionId` except `archived` | `201 { data: Session }` — new Session, state `created`, `clonedFromSessionId` set; SDK `forkSession: true` at start (F1.5). Body: `{ title?: string }` |

#### 6.3.1 Turn interrupt (no state transition)

**`POST /api/v1/sessions/{id}/interrupt`** — stops the assistant turn currently in flight *without* changing Session state. This backs the `[Stop]` control in WS4 §6.8 / WS5 §5.5 and maps to WS1 §5.1 `interrupt()` on the managed runtime. It is deliberately **not** in the table above: no F7 transition occurs and **no `session.state_changed` is emitted** — the Session remains `running` and is immediately ready for the next prompt.

```ts
// 200 — turn stopped, session still running
{ data: { sessionId: string, messageId: string | null } }   // messageId = the retained partial Message
// Errors: SESSION_NOT_RUNNING (409), NO_TURN_IN_FLIGHT (409),
//         OPERATION_NOT_SUPPORTED (409, observed sessions — MC cannot gate an external CLI)
```

The partial assistant Message is persisted with `status = 'interrupted'` — the same `Message.status` field the API exposes in §6.6 (storage: WS3 `messages.status`) — keeps its assigned `ordinal`, and emits `session.message.appended` carrying `ordinal` and `status`, so the transcript retains the partial turn in conversation order rather than discarding it (the same retention principle as the failure case in WS4 §6.2, and what WS5 §5.5 renders as an "interrupted" marker). `messageId` in the response is that partial Message; it is `null` only if the turn produced no persisted content.

### 6.4 Prompt submission (PRD §4.2)

**`POST /api/v1/sessions/{id}/prompts`** — canonical prompt-transmission endpoint; the WebSocket `prompt` frame (§14.4) is transport-equivalent and produces the same result.

```ts
// Request (max 256 KiB)
{ content: string }
// 202 — user Message persisted; assistant response streams over WS channel session:{id}
{ data: { messageId: string } }
// Errors: SESSION_NOT_RUNNING (409), OPERATION_NOT_SUPPORTED (409, observed sessions), PAYLOAD_TOO_LARGE (413)
```

Emits `session.message.appended` (role `user`) immediately; assistant deltas flow as `session.message.delta_appended` (§14.5), and the final assistant Message emits `session.message.appended` on persist.

**Message status on the prompt path (§6.6).** The user Message is persisted with `status = 'pending'` at acceptance and flips to `'complete'` once the runtime has received it; a second `session.message.appended` for the same `messageId` carries the new status (consumers are idempotent on event `id`, F6.3, and last-writer-wins on message state). If the session is paused or lost before transmission, the Message stays `pending` — it is redisplayed on resume and **never auto-replayed** (WS1 §5.1 cold-pause semantics; storage WS3 §3.11). This is what makes WS4/WS5's "pending prompt" affordance renderable from the API alone.

### 6.5 Live chat flow (managed session)

```mermaid
sequenceDiagram
    participant SPA as Browser (SPA)
    participant HUB as Backend WS hub
    participant API as Backend REST
    participant SDK as Claude Agent SDK

    SPA->>HUB: subscribe { channels: ["session:018f…"] }
    HUB-->>SPA: ack { ok: true }
    SPA->>API: POST /sessions/{id}/prompts { content }
    API-->>SPA: 202 { messageId }
    API->>SDK: query(prompt, resume: runtimeSessionId, includePartialMessages: true)
    HUB-->>SPA: event session.message.appended (user message)
    loop per stream_event (F1.5 / spike §2)
        SDK-->>API: content_block_delta …
        HUB-->>SPA: event session.message.delta_appended
    end
    SDK-->>API: ResultMessage (total_cost_usd, usage)
    API->>API: persist assistant Message + cost/usage
    HUB-->>SPA: event session.message.appended (assistant message)
```

### 6.6 Messages

```ts
type MessageRole = 'user'|'assistant'|'system'|'tool';   // F4.1

interface Message {
  id: string; sessionId: string;
  ordinal: number;                                         // per-session monotonic sequence — THE order (A5)
  role: MessageRole;
  status: 'complete' | 'pending' | 'interrupted';          // WS3 messages.status
  content: Array<
    | { type: 'text', text: string }
    | { type: 'thinking', text: string }
    | { type: 'tool_use', toolUseId: string, toolName: string, input: unknown }
    | { type: 'tool_result', toolUseId: string, output: string, isError: boolean }
  >;
  model: string | null;
  tokenUsage: { input: number, output: number } | null;   // assistant messages only
  runtimeUuid: string | null;                              // transcript line uuid (spike §2), for dedup
  occurredAt: string;                                      // runtime-reported time when available
  createdAt: string;                                       // persisted-at (ingest time) — never an ordering key
}
```

**Ordering contract (B6 / arbitration A5).** `ordinal` is the app-assigned, per-session monotonic sequence (WS3 §3.11, `UNIQUE (session_id, ordinal)`) and is the **only** conversation-order key. Neither `id` (UUIDv7 = ingest time) nor `createdAt`/`occurredAt` orders a transcript: observed sessions ingest through two channels (hooks push + transcript tailing) that can deliver the same burst out of order or with identical timestamps. Gaps in `ordinal` are legal (failed turns); only relative order is meaningful.

**Status vocabulary.** `complete` (normal), `pending` (accepted but not yet transmitted to the runtime — §6.4), `interrupted` (partial assistant turn retained after `POST /sessions/{id}/interrupt` or a mid-turn failure — §6.3.1). Clients must render `pending` and `interrupted` messages, not hide them.

- **`GET /api/v1/sessions/{id}/messages`** — cursor pagination (F5.3), `order=asc` default (ascending `ordinal`). The opaque `?cursor=` encodes `ordinal`, not `id` (§1.2); on WS reconnect, clients pass the cursor for their last known **ordinal** to backfill the gap (§14.7). Filters: `?role=`, `?status=`.
- **`GET /api/v1/messages/{id}`** — single Message. `NOT_FOUND`.

Messages are content-immutable and have no write endpoints (user messages are created via prompt submission, all others by the wrapper/ingest pipeline). `status` is the one mutable field — it advances `pending → complete` / `interrupted` on the runtime's behalf, and each advance re-emits `session.message.appended` for the same `messageId`.

### 6.7 Timeline, export, context package (PRD §4.1, §8.3)

**`GET /api/v1/sessions/{id}/timeline`** — cursor list of lifecycle facts (F7 "recorded with timestamp + trigger"), read directly from `session_events` (WS3 §3.10):

```ts
{ data: Array<{
    id: string, occurredAt: string,
    type: string,                    // F6 event name, verbatim (session_events.type) — the source of truth
    kind: 'state_changed'|'commit_linked'|'prompt_submitted'|'tool_used'|'observation_changed'|'other',
    trigger: 'user'|'system',
    fromState?: SessionState, toState?: SessionState,
    refType?: 'commit'|'message', refId?: string,
    detail?: string
}>, meta: { nextCursor: string|null, limit: number } }
```

**`kind` is a presentation projection of `type`, not a second event vocabulary (resolves WS7 non-blocking N4).** `type` carries the F6 event name unchanged; `kind` exists only so the UI can pick an icon/row template without hard-coding the full catalog. The projection is total and fixed:

| F6 event `type` (from `session_events.type`) | Timeline `kind` |
|---|---|
| `session.state_changed` | `state_changed` |
| `commit.recorded` | `commit_linked` |
| `session.message.appended` with `role = 'user'` | `prompt_submitted` |
| `session.message.appended` with `role = 'tool'` | `tool_used` |
| `session.observation_degraded` | `observation_changed` |
| any other recorded event name | `other` |

`session.created` / `session.started` / `session.paused` / `session.resumed` / `session.completed` / `session.failed` / `session.archived` are **not** given their own `kind`: each is accompanied by `session.state_changed` (F7), which already carries `fromState`/`toState`, so rendering both would double every transition. The `note` kind is **removed** — nothing in the system produced it, and free-form notes live on `Session.notes` (§6.1), not the timeline. `other` is the deliberate forward-compatibility escape hatch: WS3 may append new F6-named rows without breaking this contract, and clients render them from `type` + `detail`.

**`POST /api/v1/sessions/{id}/export`**

```ts
// Request
{ format: 'markdown' | 'json' }
// 200
{ data: { format: string, filename: string, content: string } }
// Errors: NOT_FOUND; CONFLICT if state = created (nothing to export)
```

**`POST /api/v1/sessions/{id}/context-package`** — condensed context for seeding a new session (PRD §4.1).

```ts
// 200
{ data: { content: string /* markdown */, tokenEstimate: number, generatedAt: string } }
```

Both are synchronous in V1 (single user, bounded transcript size); if generation ever exceeds request budgets, they become 202+job without a path change.

### 6.8 Observed-session ingest: hook events (F1.5)

The hooks profile written into `.claude/settings.json` (WS1 installer) registers HTTP hooks that POST to this endpoint. Auth: **bearer API token with scope `ingest`** (§3.3) — cookie auth is rejected here (`FORBIDDEN`).

**`POST /api/v1/hook-events`**

```ts
// Request
{
  hookEventName: 'SessionStart'|'UserPromptSubmit'|'PostToolUse'|'Stop'|'SessionEnd',
  runtimeSessionId: string,        // Claude Code UUIDv4
  transcriptPath: string,          // absolute native path to the session JSONL
  cwd: string,
  occurredAt?: string,
  payload: object                  // hook-specific body (tool name/input/output, prompt, …) — passed through
}
// 204. Errors: UNAUTHORIZED (401), VALIDATION_FAILED (400)
```

Behavior: unknown `runtimeSessionId` + `SessionStart` ⇒ system creates an **observed** Session (`created` → `running` on attach; F7 trigger `system`) and starts transcript tailing (fidelity channel, F1.5); known id ⇒ event is folded into the Session record/timeline; duplicates are deduplicated on `(runtimeSessionId, hookEventName, occurredAt)`. Ingest must be tolerant: unrecognized `payload` shapes are stored raw, never rejected (version-drift rule, F1.5).

### 6.9 Observation fidelity and degradation (B12 / arbitration A9)

Observed sessions run on two channels (F1.5, WS1 §6.3): hooks (push, supported surface) and transcript tailing (fidelity, version-sensitive). When the tailer's parse-drift counter crosses WS1's threshold it detaches and the session continues on **hooks only** — reduced message detail, no state change, no failure. That fact is user-visible (WS5's degraded-fidelity badge) and therefore contractual:

**Current state — `Session.observation`** (§6.1). Present on every `GET /sessions/{id}` and in list responses; `null` for managed sessions. Mapped from WS3 `transcript_tail_states`: `degraded ← degraded`, `driftCount ← drift_count`, `reason ← last_error`, `updatedAt ← updated_at`; `channel` is derived (`hooks_and_transcript` = both attached, `hooks_only` = tailer detached or never attached, `transcript_only` = hooks profile not installed for this session). A client can therefore render the badge **on load**, not only if it happened to be connected when the event fired.

**Transition — one event** (§15.2, F6 grammar and envelope verbatim):

| Event | Fires when | Payload |
|---|---|---|
| `session.observation_degraded` | `observation.degraded` goes false → true (tailer detaches) | `sessionId`, `reason`, `driftCount`, `channel` (the *post*-degradation channel) |

Phase 1, producer `backend`, relayed on `sessions` and `session:{id}`, and appended to the session timeline as `kind: 'observation_changed'` (§6.7). It is **not** an F7 transition: no `session.state_changed` is emitted and the Session state is untouched.

**Degradation is terminal for the life of the Session (WS7 arbitration A11).** There is no `session.observation_restored` event and no re-attachment contract. WS1 §6.3's degradation ladder is one-directional and `transcript_tail_states.degraded` is deliberately sticky across restarts so the badge cannot flap — so a "restored" event would have had no producer. It is also the honest model: re-attaching the tailer would not recover the transcript lines already skipped, so telling the operator fidelity was "restored" would overstate what they are actually seeing. The tail-state row dies with the Session, so the next Session starts clean.

One further deliberate point: this is **not** `sync.failed` — that event belongs to Obsidian sync runs and its `syncRunId` payload is meaningless here (WS1 §6.3 and WS6 §5.4 adopt this name).

---

## 7. Settings (PRD §4.4)

Typed per-category documents, stored in the DB (`settings` / `secret_items`, F4.1); bootstrap settings (`DATABASE_URL`, `MC_HOST`/`MC_PORT`, `MC_ENCRYPTION_KEY`, `MC_DATA_DIR`) are **not** exposed by this API (F8.2). Every successful write emits `setting.updated` and an `audit.entry_recorded` (values of secret fields never appear in audit details).

### 7.1 Secret field semantics (write-only, PRD §4.4)

```ts
// READ shape (always masked):
type SecretFieldRead = { isSet: boolean };
// WRITE shape within a PUT body:
//   string        → set/replace the secret
//   null          → clear the secret
//   field omitted → keep current value unchanged
type SecretFieldWrite = string | null | undefined;
```

### 7.2 Category schemas

```ts
interface GeneralSettings {                             // PUT /api/v1/settings/general
  instanceName: string;
  timezone: string;                                     // IANA name
  dateFormat: string; timeFormat: '24h'|'12h';
  theme: 'dark'|'light';                                // dark default
  defaultLandingPage: 'dashboard'|'projects'|'sessions';
}

interface GithubSettings {                              // PUT /api/v1/settings/integrations/github
  token: SecretField;                                   // PAT
  account: string | null;
  organizations: string[];
  discoveryRoots: string[];                             // absolute native paths
  syncIntervalMinutes: number;                          // 0 = manual only
  workflowMode: 'manual' | 'assisted';                  // PRD §4.3 Workflow Mode; default 'manual' (Phase 1 setting, §5.3)
}

interface ClaudeCodeSettings {                          // PUT /api/v1/settings/integrations/claude-code
  cliPath: string;                                      // absolute path to claude / claude.exe
  defaultModel: string;
  maxConcurrentSessions: number;                        // F1.5 concurrency gate
  costBudget: { dailyUsd: number | null, perSessionUsd: number | null };  // breach → notification type cost_budget_alert
}

interface TelegramSettings {                            // PUT /api/v1/settings/integrations/telegram
  botToken: SecretField; chatId: string | null; enabled: boolean;
}

interface ObsidianSettings {                            // PUT /api/v1/settings/integrations/obsidian
  vaultPath: string | null;                             // absolute native path
  syncMode: 'two_way'|'one_way'|'paused';
  syncIntervalMinutes: number;
  conflictPolicy: 'newer_wins'|'mission_control_wins'|'obsidian_wins'|'manual';
}

interface NotificationsSettings {                       // PUT /api/v1/settings/notifications
  events: { sessionComplete: boolean, sessionFailed: boolean, syncFailed: boolean,
            repositoryProblem: boolean, costBudgetAlert: boolean };
  dailyReport: { enabled: boolean, time: string };      // "HH:mm" in general.timezone
  quietHours: { enabled: boolean, start: string, end: string };
}

interface SecuritySettings {                            // PUT /api/v1/settings/security
  sessionTimeoutMinutes: number;
  auditLogRetentionDays: number;
  allowedOrigins: string[];                             // extra WS/CSRF origins, §14.2 (default [])
}
```

> **Phase 3 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

- `PUT /api/v1/settings/memory` — retention per memory tier, indexed sources (reserved shape).
- `PUT /api/v1/settings/integrations/qdrant` — `{ host, port, apiKey: SecretField, embeddingModel }` (form exists; integration inert until Phase 3).

> **Phase 4 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

- `PUT /api/v1/settings/agents` — `{ defaultRuntime, defaultPermissionTemplate }` (reserved shape).
- `PUT /api/v1/settings/integrations/ollama` — `{ host, port, defaultModel, enabled }` (Phase 3+).

### 7.3 Endpoints

| Method & path | Purpose | Notes / errors |
|---|---|---|
| `GET /api/v1/settings` | All categories, secrets masked → `{ data: { general, integrations: { github, claudeCode, telegram, obsidian, qdrant, ollama }, notifications, memory, agents, security } }` | |
| `GET /api/v1/settings/{category}` | One category (`general`, `notifications`, `memory`, `agents`, `security`) | `NOT_FOUND` for unknown category |
| `PUT /api/v1/settings/{category}` | Full-category replace → `200 { data: <category, masked> }`. Secret fields per §7.1 | `VALIDATION_FAILED` |
| `GET /api/v1/settings/integrations` | All integrations, masked | |
| `PUT /api/v1/settings/integrations/{integration}` | `github`, `claude-code`, `telegram`, `obsidian`, `qdrant`, `ollama` → `200`, masked | `VALIDATION_FAILED`, `NOT_FOUND` |

### 7.4 Test connection (PRD §4.4 + F8.1)

**`POST /api/v1/settings/integrations/{integration}/test-connection`** for `github`, `claude-code`, `telegram`, `obsidian` (Phase 1–2) and `qdrant`, `ollama` (Phase 3+ stubs — routes reserved, return `INTEGRATION_NOT_CONFIGURED` until their phases land).

A completed check is a **200 regardless of outcome** — failure of the *integration* is data, not an API error:

```ts
// 200
{ data: {
    ok: boolean,
    checkedAt: string,
    latencyMs: number | null,
    message: string,                       // "Authenticated as cento007", "Vault path not writable", …
    detail: object | null                  // integration-specific (e.g., github: { scopes: string[] })
} }
// Errors: INTEGRATION_NOT_CONFIGURED (409) if required fields/secrets absent
```

Checks per integration: `github` → authenticated API call with the stored PAT; `claude-code` → `execFile(cliPath, ['--version'])` (F8.1 validation); `telegram` → `getMe` + optional test message; `obsidian` → vault path exists/readable/writable.

### 7.5 Service health (PRD §4.4.7)

**`GET /api/v1/services/health`** — read-only, feeds the Settings → Services view. Per F2.1, the queue row reads **"Queue (PostgreSQL)"** — Redis does not exist in this system.

```ts
// 200
{ data: { services: Array<{
    name: 'backend'|'postgresql'|'queue'|'telegram-worker'|'sync-worker'|'qdrant'|'ollama',
    label: string,                                  // e.g. "Queue (PostgreSQL)"
    status: 'healthy'|'degraded'|'down'|'disabled'|'unknown',
    checkedAt: string,
    detail: string | null,
    meta: object | null                             // e.g. queue: { depth, oldestJobAgeSeconds }; workers: { lastHeartbeatAt }
}> } }
```

How each status is derived (heartbeats, queue depth) is WS1's design; this contract fixes only the shape. `qdrant`/`ollama` report `disabled` until Phase 3+.

### 7.6 Settings key registry — ownership and derivation rule (resolves WS7 non-blocking N10)

WS3 §3.12 defers the question of *which* setting keys exist to "a TypeScript settings registry in `packages/shared`". **WS2 owns that registry** — it is part of this API contract, not a separate document, because the category schemas in §7.2 are its only source. It ships as `packages/shared/src/settings/registry.ts` alongside the Phase 1 backend scaffold; there is no third document to write and no other workstream to wait for.

**Registry entry shape** (one per settable field):

```ts
interface SettingKeyEntry {
  path: string;            // API path within the category document, e.g. 'integrations.github.syncIntervalMinutes'
  category: 'general'|'integrations'|'notifications'|'memory'|'agents'|'security';  // WS3 settings.category CHECK
  key: string;             // DB key (snake_case), unique within category
  valueType: 'string'|'number'|'boolean'|'object'|'array';   // WS3 settings.value_type CHECK
  jsonSchema: object;      // the Fastify/JSON-Schema fragment that validates PUT bodies (F5.1)
  secret: boolean;         // true → stored in secret_items, never in settings; read as { isSet } (§7.1)
  phase: 1|2|3|4;
  default: unknown;        // seeded on first boot
}
```

**Derivation rule (mechanical, so drift is impossible):**

1. **One row per top-level field of a category document.** Nested objects/arrays are stored **whole** as JSONB (`value_type` `object`/`array`) with their inner keys left in camelCase — they are read and written as a unit, so splitting them buys nothing and costs a migration per field.
2. **`key` = `snake_case(field)`**, prefixed with `snake_case(integration)` + `_` for the `integrations` category (which is one DB category holding all integrations).
3. **Secrets never appear in `settings`** — same `(category, key)` coordinates, different table (`secret_items`), matching WS3 §3.13's examples.

| API path (§7.2) | DB `(category, key)` | `value_type` | Secret |
|---|---|---|---|
| `general.timezone` | `('general', 'timezone')` | `string` | no |
| `integrations.github.syncIntervalMinutes` | `('integrations', 'github_sync_interval_minutes')` | `number` | no |
| `integrations.github.workflowMode` | `('integrations', 'github_workflow_mode')` | `string` | no |
| `integrations.github.token` | `('integrations', 'github_token')` | — | **yes** → `secret_items` |
| `integrations.claudeCode.costBudget` | `('integrations', 'claude_code_cost_budget')` | `object` | no |
| `integrations.telegram.botToken` | `('integrations', 'telegram_bot_token')` | — | **yes** → `secret_items` |
| `notifications.quietHours` | `('notifications', 'quiet_hours')` | `object` | no |
| `security.allowedOrigins` | `('security', 'allowed_origins')` | `array` | no |

`setting.updated`'s `changedKeys` (§15.2, event 21) carries **DB keys** from this registry — names only, never values. Bootstrap variables (F8.2) have no registry entries by construction.

### 7.7 Schedule — computed read model (B13 / arbitration A1)

Backs the Dashboard "Upcoming Tasks" widget (PRD §8.1). **No entity, no table, no worker, no event**: every value is derived at read time from settings plus existing rows, and **nothing here is ever persisted**. Changing a setting changes the next read immediately.

**`GET /api/v1/schedule`**

```ts
// 200
{ data: Array<{
    kind: 'obsidian_sync' | 'github_poll' | 'daily_report',
    label: string,                   // display text, e.g. "Obsidian vault sync"
    enabled: boolean,
    nextRunAt: string | null,        // ISO 8601 UTC; null when disabled or interval = 0
    lastRunAt: string | null
}> }
```

Fixed cardinality (three kinds in Phase 1), so no cursor pagination and no `meta` (§1.2). Read-only: there is no POST/PATCH — the operator changes the schedule in Settings, and manual runs use the existing action endpoints (`POST /sync-runs`, `POST /repositories/{id}/sync`).

| `kind` | `enabled` | `lastRunAt` | `nextRunAt` |
|---|---|---|---|
| `obsidian_sync` | `obsidian.vaultPath` set **and** `syncMode ≠ 'paused'` **and** `syncIntervalMinutes > 0` | `completedAt` of the newest `SyncRun` with `kind = 'obsidian'` | `lastRunAt + syncIntervalMinutes`, or `now + syncIntervalMinutes` when there is no prior run |
| `github_poll` | GitHub PAT set **and** `github.syncIntervalMinutes > 0` | `max(repositories.last_synced_at)` | `lastRunAt + syncIntervalMinutes`, or `now + syncIntervalMinutes` when never synced |
| `daily_report` | `notifications.dailyReport.enabled` **and** Telegram enabled | `createdAt` of the newest Notification with `type = 'daily_report'` | next occurrence of `dailyReport.time` in `general.timezone`, converted to UTC |

`enabled: false` ⇒ `nextRunAt: null` (the row is still returned, so the UI can say *why* nothing is scheduled and link to Settings). A computed `nextRunAt` in the past means the run is due/overdue — the endpoint reports the schedule, not the queue, and does not clamp it. Phase 2 kinds (`obsidian_sync`, `daily_report`) are returned from Phase 1 with `enabled: false` until their workers exist, which is what makes the widget honest on day one rather than empty.

---

## 8. Notifications (Phase 2)

```ts
interface Notification {
  id: string;
  type: 'session_completed'|'session_failed'|'sync_failed'|'repository_problem'|'daily_report'|'cost_budget_alert';
  severity: 'info'|'warning'|'error';
  title: string; body: string;                      // pre-rendered text (Telegram + UI share it)
  payload: object | null;                           // entity IDs for deep links; `payload.eventType` = originating F6 event where one exists (A8)
  correlationId: string | null;                     // links to the originating event chain (F6.2)
  readAt: string | null; createdAt: string;         // readAt is the in-app "delivery" state
  telegram: { status: 'skipped'|'pending'|'sent'|'failed', sentAt: string|null, error: string|null };
}
```

**Delivery representation (resolves WS7 non-blocking N5).** The earlier `deliveries[]` array is **removed** in favour of the flat `telegram` object, mirroring WS3 §4.2's `telegram_status` / `telegram_sent_at` / `telegram_error` columns one-to-one. Reasons: the `ui` entry in that array was synthetic — the Notification row *is* the in-app notification, and `readAt` is its only real UI state — and V1 has exactly one outbound channel, so an array modelled a fan-out that does not exist. `status = 'skipped'` means Telegram is disabled or this event type is toggled off (PRD §4.4.3). A future second channel is an additive sibling object (e.g. `email: {…}`), not a re-abstraction. `type` remains the notification-type enum above, **not** an F6 event name (arbitration A8).

| Method & path | Purpose | Notes / errors |
|---|---|---|
| `GET /api/v1/notifications` | Cursor list, newest first; `?unread=true` filter | |
| `GET /api/v1/notifications/{id}` | Fetch | `NOT_FOUND` |
| `POST /api/v1/notifications/{id}/read` | Mark read → `200 { data: Notification }` | Idempotent |
| `POST /api/v1/notifications/read-all` | → `200 { data: { updated: number } }` | |

Creation is system-only (Backend/workers translate events into Notification records per `NotificationsSettings`; Telegram delivery is the Telegram Worker's job, §15).

## 9. Adrs (Phase 2, PRD §7.3)

```ts
interface Adr {
  id: string; projectId: string;
  title: string;
  status: 'proposed'|'accepted'|'superseded'|'rejected';   // 'proposed' is the initial status (A4; WS3 CHECK)
  context: string; decision: string; alternatives: string; consequences: string;  // markdown, PRD template sections
  sourceSessionId: string | null;                  // when generated from a Session
  supersededByAdrId: string | null;
  obsidianPath: string | null; syncedAt: string | null;   // maintained by Sync Worker
  createdAt: string; updatedAt: string;
}
```

| Method & path | Purpose | Notes / errors |
|---|---|---|
| `GET /api/v1/adrs` | Cursor list; filters `?projectId=`, `?status=` | |
| `POST /api/v1/adrs` | Manual create → `201` | `{ projectId, title, context, decision, alternatives, consequences, status? }`; `status` defaults to `proposed` |
| `GET /api/v1/adrs/{id}` | Fetch | `NOT_FOUND` |
| `PATCH /api/v1/adrs/{id}` | Edit fields / change status (supersede sets `supersededByAdrId`) | `VALIDATION_FAILED` |
| `POST /api/v1/sessions/{id}/generate-adr` | AI-drafted ADR from a Session → `202 { data: { jobId: string } }`; Sync Worker produces a `proposed` Adr, emits `adr.created` | `CONFLICT` if session state is `created` |

There is no `draft` status anywhere in this contract: the ADR vocabulary is `proposed → accepted | rejected`, with `superseded` set when a later ADR replaces one (arbitration A4; WS3 §4.1 CHECK). "Draft" as a *verb* — an AI-generated ADR awaiting review — is exactly what `proposed` means.

## 10. Sync runs — Obsidian (Phase 2, PRD §7.1)

```ts
interface SyncRun {
  id: string; kind: 'obsidian';
  state: 'queued'|'running'|'completed'|'failed';
  trigger: 'user'|'schedule';
  startedAt: string | null; completedAt: string | null;
  stats: { notesExported: number, notesImported: number, conflicts: number } | null;
  error: string | null;
  createdAt: string;
}
```

| Method & path | Purpose | Notes / errors |
|---|---|---|
| `POST /api/v1/sync-runs` | Trigger manual sync → `202 { data: SyncRun }` (state `queued`) | `{ kind: 'obsidian' }`; `INTEGRATION_NOT_CONFIGURED` (no vault path), `CONFLICT` (a run already `running`) |
| `GET /api/v1/sync-runs` | Cursor list, newest first | |
| `GET /api/v1/sync-runs/{id}` | Fetch (incl. conflict details when `stats.conflicts > 0`) | `NOT_FOUND` |

Scheduled runs are created by the Sync Worker per `obsidian.syncIntervalMinutes`; both paths emit `sync.started` / `sync.completed` / `sync.failed` / `sync.conflict_detected`.

## 11. Search (Phase 2)

**`GET /api/v1/search?q=<text>&types=sessions,adrs,commits,messages&limit=20`** — keyword search (PostgreSQL FTS; roadmap Phase 2 "search"). Semantic memory search is a Phase 3 concern (§13.1) and does not share this route.

```ts
// 200
{ data: Array<{
    type: 'session'|'adr'|'commit'|'message'|'pull_request',
    id: string, title: string, snippet: string,       // snippet has <mark> highlights
    occurredAt: string, rank: number
}>, meta: { nextCursor: string|null, limit: number } }
```

**Cursor composition (matches WS3 §4.6).** Unlike every other list in this document, the search cursor is **not** a UUIDv7 keyset. Results are a `UNION ALL` across five entity types ordered by relevance, so the cursor encodes the triple **`(rank, occurredAt, id)`** — the same keyset WS3's query pins — base64url-encoded and opaque to clients per F5.3. Ranking uses `ts_rank_cd(search_tsv, query, 32)`, normalized to `(0,1)` precisely so ranks are comparable across the five branches; a cursor is therefore only valid for the `q`/`types` combination that produced it, and a client changing either must restart from the first page.

## 12. AuditLogEntries (PRD §10)

```ts
interface AuditLogEntry {
  id: string; occurredAt: string;       // mapped from audit_log_entries.created_at (append-only table)
  actorType: 'user'|'agent'|'system'; actorId: string | null;   // WS3 CHECK, verbatim; 'agent' lands in Phase 4
  action: string;                       // e.g. 'auth.login', 'setting.updated', 'session.archived', 'token.created'
  entityType: string | null;            // F4 table name, e.g. 'settings', 'sessions'
  entityId: string | null;
  before: object | null;                // relevant field subset; null for creates — secrets always redacted
  after: object | null;                 // relevant field subset; null for deletes — secrets always redacted
  requestId: string | null;             // joins to API logs (F5.4)
}
```

**Shape follows storage (B9 / arbitration A7).** The fields are `audit_log_entries` (WS3 §3.14) in camelCase per F4.3 — `entityType`/`entityId`/`before`/`after`, not the earlier `targetType`/`targetId`/`details`. `actorType` has three values, matching the DB CHECK: **there is no `'token'` actor.** A bearer-token call is still the single local User acting, so it is recorded as `actorType: 'user'` with the acting token identified in the entry payload (`after.apiTokenId` / `after.apiTokenName`, never the token value). Inventing a fourth actor type for an authentication *method* would have created a column the database does not have and a principal the system does not model.

- **`GET /api/v1/audit-log-entries`** — cursor list, newest first; filters `?action=`, `?actorType=`, `?from=`, `?to=`, `?entityType=`, `?entityId=`.
- **`GET /api/v1/audit-log-entries/{id}`** — single entry.

Read-only resource; entries are written by the Backend on auth events, setting changes, token lifecycle, session lifecycle user actions, and git/agent actions (agent actions Phase 4). Retention per `security.auditLogRetentionDays`.

---

## 13. Phase 3–5 Interface Stubs

### 13.1 Memory APIs

> **Phase 3 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

Reserved routes (PRD §12: Search / Store / Delete), no payload detail:

- `POST /api/v1/memory-items/search` — semantic query across memory tiers (Qdrant-backed).
- `POST /api/v1/memory-items` — store a MemoryItem.
- `GET /api/v1/memory-items/{id}` / `DELETE /api/v1/memory-items/{id}` — fetch / delete.
- Reserved event names: `memory.item_stored`, `memory.item_deleted`, `memory.reindexed` (§15.4). Reserved WS channel: `memory`.

### 13.2 Agent APIs

> **Phase 4 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

Reserved routes (PRD §12: Create / Update / Assign / Execute):

- `GET|POST /api/v1/agents`, `GET|PATCH /api/v1/agents/{id}` — Agent CRUD (structure per PRD §5.3).
- `POST /api/v1/agents/{id}/assignments` — assign to project/session.
- `POST /api/v1/agents/{id}/executions` — execute a task via the agent's runtime (permission gating maps onto the F1.5 control surfaces).
- `GET|POST /api/v1/agent-teams`, `GET|PATCH /api/v1/agent-teams/{id}` — AgentTeam CRUD.
- Reserved event names: `agent.created`, `agent.updated`, `agent.assigned`, `agent.execution_started`, `agent.execution_completed`, `agent.execution_failed` (§15.4). Reserved WS channel: `agents`.

---

## 14. WebSocket Protocol — `/api/v1/ws` (F5.6)

Single multiplexed connection per client; JSON text frames; protocol version 1.

### 14.1 Handshake & authentication

Upgrade request to `GET /api/v1/ws`. Two auth paths, mirroring §1.4:

1. **Cookie** (`mc_session`) — the browser path. **Requires Origin validation (§14.2).**
2. **Bearer token** (`Authorization: Bearer mct_…`, scope `full`) — programmatic clients. `ingest`-scoped tokens are rejected (`403 FORBIDDEN`).

Failed auth rejects the upgrade with plain HTTP `401` + the F5.4 error envelope. On success the server completes the upgrade and immediately sends `hello`.

### 14.2 Origin validation (cross-site WebSocket hijacking defense)

`SameSite=Lax` does **not** protect WebSocket upgrades — browsers attach cookies to cross-site WS handshakes. Therefore, for any upgrade that presents a cookie, the Backend enforces an explicit Origin allowlist (resolves WS0 non-blocking finding #3):

**Allowlist construction** (computed at startup, recomputed on `setting.updated` for `security`):

1. The Backend's own canonical origin(s) derived from bootstrap config: `http(s)://{MC_HOST}:{MC_PORT}`, plus the loopback equivalents `http://localhost:{MC_PORT}` and `http://127.0.0.1:{MC_PORT}` when `MC_HOST` binds loopback/wildcard.
2. When `NODE_ENV=development`: the Vite dev-server origin (default `http://localhost:5173`).
3. Entries from `security.allowedOrigins` (§7.2) — DB-stored, so no new bootstrap env var is introduced (the F8.2 variable set stays locked); covers e.g. a future reverse-proxy hostname.

**Enforcement rule at upgrade:**

| Condition | Decision |
|---|---|
| `Origin` present and exactly equal (case-insensitive scheme/host, exact port) to an allowlist entry | Proceed with cookie or bearer auth |
| `Origin` present but not in allowlist — including `Origin: null` | **Reject: HTTP `403`**, code `ORIGIN_NOT_ALLOWED`, before completing the upgrade; log with `requestId` |
| `Origin` absent (non-browser client) | Cookie auth is **not** accepted; require bearer token, else `401 UNAUTHORIZED` |

Matching is exact string comparison of normalized origins (scheme + host + port) — no wildcard or suffix matching. The same allowlist is applied to cookie-authenticated cross-origin REST mutations as defense-in-depth (SameSite=Lax remains the primary REST CSRF control).

### 14.3 Channels

| Channel | Carries (event types per §15) | Phase |
|---|---|---|
| `sessions` | All session lifecycle events across sessions (`session.created`, `session.state_changed`, `session.started`, `session.paused`, `session.resumed`, `session.completed`, `session.failed`, `session.archived`) plus `session.observation_degraded` (§6.9) — powers lists/dashboard | 1 |
| `session:{id}` | Everything for one Session: lifecycle and observation events above scoped to the id, `session.message.appended`, `session.message.delta_appended`, `commit.recorded` (when `sessionId` matches) | 1 |
| `repositories` | `repository.*`, `commit.recorded`, `pull_request.*` | 1 |
| `settings` | `setting.updated`, service-health status changes | 1 |
| `audit` | `audit.entry_recorded` | 1 |
| `notifications` | `notification.created`, `notification.sent`, `notification.failed` | 2 |
| `sync` | `sync.*` | 2 |
| `adrs` | `adr.created`, `adr.updated` | 2 |
| `memory` | reserved | 3 — stub |
| `agents` | reserved | 4 — stub |

Single-user system: any authenticated `full` principal may subscribe to any channel. Limit: 64 concurrent channel subscriptions per connection (`ack { ok: false, error: { code: 'VALIDATION_FAILED' } }` beyond).

### 14.4 Client → server frames

```ts
type ClientFrame =
  | { type: 'subscribe',   id: string, channels: string[] }     // id: client-chosen correlation for the ack
  | { type: 'unsubscribe', id: string, channels: string[] }
  | { type: 'prompt',      id: string, sessionId: string, content: string }  // ≡ POST /sessions/{id}/prompts
  | { type: 'ping',        id?: string };
```

Max client frame size 256 KiB (prompt ceiling, matching §6.4). Malformed/oversized frames get an `error` frame; repeated violations close the socket with code `4000`.

### 14.5 Server → client frames

```ts
type ServerFrame =
  | { type: 'hello', connectionId: string, serverTime: string, protocolVersion: 1 }
  | { type: 'ack',   id: string, ok: true,  channels?: string[], messageId?: string }   // messageId on prompt acks
  | { type: 'ack',   id: string, ok: false, error: { code: string, message: string } }  // e.g. SESSION_NOT_RUNNING
  | { type: 'event', channel: string, event: EventEnvelope }    // F6.2 envelope, verbatim
  | { type: 'pong',  id?: string }
  | { type: 'error', error: { code: string, message: string } };
```

All domain traffic uses `event` frames carrying the F6.2 envelope unchanged (F5.6 "wire frames carry the F6 envelope"). **Streaming deltas** are `event` frames too, with type `session.message.delta_appended` — an *ephemeral, WebSocket-only* event: relayed to `session:{id}` subscribers, never enqueued to pg-boss, never persisted (§15.2). Its payload embeds the runtime's native stream-event fields (spike §2) for fidelity:

```json
{
  "type": "event",
  "channel": "session:018f6b2e-…",
  "event": {
    "id": "018f6b2f-…", "type": "session.message.delta_appended", "schemaVersion": 1,
    "occurredAt": "2026-08-11T14:03:22.412Z", "source": "backend", "correlationId": "018f6b2e-…",
    "payload": {
      "sessionId": "018f6b2e-…", "messageId": "018f6b2f-…",
      "blockIndex": 0,
      "deltaType": "text_delta",              // text_delta | input_json_delta | thinking_delta
      "text": "Refactoring the",              // for text/thinking deltas
      "partialJson": null,                    // for input_json_delta (accumulate client-side)
      "streamEventType": "content_block_delta" // message_start | content_block_start | content_block_delta | content_block_stop | message_delta | message_stop
    }
  }
}
```

### 14.6 Heartbeat & limits

- Server sends protocol pings every 30 s; connection closed after 2 missed pongs. Clients may also send `ping` frames.
- Close codes: `1000` normal, `1001` server restart/shutdown, `4000` protocol violation, `4001` auth session expired or token revoked (client must re-authenticate and reconnect).

### 14.7 Reconnect & refetch-on-reconnect (F6.3)

Relay is **best-effort with no replay** in V1. Any reconnect must be treated as a loss window:

1. Reconnect with exponential backoff + jitter (base 1 s, cap 30 s).
2. On `hello`, re-send `subscribe` for all desired channels (server keeps no subscription state across connections).
3. Refetch current state per channel before trusting new events:
   - `session:{id}` → `GET /sessions/{id}` (state, `observation` fidelity, and — after a queued launch — whether it started) + `GET /sessions/{id}/messages?cursor=<cursor for last known ordinal>` (gap backfill; the cursor is keyed on `ordinal`, §6.6); discard any in-flight delta stream and rely on the final `session.message.appended` + message refetch. Re-read `status` on the last few messages too: `pending → complete` and `interrupted` transitions may have been missed.
   - `sessions` → `GET /sessions?state=running` (+ whatever list filters the view holds); sessions left in `created`/`paused` may be queued for launch (§6.2.1).
   - `notifications` → `GET /notifications?unread=true`.
   - `sync` → `GET /sync-runs?limit=1`; `settings` → `GET /services/health`; `audit`/`adrs`/`repositories` → refetch the visible list.

Consumers must be idempotent on event `id` (F6.3) — duplicates across the reconnect boundary are expected.

---

## 15. Event Catalog (F6)

### 15.1 Envelope & delivery topology

All events use the F6.2 envelope verbatim (`id` UUIDv7, `type`, `schemaVersion: 1`, `occurredAt`, `source`, `correlationId`, `payload`). Payloads carry **entity IDs plus small scalar discriminators only — never full entities**; queue consumers (workers) read current state through the shared data layer (`packages/shared`, F2.2), and WS clients refetch via REST (F6.3). Delivery is at-least-once via pg-boss; producers write the domain change and enqueue in the same PostgreSQL transaction (transactional outbox, F6.3; mechanism pinned by WS3); consumers deduplicate on event `id`.

```mermaid
flowchart LR
    P["Producer<br/>(Backend or Worker)"] -->|"same tx: domain write + enqueue"| PG[("PostgreSQL<br/>domain tables + pg-boss")]
    PG -->|"pg-boss dispatch"| TW["Telegram Worker"]
    PG -->|"pg-boss dispatch"| SW["Sync Worker"]
    P -->|"in-process EventEmitter"| HUB["Backend WS hub"]
    PG -->|"LISTEN/NOTIFY (worker-produced events)"| HUB
    HUB -->|"event frames (best-effort)"| SPA["Subscribed clients"]
```

### 15.2 Catalog — Phases 1–2

Legend — **Queue**: pg-boss consumers (durable, at-least-once). **WS**: relay channels (best-effort). *Notif.* means the consumer decides per `NotificationsSettings` whether to create a Notification.

| # | Event type | Ph | Producer | Payload fields | Queue consumers | WS channels |
|---|---|---|---|---|---|---|
| 1 | `session.created` | 1 | backend | `sessionId`, `projectId`, `sessionType` (`managed`\|`observed`), `trigger` (`user`\|`system`) | — | `sessions` |
| 2 | `session.state_changed` | 1 | backend | `sessionId`, `fromState`, `toState`, `trigger` | — | `sessions`, `session:{id}` |
| 3 | `session.started` | 1 | backend | `sessionId` | — | `sessions`, `session:{id}` |
| 4 | `session.paused` | 1 | backend | `sessionId` | — | `sessions`, `session:{id}` |
| 5 | `session.resumed` | 1 | backend | `sessionId`, `resumedFromSessionId` (null for in-place paused→running) | — | `sessions`, `session:{id}` |
| 6 | `session.completed` | 1 | backend | `sessionId`, `trigger` | telegram-worker *(Notif.: session_completed)* ᴾ² | `sessions`, `session:{id}` |
| 7 | `session.failed` | 1 | backend | `sessionId`, `reason` (short string) | telegram-worker *(Notif.: session_failed)* ᴾ² | `sessions`, `session:{id}` |
| 8 | `session.archived` | 1 | backend | `sessionId`, `trigger` | — | `sessions`, `session:{id}` |
| 9 | `session.message.appended` | 1 | backend | `sessionId`, `messageId`, `role`, `ordinal`, `status` (`complete`\|`pending`\|`interrupted`) | Phase 3 memory indexer (reserved) | `session:{id}` |
| 10 | `session.message.delta_appended` | 1 | backend | see §14.5 — **ephemeral: WS-only, never enqueued, never persisted** | — | `session:{id}` |
| 11 | `session.observation_degraded` | 1 | backend | `sessionId`, `reason`, `driftCount`, `channel` (post-degradation, §6.9) | — | `sessions`, `session:{id}` |
| 13 | `repository.discovered` | 1 | backend / sync-worker ᴾ² | `repositoryId` | — | `repositories` |
| 14 | `repository.synced` | 1 | backend / sync-worker ᴾ² | `repositoryId`, `newCommits` (count), `newPullRequests` (count) | — | `repositories` |
| 15 | `repository.sync_failed` | 1 | backend / sync-worker ᴾ² | `repositoryId`, `reason` | telegram-worker *(Notif.: repository_problem)* ᴾ² | `repositories` |
| 16 | `commit.recorded` | 1 | backend / sync-worker ᴾ² | `commitId`, `repositoryId`, `sessionId` (nullable) | Phase 3 memory indexer (reserved) | `repositories`, `session:{id}` when linked |
| 17 | `pull_request.opened` | 1 | backend / sync-worker ᴾ² | `pullRequestId`, `repositoryId` | — | `repositories` |
| 18 | `pull_request.reviewed` | 1 | backend / sync-worker ᴾ² | `pullRequestId`, `repositoryId` | — | `repositories` |
| 19 | `pull_request.merged` | 1 | backend / sync-worker ᴾ² | `pullRequestId`, `repositoryId` | — | `repositories` |
| 20 | `pull_request.closed` | 1 | backend / sync-worker ᴾ² | `pullRequestId`, `repositoryId`, `reason` (`rejected`\|`superseded`\|`other`) | — | `repositories` |
| 21 | `setting.updated` | 1 | backend | `category`, `integration` (nullable), `changedKeys` (string[] of registry DB keys §7.6, **names only — never values**), `actorId` | telegram-worker + sync-worker (config refresh, F8.2) | `settings` |
| 22 | `audit.entry_recorded` | 1 | backend | `auditLogEntryId`, `action` | — | `audit` |
| 23 | `sync.started` | 2 | sync-worker | `syncRunId`, `trigger` | — | `sync` |
| 24 | `sync.completed` | 2 | sync-worker | `syncRunId`, `notesExported`, `notesImported`, `conflicts` (counts) | — | `sync` |
| 25 | `sync.failed` | 2 | sync-worker | `syncRunId`, `reason` — **Obsidian sync runs only**; observed-session fidelity loss is #11, not this (§6.9) | telegram-worker *(Notif.: sync_failed)* | `sync` |
| 26 | `sync.conflict_detected` | 2 | sync-worker | `syncRunId`, `path` (vault-relative), `resolution` (`newer_wins`\|`mission_control_wins`\|`obsidian_wins`\|`manual_pending`) | — | `sync` |
| 27 | `adr.created` | 2 | backend / sync-worker (generated) | `adrId`, `projectId`, `sourceSessionId` (nullable) | sync-worker (export to vault) | `adrs` |
| 28 | `adr.updated` | 2 | backend | `adrId`, `changedFields` (string[]) | sync-worker (re-export) | `adrs` |
| 29 | `notification.created` | 2 | backend / telegram-worker / sync-worker | `notificationId`, `notificationType`, `severity` | telegram-worker (deliver if enabled + outside quiet hours) | `notifications` |
| 30 | `notification.sent` | 2 | telegram-worker | `notificationId`, `channel` (`telegram`) | — | `notifications` |
| 31 | `notification.failed` | 2 | telegram-worker | `notificationId`, `channel`, `reason` | — | `notifications` |

ᴾ² — producer is the Backend in Phase 1 (on-demand + in-process interval); scheduled polling moves to the Sync Worker in Phase 2 (F2.1). Event names, payloads, and consumers are identical either way; only `source` in the envelope differs.

Notes:
- `session.state_changed` always accompanies the specific lifecycle event (#3–#8) per F7 — same `correlationId`, two envelopes.
- **#11/#12 are not F7 transitions**: observation fidelity changes emit no `session.state_changed` and leave `state` untouched (§6.9). Likewise a *queued* launch (§6.2.1) emits nothing at request time — `session.state_changed` + `session.started`/`session.resumed` fire only when the `session.launch` job actually launches.
- The cost-budget check (PRD §4.4.2) runs in the Backend on `session.completed`/usage updates and produces `notification.created` with `notificationType: 'cost_budget_alert'`; the daily report is a scheduled pg-boss job in the Telegram Worker producing `notification.created` (`daily_report`) — no dedicated event types needed.
- `session.launch` is a **pg-boss job name, not an event** (WS1 §4.3) — it never appears in this catalog and carries no F6 envelope.
- Catalog size: **31 event types across Phases 1–2** (30 durable + 1 ephemeral), plus 9 reserved names below.

### 15.3 Payload example (fully-specified)

```json
{
  "id": "018f6b30-4c2a-7d31-9e44-2f1a09b7c001",
  "type": "session.completed",
  "schemaVersion": 1,
  "occurredAt": "2026-08-11T14:03:22.000Z",
  "source": "backend",
  "correlationId": "018f6b2e-1111-7abc-8def-0123456789ab",
  "payload": { "sessionId": "018f6b2e-1111-7abc-8def-0123456789ab", "trigger": "system" }
}
```

### 15.4 Reserved event names — Phases 3–4

> **Phase 3 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

`memory.item_stored`, `memory.item_deleted`, `memory.reindexed` — producer: backend/sync-worker; consumers TBD in Phase 3 design.

> **Phase 4 — interface only.** This section is a placeholder/extension point.
> Detailed design is out of TDS scope per the project-plan scope guard.

`agent.created`, `agent.updated`, `agent.assigned`, `agent.execution_started`, `agent.execution_completed`, `agent.execution_failed` — producer: backend; consumers TBD in Phase 4 design.

---

## 16. Representative OpenAPI 3.1 Snippet — Sessions

The full `openapi.yaml` is generated from Fastify route schemas (F5.1); this excerpt fixes the canonical patterns (envelopes, cursor pagination, error responses, sub-actions) every other resource follows mechanically.

```yaml
openapi: 3.1.0
info:
  title: Mission Control API
  version: 1.0.0
servers:
  - url: /api/v1
paths:
  /sessions:
    get:
      operationId: listSessions
      summary: List sessions (cursor-paginated)
      parameters:
        - { name: limit,  in: query, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
        - { name: cursor, in: query, schema: { type: string }, description: Opaque cursor from meta.nextCursor }
        - { name: state,  in: query, schema: { $ref: '#/components/schemas/SessionState' } }
        - { name: projectId, in: query, schema: { type: string, format: uuid } }
        - { name: sessionType, in: query, schema: { type: string, enum: [managed, observed] } }
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { type: array, items: { $ref: '#/components/schemas/Session' } }
                  meta: { $ref: '#/components/schemas/ListMeta' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
    post:
      operationId: createSession
      summary: Create a managed Session (state = created)
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [projectId, workingDirectory]
              properties:
                projectId: { type: string, format: uuid }
                workingDirectory: { type: string }
                repositoryId: { type: string, format: uuid }
                branch: { type: string }
                title: { type: string, maxLength: 200 }
                model: { type: string }
      responses:
        '201':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SessionData' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }

  /sessions/{sessionId}:
    parameters:
      - { name: sessionId, in: path, required: true, schema: { type: string, format: uuid } }
    get:
      operationId: getSession
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SessionData' }
        '404': { $ref: '#/components/responses/NotFound' }
    patch:
      operationId: updateSession
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                title: { type: string, maxLength: 200 }
                notes: { type: [string, 'null'] }
                projectId: { type: string, format: uuid }
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SessionData' }
        '400': { $ref: '#/components/responses/BadRequest' }
        '404': { $ref: '#/components/responses/NotFound' }

  /sessions/{sessionId}/start:
    post:
      operationId: startSession
      summary: Start a created session (F7 created→running, or queued at max concurrency)
      description: >
        Never fails on capacity. When all maxConcurrentSessions slots are busy the launch is
        enqueued durably and meta.launch is "queued"; the Session stays in state "created" until
        the launch job runs, and the client learns the transition from session.state_changed on
        the session channel (§6.2.1).
      parameters:
        - { name: sessionId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SessionLaunchResult' }
        '404': { $ref: '#/components/responses/NotFound' }
        '409':
          description: INVALID_STATE_TRANSITION or OPERATION_NOT_SUPPORTED (observed session)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }
        '503':
          description: RUNTIME_UNAVAILABLE (immediate spawn failure)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

  /sessions/{sessionId}/pause:
    post:
      operationId: pauseSession
      summary: Pause a running session (F7 running→paused)
      parameters:
        - { name: sessionId, in: path, required: true, schema: { type: string, format: uuid } }
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/SessionData' }
        '404': { $ref: '#/components/responses/NotFound' }
        '409':
          description: INVALID_STATE_TRANSITION or OPERATION_NOT_SUPPORTED (observed session)
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }

  /sessions/{sessionId}/prompts:
    post:
      operationId: submitPrompt
      summary: Submit a prompt to a running session
      parameters:
        - { name: sessionId, in: path, required: true, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [content]
              properties:
                content: { type: string, maxLength: 262144 }
      responses:
        '202':
          content:
            application/json:
              schema:
                type: object
                required: [data]
                properties:
                  data:
                    type: object
                    required: [messageId]
                    properties:
                      messageId: { type: string, format: uuid }
        '409':
          description: SESSION_NOT_RUNNING or OPERATION_NOT_SUPPORTED
          content:
            application/json:
              schema: { $ref: '#/components/schemas/ErrorEnvelope' }
        '413': { $ref: '#/components/responses/PayloadTooLarge' }

  /sessions/{sessionId}/messages:
    get:
      operationId: listSessionMessages
      summary: Message history (cursor-paginated, ascending by ordinal)
      parameters:
        - { name: sessionId, in: path, required: true, schema: { type: string, format: uuid } }
        - { name: limit,  in: query, schema: { type: integer, minimum: 1, maximum: 200, default: 50 } }
        - { name: cursor, in: query, schema: { type: string }, description: Opaque cursor keyed on ordinal (never id) }
        - { name: role,   in: query, schema: { type: string, enum: [user, assistant, system, tool] } }
        - { name: status, in: query, schema: { type: string, enum: [complete, pending, interrupted] } }
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                required: [data, meta]
                properties:
                  data: { type: array, items: { $ref: '#/components/schemas/Message' } }
                  meta: { $ref: '#/components/schemas/ListMeta' }
        '404': { $ref: '#/components/responses/NotFound' }

components:
  schemas:
    SessionState:
      type: string
      enum: [created, running, paused, completed, failed, archived]   # F7, verbatim
    Session:
      type: object
      required: [id, projectId, sessionType, state, title, workingDirectory, runtime, observation, createdAt, updatedAt]
      properties:
        id: { type: string, format: uuid }
        projectId: { type: string, format: uuid }
        repositoryId: { type: [string, 'null'], format: uuid }
        sessionType: { type: string, enum: [managed, observed] }
        state: { $ref: '#/components/schemas/SessionState' }
        title: { type: string }
        notes: { type: [string, 'null'] }
        branch: { type: [string, 'null'] }
        workingDirectory: { type: string }
        runtime:
          type: object
          required: [kind]
          properties:
            kind: { type: string, enum: [claude_code] }
            runtimeSessionId: { type: [string, 'null'], description: Claude Code native session UUID (v4) }
            claudeVersion: { type: [string, 'null'] }
            model: { type: [string, 'null'] }
            machine: { type: [string, 'null'] }
            environment: { type: [string, 'null'] }
        observation:
          type: [object, 'null']
          description: Observed-session fidelity state; null for managed sessions (§6.9)
          required: [channel, degraded, driftCount, updatedAt]
          properties:
            channel: { type: string, enum: [hooks_and_transcript, hooks_only, transcript_only] }
            degraded: { type: boolean }
            reason: { type: [string, 'null'] }
            driftCount: { type: integer, minimum: 0 }
            updatedAt: { type: string, format: date-time }
        costUsd: { type: [number, 'null'] }
        tokenUsage:
          type: [object, 'null']
          properties:
            input: { type: integer }
            output: { type: integer }
            cacheRead: { type: integer }
            cacheWrite: { type: integer }
        durationSeconds: { type: [integer, 'null'] }
        resumedFromSessionId: { type: [string, 'null'], format: uuid }
        clonedFromSessionId: { type: [string, 'null'], format: uuid }
        createdAt: { type: string, format: date-time }
        startedAt: { type: [string, 'null'], format: date-time }
        completedAt: { type: [string, 'null'], format: date-time }
        archivedAt: { type: [string, 'null'], format: date-time }
        updatedAt: { type: string, format: date-time }
    SessionData:
      type: object
      required: [data]
      properties:
        data: { $ref: '#/components/schemas/Session' }
    SessionLaunchResult:
      type: object
      required: [data, meta]
      properties:
        data: { $ref: '#/components/schemas/Session' }
        meta:
          type: object
          required: [launch]
          properties:
            launch:
              type: string
              enum: [started, queued]
              description: queued = all concurrency slots busy; durable session.launch job enqueued (§6.2.1)
    Message:
      type: object
      required: [id, sessionId, ordinal, role, status, content, occurredAt, createdAt]
      properties:
        id: { type: string, format: uuid }
        sessionId: { type: string, format: uuid }
        ordinal: { type: integer, minimum: 0, description: Per-session conversation order — the sort and cursor key }
        role: { type: string, enum: [user, assistant, system, tool] }
        status: { type: string, enum: [complete, pending, interrupted] }
        content:
          type: array
          items:
            oneOf:
              - type: object
                required: [type, text]
                properties:
                  type: { const: text }
                  text: { type: string }
              - type: object
                required: [type, text]
                properties:
                  type: { const: thinking }
                  text: { type: string }
              - type: object
                required: [type, toolUseId, toolName, input]
                properties:
                  type: { const: tool_use }
                  toolUseId: { type: string }
                  toolName: { type: string }
                  input: {}
              - type: object
                required: [type, toolUseId, output, isError]
                properties:
                  type: { const: tool_result }
                  toolUseId: { type: string }
                  output: { type: string }
                  isError: { type: boolean }
        model: { type: [string, 'null'] }
        tokenUsage:
          type: [object, 'null']
          properties:
            input: { type: integer }
            output: { type: integer }
        runtimeUuid: { type: [string, 'null'] }
        occurredAt: { type: string, format: date-time }
        createdAt: { type: string, format: date-time }
    ListMeta:
      type: object
      required: [nextCursor, limit]
      properties:
        nextCursor: { type: [string, 'null'] }
        limit: { type: integer }
    ErrorEnvelope:
      type: object
      required: [error]
      properties:
        error:
          type: object
          required: [code, message, requestId]
          properties:
            code: { type: string, pattern: '^[A-Z][A-Z0-9_]*$' }
            message: { type: string }
            details: { type: [object, 'null'] }
            requestId: { type: string }
  responses:
    BadRequest:
      description: VALIDATION_FAILED / INVALID_CURSOR
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
    Unauthorized:
      description: UNAUTHORIZED
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
    NotFound:
      description: NOT_FOUND
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
    PayloadTooLarge:
      description: PAYLOAD_TOO_LARGE
      content:
        application/json:
          schema: { $ref: '#/components/schemas/ErrorEnvelope' }
  securitySchemes:
    cookieAuth: { type: apiKey, in: cookie, name: mc_session }
    bearerAuth: { type: http, scheme: bearer, bearerFormat: 'mct_ API token' }
security:
  - cookieAuth: []
  - bearerAuth: []
```

---

## 17. Cross-Workstream Notes & Open Questions

**Foundation conflicts: none.** All names, states, envelopes, and conventions are consumed verbatim from F4–F7. Two elaborations worth flagging for WS7 (both within WS2's mandate, neither amends the Foundation):

1. **`session.message.delta_appended` is an ephemeral, WS-only event** — it uses the F6.2 envelope (satisfying F5.6) but is explicitly excluded from pg-boss and persistence. Recorded in §14.5/§15.2 so the "every event has a durable consumer" check doesn't flag it.
2. **`security.allowedOrigins` is a DB-stored security setting**, not a new bootstrap env var — chosen deliberately to keep the F8.2 variable set locked (resolves the reviewer's WS hijacking finding via §14.2).

Hand-offs:

- **WS1:** physical semantics of `pause`/`resume`/`end` for managed (SDK has no native pause) and observed sessions — the API reserves `OPERATION_NOT_SUPPORTED` (409) for inapplicable cases; hooks-profile installer targets `POST /api/v1/hook-events` with an `ingest`-scoped token; service-health derivation for §7.5. **Two renames to absorb:** §6.3's "`sync.failed`-family diagnostic event" is now `session.observation_degraded` (§6.9), and §5.2's provisional `UNSUPPORTED_FOR_SESSION_TYPE` is `OPERATION_NOT_SUPPORTED` (§1.3). WS1 §4.3's queued launch is now surfaced as `meta.launch` (§6.2.1). Per WS7 arbitration A11 there is **no** re-attachment contract: degradation is terminal for the life of the Session, so WS1 owes no re-attach policy.
- **WS3:** storage this contract now assumes: `messages.ordinal` + `messages.status` (§6.6), `projects.workflow_mode` (§4), `sessions` lineage discriminator behind `resumedFromSessionId`/`clonedFromSessionId` (A6), `sync_runs` (§10), FTS index for §11, `notifications.correlation_id` + `payload`, and the transactional-enqueue mechanism (F6.3 / WS0 finding #4). Field-shape conflicts are resolved in the DB's favour: `AuditLogEntry` (§12), `Notification.telegram` (§8), `Adr.status = 'proposed'` (§9). The settings key registry WS3 §3.12 defers to is specified in §7.6 and owned here. `GET /api/v1/schedule` (§7.7) needs **no** storage.
- **WS4:** reconnect/refetch contract in §14.7 is normative for the client real-time layer; prompt submission may use REST or the WS `prompt` frame — both are canonical. New client-visible surfaces: `meta.launch = 'queued'` (§6.2.1), `Message.ordinal`/`status` (§6.6), `Session.observation` (§6.9), `GET /api/v1/schedule` (§7.7), and the single session-type spelling `sessionType` (§6.1).
- **WS5:** the degraded-fidelity badge reads `Session.observation.degraded` on load and updates on `session.observation_degraded`; it never auto-clears (A11 — degradation is terminal for the Session). The "Queued for launch" state is `state ∈ { created, paused }` after a `meta.launch = 'queued'` response; ADR copy uses `proposed`, never "draft".
- **WS6:** contract tests should be generated against §16's schemas; the error-code registry (§1.3) is the assertion vocabulary. The §7.1 launch-queue tests assert `200` + `meta.launch`, never a 409.

Open questions (non-blocking):

- Whether `POST /sessions/{id}/export` should stream large transcripts as `Content-Disposition` attachments instead of inline JSON — cosmetic; revisit if transcripts exceed the 1 MiB response comfort zone.
- `Message.runtimeUuid` (§6.6) vs WS3's `messages.runtime_message_id`, and `Session.durationSeconds` (§6.1) vs WS3's `duration_ms` (WS7 N2/N3): both are single-field renames/unit notes left untouched in this pass because they were not in the re-dispatch package; either spelling is mechanically mappable in `packages/shared`.
