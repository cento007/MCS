<#
.SYNOPSIS
    Stop Mission Control cleanly — the task and the Backend it started.

.DESCRIPTION
    `Stop-ScheduledTask` alone is not enough, and that is the whole reason this exists.

    It terminates the task's PowerShell process and **leaves the node child running**, still
    holding MC_PORT. The next start then loses the bind, retries ten times and exits nonzero —
    so "stop, then start" leaves a zombie serving stale code behind a task that looks like it
    failed for no reason.

    This stops the task *and* the recorded Backend PID. `start-mission-control.ps1` also
    reclaims a stale PID on the way up, so a forgotten stop is self-healing; this is the
    deliberate path for "I want the port back now", e.g. before `pnpm dev`.

    Only ever touches a PID the launcher itself recorded — never "whatever holds the port",
    which would happily kill a dev backend you are working in.

.EXAMPLE
    .\deploy\windows\stop-mission-control.ps1
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'MissionControl'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$PidFile = Join-Path $env:LOCALAPPDATA 'MissionControl\backend.pid'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "[mission-control] stopped scheduled task '$TaskName'"
}

if (Test-Path $PidFile) {
    # One `name=pid` line per unit — Backend, Telegram Worker, Sync Worker, and Qdrant when the
    # launcher was asked to start it.
    foreach ($line in (Get-Content $PidFile -ErrorAction SilentlyContinue)) {
        $parts = $line -split '='
        if ($parts.Count -lt 2) { continue }
        $name = $parts[0].Trim()
        $unitPid = 0
        if ([int]::TryParse($parts[-1].Trim(), [ref] $unitPid) -and $unitPid -gt 0) {
            $proc = Get-Process -Id $unitPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -in @('node', 'qdrant')) {
                Stop-Process -Id $unitPid -Force
                Write-Host "[mission-control] stopped $name (PID $unitPid)"
            }
        }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Milliseconds 800

# Report rather than assume: if something still holds the port it is NOT ours, and saying so is
# more useful than a success message that turns out to be false the moment you try to start.
$port = if ($env:MC_PORT) { [int] $env:MC_PORT } else { 8710 }
$held = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($held) {
    $owner = Get-Process -Id $held.OwningProcess -ErrorAction SilentlyContinue
    Write-Warning "port $port is still held by PID $($held.OwningProcess) ($($owner.ProcessName)) — not started by this launcher (a `pnpm dev` backend?)"
} else {
    Write-Host "[mission-control] port $port is free"
}
