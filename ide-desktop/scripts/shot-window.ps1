# Capture a specific top-level window's full surface via PrintWindow
# (PW_RENDERFULLCONTENT), which works even when part of the window is off
# screen. Falls back to a screen-rect grab if PrintWindow fails.
param(
  [string]$TitleMatch = "ZCode",
  [string]$OutPath = "D:\download\Temp\ui-shots\host-window.png"
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinCap {
  // Without this, GetWindowRect returns DPI-virtualized coordinates and the
  // bitmap clips the bottom of the window (where the composer lives).
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
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

[WinCap]::SetProcessDPIAware() | Out-Null
[WinCap]::Found.Clear()
[WinCap]::Needle = $TitleMatch
$cb = [WinCap+EnumWindowsProc]{
  param([IntPtr]$h, [IntPtr]$lp)
  if (-not [WinCap]::IsWindowVisible($h)) { return $true }
  $len = [WinCap]::GetWindowTextLength($h)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder($len + 1)
  [WinCap]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
  if ($sb.ToString().IndexOf([WinCap]::Needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    [WinCap]::Found.Add($h) | Out-Null
  }
  return $true
}
[WinCap]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ([WinCap]::Found.Count -eq 0) { Write-Output "no window matching '$TitleMatch'"; exit 1 }

# Pick the largest visible match (the main app window).
$best = $null; $bestArea = 0
foreach ($h in [WinCap]::Found) {
  $r = New-Object WinCap+RECT
  [WinCap]::GetWindowRect($h, [ref]$r) | Out-Null
  $area = ($r.Right - $r.Left) * ($r.Bottom - $r.Top)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
}
$r = New-Object WinCap+RECT
[WinCap]::GetWindowRect($best, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h2 = $r.Bottom - $r.Top
Write-Output ("window rect: {0}x{1} at ({2},{3})" -f $w, $h2, $r.Left, $r.Top)

$bmp = New-Object System.Drawing.Bitmap($w, $h2)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# PW_RENDERFULLCONTENT = 2 — asks the window to render its full surface.
$ok = [WinCap]::PrintWindow($best, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
$dir = Split-Path -Parent $OutPath
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("saved $OutPath (printwindow={0})" -f $ok)
