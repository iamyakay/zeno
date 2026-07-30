$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut("$env:USERPROFILE\Desktop\ZENO.lnk")
$s.TargetPath = "C:\Users\Ray\ZENO\ZENO.bat"
$s.WorkingDirectory = "C:\Users\Ray\ZENO"
$s.IconLocation = "C:\Users\Ray\ZENO\node_modules\electron\dist\electron.exe,0"
$s.Description = "ZENO personal AI command center"
$s.Save()
Write-Output "shortcut created"
