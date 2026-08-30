$ws = New-Object -ComObject WScript.Shell
$path = 'C:\Users\34516\Desktop\YOYcode IDE 新建.lnk'
$lnk = $ws.CreateShortcut($path)
$lnk.TargetPath = 'C:\Windows\System32\wscript.exe'
$lnk.Arguments = '"C:\Users\34516\ZCodeProject\ide-desktop\YOYcode IDE.vbs"'
$lnk.WorkingDirectory = 'C:\Users\34516\ZCodeProject\ide-desktop'
$lnk.IconLocation = 'C:\Users\34516\ZCodeProject\ide-desktop\node_modules\electron\dist\electron.exe,0'
$lnk.Description = 'Launch YOYcode IDE silently'
$lnk.Save()
