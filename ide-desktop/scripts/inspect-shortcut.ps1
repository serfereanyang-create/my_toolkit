$path = 'C:\Users\34516\Desktop\YOYcode IDE 新建.lnk'
if (-not (Test-Path $path)) {
  Write-Output 'MISSING'
  exit 0
}
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut($path)
$s | Select-Object TargetPath, Arguments, WorkingDirectory, IconLocation | Format-List
