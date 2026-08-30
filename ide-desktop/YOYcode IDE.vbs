Option Explicit

Dim shell, fso, cwd, electronBin, launcher, command, exitCode, logPath, message
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

cwd = fso.GetParentFolderName(WScript.ScriptFullName)
electronBin = cwd & "\node_modules\electron\dist\electron.exe"
launcher = cwd & "\scripts\launch-latest.cjs"

If Not fso.FileExists(electronBin) Then
  Call shell.Popup("YOYcode IDE cannot start: electron runtime is missing." & vbCrLf & electronBin, 15, "YOYcode IDE", 16)
  WScript.Quit 1
End If

' Run the build-aware launcher through Electron's Node runtime.
' launch-latest.cjs automatically rebuilds cli/dist and desktop/dist
' if any source file is newer than the last build output.
command = "cmd.exe /c cd /d """ & cwd & """ && set ELECTRON_RUN_AS_NODE=1 && """ & electronBin & """ """ & launcher & """"
exitCode = shell.Run(command, 0, True)

If exitCode <> 0 Then
  logPath = cwd & "\.aicode\launcher-error.log"
  message = "YOYcode IDE failed to launch." & vbCrLf & "See: " & logPath
  Call shell.Popup(message, 10, "YOYcode IDE", 16)
End If
