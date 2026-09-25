# Minimize every electron.exe top-level window (restore the user's desktop
# after automated screenshots). Uses Get-Process so MainWindowHandle is real.
Add-Type '
using System;
using System.Runtime.InteropServices;
public class WinMin {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
}';
Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  [WinMin]::ShowWindow($_.MainWindowHandle, 6) | Out-Null
  Write-Output ("minimized " + $_.Id)
}
