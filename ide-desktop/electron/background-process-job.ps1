param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$TargetProcessId,
    [Parameter(Mandatory = $true)][string]$ExpectedProfile
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public sealed class YoyBackgroundJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits {
        public long ProcessTime;
        public long JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet;
        public UIntPtr MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority;
        public uint Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters {
        public ulong ReadOperations;
        public ulong WriteOperations;
        public ulong OtherOperations;
        public ulong ReadBytes;
        public ulong WriteBytes;
        public ulong OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory;
        public UIntPtr JobMemory;
        public UIntPtr PeakProcessMemory;
        public UIntPtr PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    private IntPtr handle;

    public YoyBackgroundJob(uint processId, long expectedCreation) {
        IntPtr process = OpenProcess(0x1101, false, processId);
        if (process == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            long creation, exit, kernel, user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (Math.Abs(creation - expectedCreation) > 10) throw new InvalidOperationException("Background process identity changed");
            handle = CreateJobObject(IntPtr.Zero, null);
            if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            var limits = new ExtendedLimits();
            limits.Basic.Flags = 0x2000;
            if (!SetInformationJobObject(handle, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception(Marshal.GetLastWin32Error());
            if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception(Marshal.GetLastWin32Error());
        } catch {
            Dispose();
            throw;
        } finally {
            CloseHandle(process);
        }
    }
    public void Dispose() {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
}
'@
$ownedProcess = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $TargetProcessId"
$profileMarker = [System.IO.Path]::GetFileName($ExpectedProfile)
if ($profileMarker -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') {
    throw 'Invalid background process ownership marker'
}
if (-not $ownedProcess -or -not $ownedProcess.CommandLine.Contains($profileMarker)) {
    throw 'Background process ownership check failed'
}
$creationTime = $ownedProcess.CreationDate.ToUniversalTime().ToFileTimeUtc()
$ownedJob = New-Object YoyBackgroundJob([uint32]$TargetProcessId, [long]$creationTime)
try {
    [Console]::Out.WriteLine('YOY_JOB_READY')
    [Console]::Out.Flush()
    [Console]::In.ReadToEnd() | Out-Null
} finally {
    $ownedJob.Dispose()
}
