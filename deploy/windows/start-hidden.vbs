' Launch start-mission-control.ps1 with no console window, ever.
'
' Why this file exists, given the launcher is PowerShell:
'
' Task Scheduler runs an Interactive task on your desktop. PowerShell is a CONSOLE application,
' so Windows allocates a console for it before PowerShell runs a single line — which means
' `-WindowStyle Hidden` cannot prevent the window, only hide it after the fact. In practice that
' leaves a visible window at logon, and on some machines one that stays.
'
' `wscript.exe` is a GUI-subsystem host: it is allocated no console at all. Launching PowerShell
' from it with intWindowStyle = 0 means no console is ever created for the child either, so there
' is nothing to flash and nothing to hide.
'
' The alternative is an S4U principal, which runs in a non-interactive session and has the same
' effect *and* survives logout — but registering S4U needs elevation ("Log on as a batch job"),
' and this has to work for an operator who will not run an elevated shell.
'
' bWaitOnReturn = True is load-bearing: it keeps this script running for the life of the server,
' so Task Scheduler sees one long-running task rather than one that exits immediately and takes
' its supervision with it.

Option Explicit

Dim shell, fso, here, launcher, shellExe, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fso   = CreateObject("Scripting.FileSystemObject")

here     = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = fso.BuildPath(here, "start-mission-control.ps1")

If Not fso.FileExists(launcher) Then
    WScript.Echo "start-mission-control.ps1 not found next to this script: " & launcher
    WScript.Quit 1
End If

' Prefer PowerShell 7 at its upgrade-stable locations, then Windows PowerShell. Deliberately not
' resolved from PATH: on a Store install that returns a version-stamped directory which the next
' PowerShell update renames, and a scheduled task stores the literal path.
shellExe = ""
Dim candidates, i
candidates = Array( _
    "C:\Program Files\PowerShell\7\pwsh.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe"), _
    shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe") )

For i = 0 To UBound(candidates)
    If shellExe = "" Then
        If fso.FileExists(candidates(i)) Then shellExe = candidates(i)
    End If
Next

If shellExe = "" Then
    WScript.Echo "No PowerShell interpreter found."
    WScript.Quit 1
End If

command = """" & shellExe & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & launcher & """"

' 0 = hidden, True = wait for it to finish.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
