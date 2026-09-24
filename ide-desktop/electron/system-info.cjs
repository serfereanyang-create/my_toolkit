/*
 * System diagnostics snapshot — compact port of zcode's systemService.
 * One IPC call that answers "what is this app running on": versions, CPU,
 * memory, disk free space, and the git binary version. Disk free uses .NET
 * DriveInfo via PowerShell (Get-Volume output is locale-dependent).
 */

const os = require('node:os');
const { execFile } = require('node:child_process');

function run(command, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      resolvePromise(error ? '' : String(stdout ?? '').trim());
    });
  });
}

async function gitVersion() {
  const out = await run('git', ['--version'], 5000);
  return out || null;
}

async function diskFreeBytes(driveLetter) {
  if (process.platform !== 'win32') {
    const out = await run('df', ['-k', '/'], 5000);
    const line = out.split('\n').find((l) => l.startsWith('/'));
    if (!line) return null;
    const availableKb = Number.parseInt(line.trim().split(/\s+/)[3], 10);
    return Number.isInteger(availableKb) ? availableKb * 1024 : null;
  }
  const letter = driveLetter ?? 'C:';
  const script = `[System.IO.DriveInfo]::new('${letter}').AvailableFreeSpace`;
  const out = await run('powershell.exe', ['-NoProfile', '-Command', script], 8000);
  const bytes = Number.parseInt(out, 10);
  return Number.isFinite(bytes) ? bytes : null;
}

async function collectSystemInfo(options = {}) {
  const electronVersion = options.electronVersion ?? null;
  const [git, driveFree] = await Promise.all([
    gitVersion(),
    diskFreeBytes(options.driveLetter),
  ]);
  return {
    collectedAt: new Date().toISOString(),
    platform: process.platform,
    osRelease: os.release(),
    osType: os.type(),
    locale: process.env.LANG ?? process.env.LC_ALL ?? null,
    cpuModel: os.cpus()[0]?.model ?? null,
    cpuCores: os.cpus().length,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
    hostname: os.hostname(),
    nodeVersion: process.versions.node,
    electronVersion,
    gitVersion: git,
    driveFreeBytes: driveFree,
    uptimeSeconds: Math.round(os.uptime()),
  };
}

module.exports = { collectSystemInfo, diskFreeBytes, gitVersion };
