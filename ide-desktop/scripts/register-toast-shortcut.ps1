# Register a Start Menu shortcut that carries this app's AppUserModelId.
#
# Windows derives a toast banner's app name and icon from the *shortcut* whose
# System.AppUserModel.ID equals the id the process registered (main.cjs:
# app.setAppUserModelId). With no such shortcut the banner has nothing to look
# up, so it prints the raw id as the app name — the "com.yoycode.desktop"
# header — and draws no icon at all.
#
# WScript.Shell can create the .lnk but cannot write the AppUserModelId, so the
# property is set through IPropertyStore. Idempotent: re-running overwrites the
# same shortcut.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/register-toast-shortcut.ps1
#
param(
  [string]$AppId = 'com.yoycode.desktop',
  [string]$DisplayName = 'YOYcode IDE'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root 'YOYcode IDE.vbs'
$icon = Join-Path $root 'resources\icon.ico'

# Prefer the installed Electron binary, fall back to the dev dependency.
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) { $electron = $null }

$programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
$linkPath = Join-Path $programs "$DisplayName.lnk"

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($linkPath)
if (Test-Path $launcher) {
  # Same entry point as the desktop shortcut: wscript runs the hidden launcher.
  $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $lnk.Arguments = '"' + $launcher + '"'
} elseif ($electron) {
  $lnk.TargetPath = $electron
  $lnk.Arguments = '"' + $root + '"'
} else {
  throw 'Neither the VBS launcher nor electron.exe was found; nothing to register.'
}
$lnk.WorkingDirectory = $root
$lnk.Description = 'YOYcode IDE'
if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
$lnk.Save()

# System.AppUserModel.ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AumidStore
{
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        int GetCount(out uint props);
        int GetAt(uint index, out PROPERTYKEY key);
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        int Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY
    {
        public Guid fmtid;
        public uint pid;
    }

    // PROPVARIANT for VT_LPWSTR: 2-byte type, 6 bytes of padding, then the
    // pointer in the union. Zeroed VT_EMPTY reads back as "not set".
    [StructLayout(LayoutKind.Sequential)]
    struct PROPVARIANT
    {
        public ushort vt;
        public ushort r1;
        public ushort r2;
        public ushort r3;
        public IntPtr p;
        public int p2;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHGetPropertyStoreFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr reserved,
        int flags,
        ref Guid iid,
        out IPropertyStore store);

    const int GPS_READWRITE = 2;
    const ushort VT_LPWSTR = 31;

    public static void SetAumid(string path, string aumid)
    {
        Guid iid = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        IPropertyStore store;
        int hr = SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, GPS_READWRITE, ref iid, out store);
        if (hr != 0) { throw new System.ComponentModel.Win32Exception(hr); }
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        key.pid = 5;
        PROPVARIANT value = new PROPVARIANT();
        value.vt = VT_LPWSTR;
        value.p = Marshal.StringToCoTaskMemUni(aumid);
        try
        {
            hr = store.SetValue(ref key, ref value);
            if (hr != 0) { throw new System.ComponentModel.Win32Exception(hr); }
            hr = store.Commit();
            if (hr != 0) { throw new System.ComponentModel.Win32Exception(hr); }
        }
        finally
        {
            Marshal.FreeCoTaskMem(value.p);
            Marshal.ReleaseComObject(store);
        }
    }
}
'@

[AumidStore]::SetAumid($linkPath, $AppId)
Write-Output "registered $linkPath -> $AppId"
