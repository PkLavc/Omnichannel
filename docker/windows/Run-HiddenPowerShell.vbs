Option Explicit

Dim shell, command, argument, exitCode
Set shell = CreateObject("WScript.Shell")
command = "powershell.exe"

For Each argument In WScript.Arguments
  If InStr(argument, Chr(34)) > 0 Then
    WScript.Quit 87
  End If
  command = command & " " & Chr(34) & argument & Chr(34)
Next

' Window style 0 keeps the child completely invisible. Waiting preserves the
' real PowerShell exit code and lets Task Scheduler enforce IgnoreNew.
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
