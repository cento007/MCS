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

# --- Launch ----------------------------------------------------------------------------------
if ($PSBoundParameters.ContainsKey('Port')) { $env:MC_PORT = "$Port" }

Set-Location $RepoRoot

if ($NoLogFile) {
    Write-Step "starting: $node apps\backend\dist\main.js"
    & $node $Entry
    exit $LASTEXITCODE
}

# Task Scheduler captures no stdout, so the launcher owns the file. Deliberately NOT inside
# MC_DATA_DIR: `deploy/systemd/README.md` states the app manages no log files and keeps no log
# directory there, and that stays true — this is the launcher's file, not the application's.
$LogDir = Join-Path $env:LOCALAPPDATA 'MissionControl\launcher-logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# One file per start, ten kept. Bounded without a rotation daemon, and a crash loop stays
# readable instead of interleaving every attempt into one file.
Get-ChildItem $LogDir -Filter 'backend-*.log' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 9 | Remove-Item -Force

$LogFile = Join-Path $LogDir ("backend-{0:yyyyMMdd-HHmmss}.log" -f (Get-Date))
Write-Step "logging to $LogFile"

& $node $Entry *>> $LogFile
exit $LASTEXITCODE
