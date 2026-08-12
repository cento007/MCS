# Ubuntu production deployment (TDS 02 §9)

These are **templates**. Nothing in this directory installs itself, touches systemd, or is
imported by application code — that separation is the point (F8.1): the apps start in the
foreground, log JSON to stdout and exit nonzero on a fatal error, which behaves identically
under a dev console and under systemd.

## Three units, no more

| Unit | Process |
|---|---|
| `mission-control-backend.service` | API, auth, session manager, WebSocket hub, **and the built SPA** |
| `mission-control-telegram-worker.service` | notification dispatcher (Phase 2) |
| `mission-control-sync-worker.service` | Obsidian sync, ADR generation, repo polling (Phase 2) |

**The Frontend has no unit.** It is a static build artifact served by the Backend on the
same origin (F2.3) — no nginx, no reverse proxy required in V1. PostgreSQL runs under its
own distro unit. There is **no Redis unit**: F3 eliminated Redis entirely; PostgreSQL is
both the database and the queue substrate, and the Services health view shows
"Queue (PostgreSQL)" where an operator would expect Redis.

## Install layout

| What | Where |
|---|---|
| Code | `/opt/mission-control`, owned by the `missioncontrol` system user |
| Bootstrap env | `/etc/mission-control/mission-control.env`, mode `0600`, `root:missioncontrol` |
| App data (`MC_DATA_DIR`) | `/var/lib/mission-control` |

The env file contains `MC_ENCRYPTION_KEY`, which is why it is `0600` and root-owned. **All
three units load the same file** — one env source, many processes, mirroring the single
root `.env` used in development (TDS 02 §8.2). Its contents are exactly the seven bootstrap
variables from `.env.example`, with `MC_DATA_DIR=/var/lib/mission-control` and
`NODE_ENV=production` set explicitly.

```bash
sudo useradd --system --home /opt/mission-control --shell /usr/sbin/nologin missioncontrol
sudo install -d -o missioncontrol -g missioncontrol /var/lib/mission-control
sudo install -d -o root -g missioncontrol -m 0750 /etc/mission-control
sudo install -o root -g missioncontrol -m 0600 /dev/null /etc/mission-control/mission-control.env
# fill in the env file, then:
sudo cp deploy/systemd/mission-control-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mission-control-backend
```

The Backend binds `127.0.0.1:8710` by default. LAN exposure is an explicit operator choice
via `MC_HOST=0.0.0.0`; nginx and TLS remain optional later hardening, not part of V1.

## Upgrade runbook (TDS 02 §9.2)

```bash
cd /opt/mission-control
git fetch && git checkout <tag>
pnpm install --frozen-lockfile && pnpm build     # includes the SPA into apps/frontend/dist
pnpm db:migrate                                  # BEFORE restart
sudo systemctl restart mission-control-backend \
     mission-control-telegram-worker mission-control-sync-worker
```

Migrations run before the restart and must be backward-compatible with the still-running
old process for those few seconds; for a breaking migration, stop the services first —
this is a single-user system and brief downtime is the default runbook, not a failure.

Consequences by design: a Backend restart fails orphaned `running` managed sessions with
one-click resume-as-new; `paused` sessions and queued jobs survive untouched; workers are
stateless between jobs (at-least-once delivery with idempotent consumers), so a mid-job
restart is safe.

## Logs

stdout only — journald captures per unit. There are no app-managed log files and no log
directory inside `MC_DATA_DIR`.

```bash
journalctl -u mission-control-backend -f
```

Retention is journald's `SystemMaxUse`. Every line carries a correlation key: `requestId`
for HTTP (the same value as the `X-Request-Id` header and the F5.4 error envelope),
`sessionId` on wrapper paths, job id in the workers.

## Backup (TDS 02 §9.3)

- **PostgreSQL** — nightly `pg_dump -Fc mission_control` (whole database, both the `public`
  and vendored `pgboss` schemas), 14 daily + 8 weekly.
- **`MC_DATA_DIR`** — nightly tar of `exports/` and `hooks/`; `tmp/` is disposable.
- **`MC_ENCRYPTION_KEY`** — back up **out of band** (password manager). Without it
  `secret_items` are unrecoverable by design.
- Not ours to back up: git repositories (they have remotes), the Obsidian vault (the user's
  own sync), and `~/.claude` transcripts (runtime-owned, 30-day retention — which is
  exactly why durable session history lives in the `messages` table).
