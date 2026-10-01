' Opens the Muster app without a console window. Runs Muster.cmd hidden, which rebuilds Muster
' first when its code changed. Used by the shortcuts from make-shortcuts.ps1.
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = root
sh.Run """" & root & "\Muster.cmd""", 0, False
