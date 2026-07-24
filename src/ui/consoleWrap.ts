import { execFileSync } from 'node:child_process';

/**
 * Windows consoles soft-wrap long lines at the window edge (feels like bash reflow).
 * Disable ENABLE_WRAP_AT_EOL_OUTPUT so long logical lines stay one line (horizontal scroll).
 * No-op on non-Windows / non-TTY / failure.
 */

const ENABLE_WRAP_AT_EOL_OUTPUT = 0x0002;
let savedMode: number | undefined;
let installed = false;

export function disableConsoleSoftWrap(): boolean {
  if (installed) return savedMode !== undefined;
  if (process.platform !== 'win32' || !process.stdout.isTTY) {
    installed = true;
    return false;
  }
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', powershellGetAndClearWrap()],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 },
    ).trim();
    const mode = Number(out);
    if (Number.isFinite(mode)) {
      savedMode = mode;
      installed = true;
      process.once('exit', restoreConsoleSoftWrap);
      process.once('SIGINT', () => {
        restoreConsoleSoftWrap();
      });
      process.once('SIGTERM', () => {
        restoreConsoleSoftWrap();
      });
      return true;
    }
  } catch {
    // ignore — keep default console wrap
  }
  installed = true;
  return false;
}

export function restoreConsoleSoftWrap(): void {
  if (process.platform !== 'win32' || savedMode === undefined) return;
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', powershellSetMode(savedMode)],
      { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 16 * 1024 },
    );
  } catch {
    // ignore
  } finally {
    savedMode = undefined;
  }
}

function powershellGetAndClearWrap() {
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AicodeConWrap {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleMode(IntPtr h, out uint mode);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint mode);
}
"@
$h = [AicodeConWrap]::GetStdHandle(-11)
$mode = [uint32]0
if (-not [AicodeConWrap]::GetConsoleMode($h, [ref]$mode)) { exit 1 }
$newMode = $mode -band (-bnot [uint32]${ENABLE_WRAP_AT_EOL_OUTPUT})
[void][AicodeConWrap]::SetConsoleMode($h, $newMode)
Write-Output $mode
`.trim();
}

function powershellSetMode(mode: number) {
  return `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AicodeConWrapRestore {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint mode);
}
"@
$h = [AicodeConWrapRestore]::GetStdHandle(-11)
[void][AicodeConWrapRestore]::SetConsoleMode($h, [uint32]${mode})
`.trim();
}
