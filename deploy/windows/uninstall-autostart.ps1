<#
.SYNOPSIS
    Stop and remove the Mission Control autostart task.

.DESCRIPTION
    The reverse of `install-autostart.ps1`, and the reason that script is safe to try: nothing
    here is installed into the system beyond one scheduled task, and one command removes it.

    Leaves the repository, `.env`, the database and the launcher logs untouched.

.EXAMPLE
    .\deploy\windows\uninstall-autostart.ps1
#>
[CmdletBinding()]
param(
    [string] $TaskName = 'MissionControl'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -eq $task) {
    Write-Host "[mission-control] no scheduled task named '$TaskName' — nothing to do"
    return
}

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    Write-Host "[mission-control] stopped '$TaskName'"
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Host "[mission-control] removed scheduled task '$TaskName'"
Write-Host "[mission-control] launcher logs were left in $env:LOCALAPPDATA\MissionControl\launcher-logs"
