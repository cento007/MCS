# Windows 11 development run story (TDS 02 §10)

PostgreSQL runs as a native Windows service; the four apps run as ordinary console
processes. **No Docker, no WSL, no Windows-service registration for the apps.** Parity with
Ubuntu production is structural, not aspirational: the same PostgreSQL-backed queue (F3
removed Redis, so there is no dev substitute to diverge from), the same `.env` shape, the
same foreground/stdout process contract.

This directory holds **notes and optional convenience scripts only**. Nothing here installs
anything or modifies the system, and no application code depends on any of it.

## Prerequisites

| | |
|---|---|
| Node.js | >= 22 (see `.nvmrc`; 26.x is what this repo was scaffolded on) |
| pnpm | 10.x — `corepack enable` or `npm i -g pnpm` |
| PostgreSQL | 17 — `winget install PostgreSQL.PostgreSQL.17`, runs as an auto-start Windows service |
| Git for Windows | >= 2.31 (required by the native `claude.exe` runtime) |
| Claude Code CLI | native `claude.exe`; its path is configurable in Settings and validated by Test Connection |

## First run

```powershell
pnpm install

# 1. Bootstrap config — ONE file, at the repository root (TDS 02 §8.2).
Copy-Item .env.example .env
#    Generate the encryption key and paste it into MC_ENCRYPTION_KEY:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"

# 2. Create the database and role (adjust to taste; run once).
#    From an elevated shell with psql on PATH:
#      psql -U postgres -c "CREATE ROLE mission_control LOGIN PASSWORD '...' CREATEDB;"
#      psql -U postgres -c "CREATE DATABASE mission_control OWNER mission_control;"
#    CREATEDB is only needed to run the integration test tier (`pnpm test:int`), which
#    creates and drops throwaway `mc_test_*` databases (TDS 07 §3.1).

# 3. Apply migrations. Requires PostgreSQL running — the script checks first and tells you
#    what is wrong rather than throwing a stack trace.
pnpm db:migrate

# 4. Create the single local account (F4.1). The database starts empty and
#    POST /api/v1/auth/login is the only public route, so without this there is no way in.
#    The password is read from stdin or MC_BOOTSTRAP_PASSWORD, never from argv.
pnpm auth:create-user --username operator      # prompts, hidden
#    Non-interactive equivalents:
#      $env:MC_BOOTSTRAP_PASSWORD='…'; pnpm auth:create-user --username operator
#      'my passphrase' | pnpm auth:create-user --username operator
```

Re-running step 4 never overwrites the existing account — it reports it and exits nonzero.
Locked out? `pnpm auth:create-user --username operator --reset-password` is the explicit
escape hatch, and it must name the account that already exists.

`MC_DATA_DIR` can be omitted in development: it defaults to `%LOCALAPPDATA%\MissionControl`
and the `exports/`, `hooks/` and `tmp/` subtree is created on first start.

## Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | Backend (`tsx watch`) + Vite dev server (`:5173`), colour-prefixed; Ctrl-C stops both |
| `pnpm dev:workers` | Telegram + Sync workers (Phase 2 — not needed for Phase 1 work) |
| `pnpm --filter @mc/backend dev` | One process, for focused work |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Quality gates; none of them need a database |
| `pnpm test:int` | Integration tier — needs PostgreSQL and `TEST_DATABASE_URL` (TDS 07 §3.1) |
| `pnpm build` | Builds shared, then the apps, then the SPA into `apps/frontend/dist` |

The Vite dev server proxies `/api` to `127.0.0.1:8710` **with WebSocket upgrade proxying**,
so `/api/v1/ws` works through the proxy and the app is same-origin in dev exactly as it is
in production — there is no CORS branch anywhere in the system.

## Windows-specific behaviour worth knowing

- **Ctrl-C arrives as `SIGINT`.** Windows has no true `SIGTERM` delivery, so every process
  wires both signals (`packages/shared` `createShutdownController`). A handler wired only
  to `SIGTERM` would look fine on Ubuntu and hang here.
- **Claude Code transcripts** live under `%USERPROFILE%\.claude\projects\` (or
  `CLAUDE_CONFIG_DIR` if set). The tailer watches individual session files rather than
  large trees, which is the Windows-friendly watching mode.
- **All paths are built with `node:path`** and user-supplied paths are stored as absolute
  native paths. Never hard-code a separator, and never shell out to a platform-specific
  command — git and CLI invocations use `execFile` with an explicit executable path.
