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

$action = New-ScheduledTaskAction `
    -Execute $shell `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Launcher`"" `
    -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -RestartCount 3 `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
    -MultipleInstances IgnoreNew

# `ExecutionTimeLimit 0` = no limit. The default kills a task after three days, which for a
# long-running server reads as an unexplained nightly-ish death.
# `IgnoreNew` means a second logon does not start a second Backend fighting for port 8710.
# `RestartCount 3` covers the one ordering failure the launcher cannot wait out: PostgreSQL
# accepting connections but not yet ready to serve.

$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

# Limited, not Highest: nothing here needs elevation, and an autostarted server should not hold
# rights it never uses.

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Mission Control backend (serves the API and the SPA on MC_PORT).' `
    -Force | Out-Null

Write-Host "[mission-control] registered scheduled task '$TaskName' (at logon, as $env:USERNAME)"
Write-Host "[mission-control] start now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "[mission-control] stop:       Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "[mission-control] remove:     .\deploy\windows\uninstall-autostart.ps1"
Write-Host "[mission-control] logs:       $env:LOCALAPPDATA\MissionControl\launcher-logs"
