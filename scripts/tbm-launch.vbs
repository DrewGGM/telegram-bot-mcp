' Launches the daemon supervisor with no visible console window.
' Dropped into the user's Startup folder by install-windows.ps1 when Scheduled
' Task registration is unavailable (it needs elevation on some machines).
Dim shell, fso, here
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
' 0 = hidden window, False = don't wait for it to finish.
shell.Run """" & here & "\tbm-run.cmd""", 0, False
