Set s = CreateObject("WScript.Shell")
s.CurrentDirectory = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
s.Run """C:\Program Files\nodejs\node.exe"" bons-plans.js", 0, True
