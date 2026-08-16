<#
.SYNOPSIS
    Start Mission Control (Backend + SPA) as one foreground process.

.DESCRIPTION
    The production-shape run story on Windows, and the exact command the autostart task runs.

    Since the Backend serves `apps/frontend/dist` on its own origin (F2.3), there is **one
    process and one port**: no Vite, no :5173, no reverse proxy. That is the same topology the
    three systemd units describe on Ubuntu, which is the point — the dev machine and the server
    do not diverge in how the app is served.

    This script is a launcher and nothing more. It holds no configuration: `.env` at the
    repository root remains the single bootstrap source (TDS 02 §8.2), and no application code
    imports anything from `deploy/`.

.PARAMETER Port
    Overrides MC_PORT for this run only. Handy for testing a second instance without touching
    `.env`; real environment variables take precedence over the file, by design.

.PARAMETER NoLogFile
    Write to the console instead of a log file. This is what you want when running it by hand.

.EXAMPLE
    .\deploy\windows\start-mission-control.ps1 -NoLogFile
#>
[CmdletBinding()]
param(
    [int] $Port,
    [switch] $NoLogFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The repository root, derived from this script's own location so the task does not depend on
# where it was invoked from.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Entry    = Join-Path $RepoRoot 'apps\backend\dist\main.js'
$SpaIndex = Join-Path $RepoRoot 'apps\frontend\dist\index.html'

function Write-Step($Message) { Write-Host "[mission-control] $Message" }

# --- Preflight -------------------------------------------------------------------------------
# Each check below fails with the command that fixes it. The Backend already refuses to start
# against a schema it was not compiled for and says so; these cover the conditions it cannot
# report because it never gets far enough to log anything.

if (-not (Test-Path $Entry)) {
    throw "Backend is not built ($Entry). Run: pnpm build"
}

if (-not (Test-Path $SpaIndex)) {
    # Not fatal — `registerSpa` degrades to an API-only process and logs the same fact — but an
    # autostarted instance whose UI silently 404s is worth naming here rather than in a log file
    # nobody opens.
    Write-Warning "SPA is not built ($SpaIndex). The API will serve; the UI will 404. Run: pnpm build"
}

# PostgreSQL is an Automatic service, but "Automatic" only means it was asked to start — at logon
# it may still be coming up. The Backend's first query is its schema-version check, so losing that
# race exits the process; waiting here turns a startup ordering problem into a few seconds.
$pg = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $pg) {
    Write-Warning 'No postgresql* service found. Continuing — DATABASE_URL may point elsewhere.'
} else {
    $deadline = (Get-Date).AddSeconds(90)
    while ($pg.Status -ne 'Running' -and (Get-Date) -lt $deadline) {
        Write-Step "waiting for $($pg.Name) (status: $($pg.Status))"
        Start-Sleep -Seconds 3
        $pg.Refresh()
    }
    if ($pg.Status -ne 'Running') {
        throw "$($pg.Name) did not reach Running within 90s. Start it and retry."
    }
    Write-Step "$($pg.Name) is running"
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node was not found on PATH.' }

if ($PSBoundParameters.ContainsKey('Port')) { $env:MC_PORT = "$Port" }

$StateDir = Join-Path $env:LOCALAPPDATA 'MissionControl'
$PidFile  = Join-Path $StateDir 'backend.pid'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# --- Reclaim our own orphan ------------------------------------------------------------------
#
# `Stop-ScheduledTask` kills the task's PowerShell process and **leaves node running**, still
# holding MC_PORT. Nothing then reaps it: the next start loses the bind, retries ten times and
# exits nonzero, so "stop, then start" leaves a zombie serving stale code and a task that looks
# like it failed for no reason. Observed exactly that way.
#
# The recorded PID is what makes this safe. Killing "whatever holds the port" would happily kill
# a `pnpm dev` backend the operator is working in; this only ever kills a process **this script
# started**, and only when it is still alive and still the thing on the port.
if (Test-Path $PidFile) {
    $stalePid = 0
    if ([int]::TryParse((Get-Content $PidFile -Raw).Trim(), [ref] $stalePid) -and $stalePid -gt 0) {
        $stale = Get-Process -Id $stalePid -ErrorAction SilentlyContinue
        if ($stale -and $stale.ProcessName -eq 'node') {
            Write-Step "reclaiming orphaned backend from a previous run (PID $stalePid)"
            Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# --- Which URL actually works ----------------------------------------------------------------
#
# Printed rather than assumed, because "which port is the UI on" cost real time once already:
# the SPA moved from Vite's :5173 to the Backend's own port, and nothing said so at the moment
# of starting.
#
# `MC_HOST=127.0.0.1` binds IPv4 loopback only, and Windows resolves `localhost` to `::1` (AAAA)
# ahead of `127.0.0.1` (A) — so `http://[::1]:<port>` is refused. Clients that follow Happy
# Eyeballs (browsers, curl) fall back to IPv4 and `localhost` works anyway; the literal address
# is printed because it is the one that cannot depend on that fallback.
$mcHost = if ($env:MC_HOST) { $env:MC_HOST } else {
    $envFile = Join-Path $RepoRoot '.env'
    if (Test-Path $envFile) {
        $m = Select-String -Path $envFile -Pattern '^\s*MC_HOST\s*=\s*(.+?)\s*$' | Select-Object -First 1
        if ($m) { $m.Matches[0].Groups[1].Value } else { '127.0.0.1' }
    } else { '127.0.0.1' }
}
$mcPort = if ($env:MC_PORT) { $env:MC_PORT } else {
    $envFile = Join-Path $RepoRoot '.env'
    if (Test-Path $envFile) {
        $m = Select-String -Path $envFile -Pattern '^\s*MC_PORT\s*=\s*(\d+)\s*$' | Select-Object -First 1
        if ($m) { $m.Matches[0].Groups[1].Value } else { '8710' }
    } else { '8710' }
}

Write-Step "open http://${mcHost}:${mcPort}   (this serves the UI and the API; there is no :5173)"

Set-Location $RepoRoot

# --- Launch ----------------------------------------------------------------------------------
if ($NoLogFile) {
    Write-Step "starting: $node apps\backend\dist\main.js"
    & $node $Entry
    exit $LASTEXITCODE
}

# Task Scheduler captures no stdout, so the launcher owns the file. Deliberately NOT inside
# MC_DATA_DIR: `deploy/systemd/README.md` states the app manages no log files and keeps no log
# directory there, and that stays true — this is the launcher's file, not the application's.
$LogDir = Join-Path $StateDir 'launcher-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# One start per pair of files, ten kept. Bounded without a rotation daemon, and a crash loop
# stays readable instead of interleaving every attempt into one file.
Get-ChildItem $LogDir -Filter 'backend-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 19 | Remove-Item -Force

$stamp   = '{0:yyyyMMdd-HHmmss}' -f (Get-Date)
$LogFile = Join-Path $LogDir "backend-$stamp.log"
$ErrFile = Join-Path $LogDir "backend-$stamp.err.log"
Write-Step "logging to $LogFile"

# `Start-Process -PassThru` rather than the call operator, purely so the PID is knowable and can
# be recorded for the reclamation above. `Wait-Process` keeps this script in the foreground, so
# Task Scheduler still sees one long-running task rather than one that exits immediately.
$proc = Start-Process -FilePath $node -ArgumentList $Entry `
    -WorkingDirectory $RepoRoot -NoNewWindow -PassThru `
    -RedirectStandardOutput $LogFile -RedirectStandardError $ErrFile

Set-Content -Path $PidFile -Value $proc.Id -Encoding ascii
Write-Step "backend PID $($proc.Id)"

try {
    Wait-Process -Id $proc.Id
} finally {
    # Covers the ordinary stop. A force-kill of this shell skips it, which is exactly the case
    # the PID-file reclamation above exists to clean up on the next start.
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

exit $proc.ExitCode
