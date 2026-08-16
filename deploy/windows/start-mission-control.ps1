<#
.SYNOPSIS
    Start Mission Control — Backend (API + SPA), Telegram Worker and Sync Worker.

.DESCRIPTION
    The production-shape run story on Windows, and the exact command the autostart task runs.

    Three processes, mirroring the three systemd units on Ubuntu — `mission-control-backend`,
    `mission-control-telegram-worker`, `mission-control-sync-worker`. **The Frontend is not one
    of them**: since the Backend serves `apps/frontend/dist` on its own origin (F2.3) there is no
    Vite, no :5173 and no reverse proxy, which is exactly what "the Frontend has no unit" means.

    Under systemd each unit is supervised independently. One scheduled task cannot be three
    units, so supervision here is deliberately all-or-nothing: if any of the three exits, the
    others are stopped and the task exits nonzero, letting Task Scheduler's restart policy bring
    the whole set back. That is a coarser guarantee than systemd's and is stated rather than
    implied — a worker that quietly died while the Backend stayed up would leave the Dashboard
    reporting a service down with nothing restarting it, which is the failure this shape avoids.

    PostgreSQL, Ollama and Qdrant are NOT started here. The first two run as their own services;
    Qdrant is a standalone binary and is `-WithQdrant`'s job if you want it.

    This script is a launcher and nothing more. It holds no configuration: `.env` at the
    repository root remains the single bootstrap source (TDS 02 §8.2), and no application code
    imports anything from `deploy/`.

.PARAMETER Port
    Overrides MC_PORT for this run only. Handy for testing a second instance without touching
    `.env`; real environment variables take precedence over the file, by design.

.PARAMETER BackendOnly
    Start just the Backend. The workers only matter once Telegram or Obsidian are configured.

.PARAMETER WithQdrant
    Also start Qdrant from -QdrantExe. Off by default: it is third-party, like PostgreSQL, and
    is better installed as a service than supervised by this script.

.PARAMETER QdrantExe
    Path to qdrant.exe. Defaults to C:\qdrant\qdrant.exe.

.PARAMETER NoLogFile
    Write to the console instead of log files. This is what you want when running it by hand.

.EXAMPLE
    .\deploy\windows\start-mission-control.ps1 -NoLogFile
    .\deploy\windows\start-mission-control.ps1 -BackendOnly
