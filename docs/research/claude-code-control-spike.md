# Research Spike: Programmatic Claude Code Session Control

- **Date:** 2026-08-11
- **Author:** claude-code-guide research agent (orchestrated)
- **Feeds:** TDS foundation decision F1 (Claude Code wrapper approach), WS1 (service architecture), WS2 (API/events)
- **Sources:** official docs at code.claude.com (headless, cli-reference, sessions, hooks, agent-sdk/*, permission-modes, costs, desktop)

## 1. Headless / programmatic modes

Supported ways to drive Claude Code non-interactively:

1. **CLI print mode** — `claude -p "prompt" [options]`; runs non-interactively, exits when done (exit code 0/non-zero). Pipe-friendly.
2. **Output formats** — `--output-format text | json | stream-json`. `json` returns result + session ID + cost + usage metadata; `stream-json` emits newline-delimited JSON events for real-time streaming. `--input-format stream-json` enables bidirectional streaming.
3. **Agent SDK** — `@anthropic-ai/claude-agent-sdk` (TypeScript) / `claude-agent-sdk` (Python). Full agentic loop with built-in tools (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch), context management, sessions, hooks, subagents, MCP integration; async-generator streaming per turn.

**Recommendation for a long-running bidirectional-chat service: the Agent SDK.** Native streaming via `include_partial_messages`, automatic session persistence to disk (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`), full control over permissions/hooks/tools, cost per session on the result message. Self-hosted (Anthropic does not host SDK apps). A raw-CLI `stream-json` wrapper is a viable simpler fallback.

## 2. Streaming

CLI: `claude -p "query" --output-format stream-json --verbose --include-partial-messages`. Each line is a JSON event mirroring Claude API stream events:

- Event types: `message_start`, `content_block_start`, `content_block_delta` (with `text_delta` or `input_json_delta`), `content_block_stop`, `message_delta` (stop reason + usage), `message_stop`.
- Wrapper-level line types: `system` (init, capabilities), `assistant`, `user`, `stream_event`, `result`; lines carry `session_id`, `uuid`, `parent_tool_use_id`.
- Tool calls stream incrementally as `input_json_delta` — accumulate partial JSON.

SDK (TS): iterate `query({ ..., options: { includePartialMessages: true } })`, handle `message.type === "stream_event"` and text deltas. Python equivalent via `StreamEvent`.

## 3. Session lifecycle

- Sessions persist as JSONL: `~/.claude/projects/<project>/<session-id>.jsonl` where `<project>` is the working-directory path with non-alphanumerics mapped to `-`. Location configurable via `CLAUDE_CONFIG_DIR`. Session ID = UUID v4.
- Resume: `claude --continue` (most recent), `claude --resume <session-id>` (specific), `claude -p "..." --continue` (non-interactive), `--fork-session` to branch. SDK: `resume=<id>`, `fork_session=True`, `continue_conversation=True`; capture the session ID from the `ResultMessage`.
- Full context restores on resume (history, model, permission mode). Cross-directory resume supported.
- Transcript retention defaults to 30 days (`cleanupPeriodDays` setting).
- Cross-machine: copy the JSONL, or the SDK `SessionStore` adapter for shared storage.

## 4. Observing external (user-launched) sessions

1. **Transcript tailing** — tail the session JSONL. Caveat: format is internal and may change between Claude Code versions; treat the tailer as a version-sensitive adapter.
2. **Hooks as an observation channel** — configure in `.claude/settings.json` (project) or `~/.claude/settings.json` (user): `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse` (can block/approve), `PostToolUse`, `PostToolUseFailure`, `Stop`, `CwdChanged`, `FileChanged`. Hooks can be HTTP type posting JSON (tool name/input/output, `session_id`, `transcript_path`, project path) to a local backend endpoint — this is the natural push channel for Mission Control's observed sessions.
3. **Direct queries against a session** — `claude -p --resume <session-id> --output-format json "summarize this session"`.

## 5. Control surfaces

- **Permission modes:** `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` (`--permission-mode <mode>`; `--dangerously-skip-permissions` only for isolated environments).
- **Tool control:** `--allowedTools`, `--disallowedTools`, `--tools` (e.g., `Bash(git *)` patterns); settings `permissions.allow/deny/ask` rules; `PreToolUse` hooks returning `permissionDecision: allow|deny|ask` for programmatic gating (this maps directly to PRD agent permissions).
- **MCP injection:** `--mcp-config <file>`. **Model:** `--model`, `--fallback-model`. **Working dirs:** `--add-dir`; `--bare` skips hooks/skills/plugins/MCP for clean runs.

## 6. Cost & usage tracking

- `--output-format json` result includes `total_cost_usd`, `usage` (input/output/cache tokens), `usage_by_model`.
- `stream-json` `message_delta` events carry incremental usage.
- SDK: `ResultMessage.total_cost_usd` / `.usage`.
- OTEL export via `OTEL_EXPORTER_OTLP_ENDPOINT` for fleet-level observability.

## 7. Multi-session constraints

- Many concurrent `claude` processes are fine; per-session JSONL, atomic line appends, no file-lock contention; shared settings files are read-safe; auth via keychain or `ANTHROPIC_API_KEY` is concurrency-safe.
- Real limits are Anthropic-plan rate limits (rolling windows); handle stop reasons like budget/limit errors with backoff/queueing. Track session IDs in the Mission Control database.

## 8. Windows 11 specifics

- Native `claude.exe`; requires Git for Windows (≥2.31). No WSL/Docker required.
- PowerShell and Git-Bash both supported; session storage under `%USERPROFILE%\.claude\projects\` (or `CLAUDE_CONFIG_DIR`).
- PowerShell tool auto-enabled on Windows with its own permission rules.
- File-watcher hooks work but are less efficient than Linux inotify — avoid watching large trees.
- Redis reminder (consistent with PRD): no official native Windows build; use a Windows-compatible substitute or make the dependency soft in dev.

## Recommendation for Mission Control's wrapper architecture

**Hybrid: Agent SDK for managed sessions + hooks/transcript-tailing for observed sessions.**

- **Managed sessions:** backend service embeds the Agent SDK (language per foundation decision F1); session CRUD, streaming to the browser, permission control, per-session cost from result messages; session IDs stored in PostgreSQL.
- **Observed sessions:** ship a small settings/hooks profile that POSTs `SessionStart`/`PostToolUse`/`Stop`/`SessionEnd` events to the backend; tail transcript JSONL as the fidelity channel behind a version-tolerant parser.

Key risks: transcript format drift between Claude Code versions (isolate in an adapter); hook installation UX (provide an installer that writes `.claude/settings.json`); Anthropic rate limits under many concurrent sessions (queue + backoff); cost capture differs between CLI and SDK paths (standardize on SDK for managed).
