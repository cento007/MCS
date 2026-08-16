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

$RepoRoot       = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Launcher       = Join-Path $PSScriptRoot 'start-mission-control.ps1'
$HiddenLauncher = Join-Path $PSScriptRoot 'start-hidden.vbs'

if (-not (Test-Path $Launcher))       { throw "Launcher not found: $Launcher" }
if (-not (Test-Path $HiddenLauncher)) { throw "Hidden launcher not found: $HiddenLauncher" }

# Interpreter resolution moved into `start-hidden.vbs`, which picks a **version-stable** path at
# run time rather than baking one into the task. That matters: `Get-Command pwsh` on a Store
# install resolves to a version-stamped directory (…\Microsoft.PowerShell_7.6.4.0_x64__…\pwsh.exe),
# and a scheduled task stores the literal path — so the next PowerShell update would rename it out
# from under the task and autostart would fail at the next logon with nothing in the launcher log,
# because the launcher never ran. Resolving inside the VBS makes that class of breakage impossible.

# The task runs `wscript.exe`, not PowerShell directly, and that is the whole no-window story.
#
# PowerShell is a CONSOLE application, so an Interactive task gets a console allocated by Windows
# before PowerShell executes a line — `-WindowStyle Hidden` can only hide it afterwards, which in
# practice still flashes and on some machines leaves a window that stays. `wscript.exe` is a
# GUI-subsystem host with no console at all; `start-hidden.vbs` launches PowerShell from it with
# window style 0, so no console is ever created and there is nothing to hide.
#
# It still blocks for the life of the server (`bWaitOnReturn`), so Task Scheduler sees one
# long-running task rather than one that exits immediately.
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path $wscript)) { throw "wscript.exe not found at $wscript" }

$action = New-ScheduledTaskAction `
    -Execute $wscript `
    -Argument "//nologo `"$HiddenLauncher`"" `
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
    Write-Host '[mission-control] principal: S4U — runs whether or not you are logged on'
} catch {
    & $register 'Interactive'
    Write-Host '[mission-control] principal: Interactive (S4U needs an elevated shell)'
    Write-Host '[mission-control]   no console window either way — wscript.exe hosts the launcher.'
    Write-Host '[mission-control]   re-run this ELEVATED to also keep running while logged out.'
}

Write-Host "[mission-control] registered scheduled task '$TaskName' (at logon, as $env:USERNAME)"
Write-Host "[mission-control] start now:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "[mission-control] stop:       Stop-ScheduledTask  -TaskName $TaskName"
Write-Host "[mission-control] remove:     .\deploy\windows\uninstall-autostart.ps1"
Write-Host "[mission-control] logs:       $env:LOCALAPPDATA\MissionControl\launcher-logs"
