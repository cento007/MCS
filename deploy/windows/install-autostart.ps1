<#
.SYNOPSIS
    Register (or refresh) the scheduled task that starts Mission Control at logon.

.DESCRIPTION
    Autostart on Windows, without registering the apps as Windows services.

    That distinction is deliberate and is the standing rule in this directory's README: the four
    apps run as **ordinary foreground console processes** on Windows, exactly as they do under
    systemd on Ubuntu, so the process contract (F8.1 — foreground, JSON to stdout, nonzero exit
    on fatal error) is the same one in both places. A scheduled task starts that same process; it
    does not wrap it in a service host, and it introduces no supervisor the app must know about.

    **At logon, as you — never as SYSTEM.** Mission Control spawns `claude.exe` and tails
    transcripts under `%USERPROFILE%\.claude\projects\`. Under SYSTEM there is no such profile,
    so managed sessions and the observed-session tailer would both fail in ways that look like
    application bugs. A logon trigger is the correct scope, not a limitation.

    Re-running this is the repair path: the task is replaced, not duplicated.

.PARAMETER TaskName
    Defaults to 'MissionControl'.

.EXAMPLE
    .\deploy\windows\install-autostart.ps1
    .\deploy\windows\install-autostart.ps1 -TaskName MissionControl-Dev
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'MissionControl'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Launcher = Join-Path $PSScriptRoot 'start-mission-control.ps1'

if (-not (Test-Path $Launcher)) { throw "Launcher not found: $Launcher" }

# Resolve a **version-stable** interpreter path, in that order of preference.
#
# `Get-Command pwsh` is deliberately the last pwsh candidate: on a Store install it resolves to
# a version-stamped directory (…\Microsoft.PowerShell_7.6.4.0_x64__…\pwsh.exe). A scheduled task
# stores the literal path, so the next PowerShell update renames that folder out from under it
# and autostart fails at the next logon with nothing in the launcher log — because the launcher
# never ran. The MSI location and the WindowsApps alias both survive upgrades.
$shell = @(
    'C:\Program Files\PowerShell\7\pwsh.exe',
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\pwsh.exe'),
    (Get-Command pwsh -ErrorAction SilentlyContinue).Source,
    (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1

if (-not $shell) { throw 'Neither pwsh nor powershell could be located.' }
Write-Host "[mission-control] interpreter: $shell"

# `-WindowStyle Hidden` is what keeps a console window off the desktop when the task has to fall
# back to an Interactive principal (see below). PowerShell is a console application, so an
# interactive task gives it a window that sits there for the entire life of the server — which is
# the whole session, not a moment. Hidden suppresses it; a brief flash at logon is possible while
# the console host initialises, and that is the price of not requiring elevation.
$action = New-ScheduledTaskAction `
    -Execute $shell `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`"" `
    -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

# `ExecutionTimeLimit 0` = no limit. The default kills a task after three days, which for a
# long-running server reads as an unexplained nightly-ish death.
# `IgnoreNew` means a second logon does not start a second Backend fighting for port 8710.
# `RestartCount 3` covers the one ordering failure the launcher cannot wait out: PostgreSQL
# accepting connections but not yet ready to serve.

# `S4U`, not `Interactive`, and the reason is the console window.
#
# An Interactive principal runs the task **on your desktop**, so PowerShell — a console
# application — gets a visible window that sits there for as long as the server runs. `-Hidden`
# above does not help: it hides the task in the Task Scheduler UI, not the window.
#
# S4U ("service for user") runs as *you*, with your profile loaded, but in a non-interactive
# session — so there is no desktop to draw a window on. That distinction matters here beyond
# tidiness: Mission Control spawns `claude.exe` and reads `%USERPROFILE%\.claude\projects\`, so
# it must run as the user. SYSTEM would hide the window too and break both.
#
# It also runs whether or not you are logged on, which is closer to the "at system startup" this
# was originally asked for.
#
# Limited, not Highest: nothing here needs elevation, and an autostarted server should not hold
# rights it never uses.
$register = {
    param($LogonType)
    $principal = New-ScheduledTaskPrincipal `
        -UserId "$env:USERDOMAIN\$env:USERNAME" `
        -LogonType $LogonType `
        -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description 'Mission Control backend (serves the API and the SPA on MC_PORT).' `
        -Force | Out-Null
}

# S4U needs the "Log on as a batch job" right, which an unelevated shell is refused ("Access is
# denied"). Falling back keeps autostart working rather than failing outright, and says which mode
# it landed in — the two differ in ways you would otherwise discover by accident.
try {
    & $register 'S4U'
    Write-Host '[mission-control] principal: S4U — no console window, and runs whether or not you are logged on'
} catch {
    & $register 'Interactive'
    Write-Host '[mission-control] principal: Interactive + hidden window (S4U needs elevation)'
    Write-Host '[mission-control] for a fully windowless setup that also runs while logged out,'
    Write-Host '[mission-control]   re-run this script from an ELEVATED PowerShell.'
}

Write-Host "[mission-control] registered scheduled task '$TaskName' (at logon, as $env:USERNAME)"
Write-Host "[mission-control] start now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "[mission-control] stop:       Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "[mission-control] remove:     .\deploy\windows\uninstall-autostart.ps1"
Write-Host "[mission-control] logs:       $env:LOCALAPPDATA\MissionControl\launcher-logs"
