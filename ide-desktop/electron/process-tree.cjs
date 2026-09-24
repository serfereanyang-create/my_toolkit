/*
 * Process tree snapshot + termination — compact port of zcode's
 * packages/services process/* modules.
 *
 * Semantics kept from upstream: tree-scoped (never kill unrelated processes),
 * graceful first with a forced kill after a deadline, and results report what
 * was actually terminated. Simplified on purpose: upstream additionally
 * verifies process identity (start-time/creation-date) before force-killing on
 * Windows to guard against PID reuse; we mitigate the same risk by only ever
 * targeting PIDs observed as descendants of the root in this call.
 */

const { execFile } = require('node:child_process');

function run(command, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      // taskkill exits non-zero when the tree is already gone; callers treat
      // non-zero as "nothing left to kill" rather than a hard failure.
      resolvePromise({ ok: !error, stdout: String(stdout ?? '') });
    });
  });
}

function parsePidPairs(text) {
  const pairs = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 2) continue;
    const pid = Number.parseInt(fields[0], 10);
    const ppid = Number.parseInt(fields[1], 10);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) {
      pairs.push([pid, ppid]);
    }
  }
  return pairs;
}

async function listProcessPairs() {
  if (process.platform === 'win32') {
    const result = await run('powershell.exe', [
      '-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "{0} {1}" -f $_.ProcessId, $_.ParentProcessId }',
    ], 8000);
    return parsePidPairs(result.stdout);
  }
  const result = await run('ps', ['-eo', 'pid=,ppid='], 8000);
  return parsePidPairs(result.stdout);
}

/** All live descendants of rootPid (excluding rootPid itself), best effort. */
async function listDescendants(rootPid) {
  const pairs = await listProcessPairs();
  const childrenOf = new Map();
  for (const [pid, ppid] of pairs) {
    if (!childrenOf.has(ppid)) childrenOf.set(ppid, []);
    childrenOf.get(ppid).push(pid);
  }
  const descendants = [];
  const queue = [...(childrenOf.get(rootPid) ?? [])];
  const seen = new Set();
  while (queue.length > 0) {
    const pid = queue.shift();
    if (seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    for (const child of childrenOf.get(pid) ?? []) queue.push(child);
  }
  return descendants;
}

function processExitPromise(child) {
  return new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolvePromise(true);
      return;
    }
    child.once('exit', () => resolvePromise(true));
  });
}

/**
 * Terminate a spawned ChildProcess and everything still alive beneath it.
 * Returns { killed, forced } — forced=true when the graceful deadline expired.
 */
async function terminateProcessTree(child, options = {}) {
  const forceAfterMs = options.forceAfterMs ?? 2000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 1500;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { killed: true, forced: false, alreadyExited: true };
  }

  const descendants = await listDescendants(child.pid).catch(() => []);

  if (process.platform === 'win32') {
    // /T walks the tree server-side; /F is required for console-less children.
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F'], 3000);
  } else {
    try { process.kill(child.pid, 'SIGTERM'); } catch { /* already gone */ }
    for (const pid of descendants) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
  }

  const gracefulDeadline = Date.now() + forceAfterMs;
  while (Date.now() < gracefulDeadline) {
    const exited = await Promise.race([
      processExitPromise(child),
      new Promise((r) => setTimeout(() => r(false), Math.min(200, gracefulDeadline - Date.now()))),
    ]);
    if (exited) return { killed: true, forced: false, alreadyExited: false };
  }

  if (process.platform !== 'win32') {
    for (const pid of [child.pid, ...descendants]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    await Promise.race([processExitPromise(child), new Promise((r) => setTimeout(r, probeTimeoutMs))]);
  }

  return { killed: true, forced: true, alreadyExited: false };
}

module.exports = { listProcessPairs, listDescendants, terminateProcessTree, processExitPromise };
