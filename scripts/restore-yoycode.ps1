param([int]$ProcId = 34108)
$sig = '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'
Add-Type -MemberDefinition $sig -Name Win32 -Namespace Native | Out-Null
$proc = Get-Process -Id $ProcId -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output "NO PROCESS $ProcId"; exit }
$h = $proc.MainWindowHandle
# SW_RESTORE = 9
[void][Native.Win32]::ShowWindowAsync($h, 9)
Start-Sleep -Milliseconds 600
Write-Output "restored handle=$h"
