Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@

$targets = Get-Process | Where-Object {
  $_.ProcessName -like '*科研*' -and $_.MainWindowHandle -ne [IntPtr]::Zero
}

if (-not $targets) {
  Write-Output "NO_MAIN_WINDOW"
  exit 1
}

foreach ($p in $targets) {
  $h = $p.MainWindowHandle
  if ([WinFocus]::IsIconic($h)) {
    [WinFocus]::ShowWindow($h, 9) | Out-Null
  } else {
    [WinFocus]::ShowWindow($h, 5) | Out-Null
  }
  [WinFocus]::MoveWindow($h, 40, 40, 1360, 860, $true) | Out-Null
  [WinFocus]::BringWindowToTop($h) | Out-Null
  $ok = [WinFocus]::SetForegroundWindow($h)
  Write-Output "Activated=$ok Id=$($p.Id) Handle=$h Title=$($p.MainWindowTitle)"
}