#>
[CmdletBinding()]
param(
    [int] $Port,
    [switch] $BackendOnly,
    [switch] $WithQdrant,
    [string] $QdrantExe = 'C:\qdrant\qdrant.exe',
    [switch] $NoLogFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The repository root, derived from this script's own location so the task does not depend on
# where it was invoked from.
$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$SpaIndex = Join-Path $RepoRoot 'apps\frontend\dist\index.html'

function Write-Step($Message) { Write-Host "[mission-control] $Message" }

# The three units, in start order. The Backend is first because it is the sole migration runner
# and the only one that refuses to start against a schema it was not compiled for — letting it
# fail first means the workers never touch a database it has already rejected.
$Services = @(
    @{ Name = 'backend';         Entry = 'apps\backend\dist\main.js' }
    @{ Name = 'telegram-worker'; Entry = 'apps\telegram-worker\dist\main.js' }
    @{ Name = 'sync-worker';     Entry = 'apps\sync-worker\dist\main.js' }
)
if ($BackendOnly) { $Services = $Services | Select-Object -First 1 }

# --- Preflight -------------------------------------------------------------------------------
# Each check below fails with the command that fixes it. The Backend already refuses to start
# against a schema it was not compiled for and says so; these cover the conditions it cannot
# report because it never gets far enough to log anything.

foreach ($svc in $Services) {
    $path = Join-Path $RepoRoot $svc.Entry
    if (-not (Test-Path $path)) { throw "$($svc.Name) is not built ($path). Run: pnpm build" }
    $svc.Path = $path
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
$LogDir   = Join-Path $StateDir 'launcher-logs'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# --- Reclaim our own orphans -------------------------------------------------------------------
#
# `Stop-ScheduledTask` kills the task's PowerShell process and **leaves the children running**,
# still holding MC_PORT. Nothing then reaps them: the next start loses the bind, retries ten times
# and exits nonzero, so "stop, then start" leaves a zombie serving stale code and a task that looks
# like it failed for no reason. Observed exactly that way.
#
# The recorded PIDs are what make this safe. Killing "whatever holds the port" would happily kill
# a `pnpm dev` backend the operator is working in; this only ever kills processes **this script
# started**, and only while they are still alive.
if (Test-Path $PidFile) {
    foreach ($line in (Get-Content $PidFile -ErrorAction SilentlyContinue)) {
        $stalePid = 0
        $value = ($line -split '=')[-1]
        if ([int]::TryParse($value.Trim(), [ref] $stalePid) -and $stalePid -gt 0) {
            $stale = Get-Process -Id $stalePid -ErrorAction SilentlyContinue
            if ($stale -and $stale.ProcessName -in @('node', 'qdrant')) {
                Write-Step "reclaiming orphan from a previous run (PID $stalePid, $($stale.ProcessName))"
                Stop-Process -Id $stalePid -Force -ErrorAction SilentlyContinue
            }
        }
    }
    Start-Sleep -Seconds 2
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

# --- Which URL actually works ------------------------------------------------------------------
#
# Printed rather than assumed, because "which port is the UI on" cost real time once already:
# the SPA moved from Vite's :5173 to the Backend's own port, and nothing said so at the moment
# of starting.
function Read-EnvValue($Name, $Pattern, $Fallback) {
    $fromEnv = [Environment]::GetEnvironmentVariable($Name)
    if ($fromEnv) { return $fromEnv }
    $envFile = Join-Path $RepoRoot '.env'
    if (Test-Path $envFile) {
        $m = Select-String -Path $envFile -Pattern $Pattern | Select-Object -First 1
        if ($m) { return $m.Matches[0].Groups[1].Value }
    }
    return $Fallback
}
$mcHost = Read-EnvValue 'MC_HOST' '^\s*MC_HOST\s*=\s*(.+?)\s*$'  '127.0.0.1'
$mcPort = Read-EnvValue 'MC_PORT' '^\s*MC_PORT\s*=\s*(\d+)\s*$'  '8710'

Write-Step "open http://${mcHost}:${mcPort}   (this serves the UI and the API; there is no :5173)"

Set-Location $RepoRoot

# --- Launch ------------------------------------------------------------------------------------
if (-not $NoLogFile) {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    # Bounded without a rotation daemon: recent starts stay readable and a crash loop does not
    # interleave every attempt into one file.
    Get-ChildItem $LogDir -Filter '*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip 60 | Remove-Item -Force
}

$stamp   = '{0:yyyyMMdd-HHmmss}' -f (Get-Date)
$started = @()

function Start-Unit($Name, $FilePath, $ArgumentList) {
    $common = @{
        FilePath         = $FilePath
        WorkingDirectory = $RepoRoot
        NoNewWindow      = $true
        PassThru         = $true
    }
    if ($ArgumentList) { $common.ArgumentList = $ArgumentList }
    if (-not $NoLogFile) {
        $common.RedirectStandardOutput = Join-Path $LogDir "$Name-$stamp.log"
        $common.RedirectStandardError  = Join-Path $LogDir "$Name-$stamp.err.log"
    }
    # `Start-Process -PassThru` rather than the call operator, purely so the PID is knowable and
    # can be recorded for the reclamation above.
    $p = Start-Process @common
    Write-Step "$Name started (PID $($p.Id))"
    return @{ Name = $Name; Proc = $p }
}

if ($WithQdrant) {
    if (Test-Path $QdrantExe) {
        if (Get-NetTCPConnection -LocalPort 6333 -State Listen -ErrorAction SilentlyContinue) {
            Write-Step 'qdrant already listening on 6333 — leaving it alone'
        } else {
            $started += Start-Unit 'qdrant' $QdrantExe $null
        }
    } else {
        Write-Warning "qdrant not found at $QdrantExe — skipping (memory features will report down)"
    }
}

foreach ($svc in $Services) {
    $started += Start-Unit $svc.Name $node @($svc.Path)
}

Set-Content -Path $PidFile -Encoding ascii -Value ($started | ForEach-Object { "$($_.Name)=$($_.Proc.Id)" })
if (-not $NoLogFile) { Write-Step "logging to $LogDir" }

# --- Supervise -----------------------------------------------------------------------------------
# Poll rather than `Wait-Process`, which waits for *all* of them. The interesting event is the
# first one to exit: at that point the set is no longer what was asked for, so the rest are
# stopped and the task exits nonzero for Task Scheduler's restart policy to act on.
try {
    while ($true) {
        Start-Sleep -Seconds 3
        $dead = $started | Where-Object { $_.Proc.HasExited }
        if ($dead) {
            foreach ($d in $dead) { Write-Step "$($d.Name) exited with code $($d.Proc.ExitCode)" }
            break
        }
    }
} finally {
    foreach ($s in $started) {
        if (-not $s.Proc.HasExited) {
            Write-Step "stopping $($s.Name) (PID $($s.Proc.Id))"
            Stop-Process -Id $s.Proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    # Covers the ordinary stop. A force-kill of this shell skips it, which is exactly the case the
    # PID-file reclamation above exists to clean up on the next start.
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

exit 1
