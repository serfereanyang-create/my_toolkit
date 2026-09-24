/*
 * Process resource sampler — compact port of zcode's processResourceSampler.
 *
 * Samples the process table, attributes rows to a root pid's tree, and derives
 * CPU% from the cputime delta between consecutive samples, normalized so that
 * 100% = every logical core saturated. Baselines expire after a TTL so a
 * recycled pid never inherits an old counter.
 */

const os = require('node:os');
const { execFile } = require('node:child_process');

const CPU_BASELINE_TTL_MS = 60_000;

function run(command, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      resolvePromise(error ? '' : String(stdout ?? ''));
    });
  });
}

/** POSIX `time=` text: `[[dd-]hh:]mm:ss[.cc]` → milliseconds. */
function parseCpuTimeText(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let days = 0;
  let clock = trimmed;
  if (trimmed.includes('-')) {
    const [dayPart, rest] = trimmed.split('-');
    days = Number.parseInt(dayPart, 10) || 0;
    clock = rest;
  }
  const parts = clock.split(':').map((p) => Number.parseFloat(p));
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  return Math.round((((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000);
}

async function readProcessRows() {
  if (process.platform === 'win32') {
    // Kernel/UserModeTime are 100ns units → ms = /10_000; WorkingSetSize is bytes.
    const text = await run('powershell.exe', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "{0}|{1}|{2}|{3}|{4}" -f $_.ProcessId, $_.ParentProcessId, [math]::Floor($_.WorkingSetSize/1kb), [math]::Floor(($_.KernelModeTime+$_.UserModeTime)/10000), $_.Name }',
    ], 8000);
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const fields = line.trim().split('|');
      if (fields.length < 5) continue;
      const [pid, ppid, rssKb, cpuTimeMs, command] = fields;
      const parsedPid = Number.parseInt(pid, 10);
      const parsedPpid = Number.parseInt(ppid, 10);
      if (!Number.isInteger(parsedPid) || !Number.isInteger(parsedPpid)) continue;
      rows.push({
        pid: parsedPid,
        ppid: parsedPpid,
        rssKb: Number.parseInt(rssKb, 10) || 0,
        cpuTimeMs: Number.parseInt(cpuTimeMs, 10) || 0,
        command,
      });
    }
    return rows;
  }
  const text = await run('ps', ['-eo', 'pid=,ppid=,rss=,time=,comm='], 8000);
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5) continue;
    const pid = Number.parseInt(fields[0], 10);
    const ppid = Number.parseInt(fields[1], 10);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    rows.push({
      pid,
      ppid,
      rssKb: Number.parseInt(fields[2], 10) || 0,
      cpuTimeMs: parseCpuTimeText(fields[3]) ?? 0,
      command: fields.slice(4).join(' '),
    });
  }
  return rows;
}

function descendantsOf(rows, rootPid) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const selected = [];
  const queue = [...(byParent.get(rootPid) ?? [])];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.find((r) => r.pid === pid);
    if (row) selected.push(row);
    for (const next of byParent.get(pid) ?? []) queue.push(next.pid);
  }
  return selected;
}

function createResourceSampler(options = {}) {
  const rootPid = options.rootPid ?? process.pid;
  const baselineTtlMs = options.baselineTtlMs ?? CPU_BASELINE_TTL_MS;
  let baseline = null; // { sampleId, cpuTimeSumMs, wallMs, at }

  function summarize(rows, now) {
    const tree = rows.filter((row) => row.pid === rootPid).concat(descendantsOf(rows, rootPid));
    let rssKb = 0;
    let cpuTimeSumMs = 0;
    for (const row of tree) {
      rssKb += row.rssKb;
      cpuTimeSumMs += row.cpuTimeMs;
    }
    let cpuPercent = null;
    if (baseline && baseline.cpuTimeSumMs <= cpuTimeSumMs) {
      const wallDelta = Math.max(1, now - baseline.at);
      const cpuDelta = cpuTimeSumMs - baseline.cpuTimeSumMs;
      // Whole-machine normalization: one saturated core = 100/logicalCores.
      cpuPercent = (cpuDelta / wallDelta) * 100 / os.cpus().length;
    }
    baseline = { cpuTimeSumMs, at: now };
    return {
      pid: rootPid,
      processCount: tree.length,
      cpuPercent: cpuPercent === null ? null : Math.round(cpuPercent * 10) / 10,
      rssKb,
      sampledAt: now,
    };
  }

  return {
    async sample() {
      const now = Date.now();
      if (baseline && now - baseline.at > baselineTtlMs) baseline = null;
      const rows = await readProcessRows();
      return summarize(rows, now);
    },
    reset() {
      baseline = null;
    },
  };
}

module.exports = { createResourceSampler, parseCpuTimeText, readProcessRows, descendantsOf };
