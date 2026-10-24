# One-shot: foreground the host ZCode window, click a window-relative point
# (the sidebar-footer gear opens its settings page), then capture the window
# surface via PrintWindow. All coordinates in PHYSICAL pixels.
param(
  [int]$X = 378,   # gear icon, window-relative (from host-settings.png)
  [int]$Y = 1053,
  [string]$TitleMatch = "ZCode",
  [string]$OutPath = "D:\download\Temp\ui-shots\host-settings2.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinClick {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static List<IntPtr> Found = new List<IntPtr>();
  public static string Needle = "";
  public static bool Cb(IntPtr h, IntPtr lp) {
    if (!IsWindowVisible(h)) return true;
    int len = GetWindowTextLength(h);
    if (len <= 0) return true;
    var sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    if (sb.ToString().IndexOf(Needle, StringComparison.OrdinalIgnoreCase) >= 0) Found.Add(h);
    return true;
  }
}
'@

[WinClick]::SetProcessDPIAware() | Out-Null
[WinClick]::Found.Clear()
[WinClick]::Needle = $TitleMatch
$cb = [WinClick+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$lp)
  if (-not [WinClick]::IsWindowVisible($h)) { return $true }
  $len = [WinClick]::GetWindowTextLength($h)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder($len + 1)
  [WinClick]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  if ($sb.ToString().IndexOf([WinClick]::Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    [WinClick]::Found.Add($h) | Out-Null
  }
  return $true
}
[WinClick]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ([WinClick]::Found.Count -eq 0) { Write-Output "no window"; exit 1 }

$best = $null; $bestArea = 0
foreach ($h in [WinClick]::Found) {
  $r = New-Object WinClick+RECT
  [WinClick]::GetWindowRect($h, [ref]$r) | Out-Null
  $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
}
$r = New-Object WinClick+RECT
[WinClick]::GetWindowRect($best, [ref]$r) | Out-Null

# Foreground, click, settle.
[WinClick]::SetForegroundWindow($best) | Out-Null
Start-Sleep -Milliseconds 400
[WinClick]::SetCursorPos($r.Left + $X, $r.Top + $Y) | Out-Null
Start-Sleep -Milliseconds 150
[WinClick]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # LEFTDOWN
[WinClick]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # LEFTUP
Start-Sleep -Milliseconds 900

# Capture the window surface.
$w = $r.Right - $r.Left; $h2 = $r.Bottom - $r.Top
$bmp = New-Object System.Drawing.Bitmap($w, $h2)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [WinClick]::PrintWindow($best, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("clicked ({0},{1}) rel, saved $OutPath (printwindow={2})" -f $X, $Y, $ok)
