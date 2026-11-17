Set s = CreateObject("WScript.Shell")
s.CurrentDirectory = "C:\Users\giles\bons-plans"
s.Run """C:\Program Files\nodejs\node.exe"" bons-plans.js", 0, True
