import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * 资源上限（沙箱第二档）。
 *
 * 审批门和路径围栏管的是「允许做什么」，这一层管「做的时候能吃掉多少机器」。
 * 一条 `node -e "const a=[];for(;;)a.push(...)"` 或者 60 个并发子进程，在
 * 策略层看来完全无害 —— 它没有删文件、没有越界写、没有出网 —— 但足以把
 * 开发机拖到不可用。
 *
 * Windows：Job Object。进程一旦在 job 里，内存/进程数/CPU 时间由内核记账，
 *   超限直接拒绝分配或杀掉，不依赖我们的采样精度。
 * Unix：`ulimit -v` / `ulimit -u` 前置到 sh 命令里，同样是内核限制，零额外进程。
 *
 * 关闭：`AICODE_SANDBOX_LIMITS=0`（等价于回到只有超时+杀树的状态）。
 */

export type ResourceLimits = {
  /** 单个进程的提交内存上限；0 = 不限。 */
  memoryMb: number;
  /** job 内同时存在的进程数上限；0 = 不限。 */
  maxProcesses: number;
  /** 是否启用；false 时调用方直接走原路径。 */
  enabled: boolean;
};

export function isLimitEnforcementEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.AICODE_SANDBOX_LIMITS;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return true;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed;
}

/**
 * 默认值取「够跑一次 npm test，但不够拖垮机器」的量级：
 * 2GB 单进程内存（vite/tsc 峰值通常 300–800MB）、64 个进程（jest 的 worker
 * 池默认就吃十几个；60 个并发的死循环进程不该被允许）。
 */
export function resolveResourceLimits(env: NodeJS.ProcessEnv = process.env): ResourceLimits {
  const enabled = isLimitEnforcementEnabled(env);
  return {
    enabled,
    memoryMb: positiveInt(env.AICODE_SANDBOX_MEMORY_MB, 2048),
    maxProcesses: positiveInt(env.AICODE_SANDBOX_MAX_PROCS, 64),
  };
}

/**
 * Unix 侧：把 ulimit 前置进命令。
 *
 * `ulimit -v` 是 KB 虚拟内存（Linux 有效，macOS 忽略 -v），`ulimit -u` 是
 * 每用户进程数（POSIX 都有）。两条都吞掉错误：不支持的平台继续跑，只是没有
 * 那道限制 —— 静默失败比让所有命令报错好，后面还有超时和杀树兜底。
 */
export function wrapWithUlimits(command: string, limits: ResourceLimits): string {
  if (!limits.enabled) return command;
  const parts: string[] = [];
  if (limits.memoryMb > 0) parts.push(`ulimit -v ${limits.memoryMb * 1024} 2>/dev/null || true`);
  if (limits.maxProcesses > 0) parts.push(`ulimit -u ${limits.maxProcesses} 2>/dev/null || true`);
  if (parts.length === 0) return command;
  return `${parts.join('; ')}; ${command}`;
}

/**
 * 常驻 supervisor 的 PowerShell 脚本。
 *
 * 为什么不是每条命令起一个 PowerShell：一次启动 ~350ms + Add-Type 编译
 * ~250ms，`git status` 这种命令会从 60ms 变成 700ms。这里让一个 supervisor
 * 常驻，job 只建一次，之后的命令只付 Start-Process 的钱（~30ms）。
 *
 * 关键点：supervisor 先把自己放进 job，再启动子进程 —— 子进程从出生就在
 * job 里，没有「先启动再塞进去」的竞态，孙进程也自动继承。
 *
 * 退出码靠 supervisor 等子进程拿（不能靠 cmd 的 %ERRORLEVEL% 写文件：
 * 同一个 /c 行里 %ERRORLEVEL% 在解析期就展开了）。输出重定向到文件，
 * 所以 stdout 上只有状态 JSON，不会被命令输出污染。
 */
const SUPERVISOR_SCRIPT = String.raw`param(
  [int]$MemoryMB = 0,
  [int]$MaxProcesses = 0,
  [int]$JobTimeSeconds = 0,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class AicodeJob
{
    [StructLayout(LayoutKind.Sequential)]
    public struct BASIC_LIMIT
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct EXTENDED_LIMIT
    {
        public BASIC_LIMIT BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    public static string Apply(long processMemoryLimit, uint activeProcessLimit, long jobTimeLimit)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return "CreateJobObject failed: " + Marshal.GetLastWin32Error();

        EXTENDED_LIMIT info = new EXTENDED_LIMIT();
        uint flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (processMemoryLimit > 0) { info.ProcessMemoryLimit = (UIntPtr)(ulong)processMemoryLimit; flags |= 0x100; }
        if (activeProcessLimit > 0) { info.BasicLimitInformation.ActiveProcessLimit = activeProcessLimit; flags |= 0x8; }
        if (jobTimeLimit > 0) { info.BasicLimitInformation.PerJobUserTimeLimit = jobTimeLimit; flags |= 0x4; }
        info.BasicLimitInformation.LimitFlags = flags;

        int size = Marshal.SizeOf(typeof(EXTENDED_LIMIT));
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(job, 9, buffer, (uint)size))
                return "SetInformationJobObject failed: " + Marshal.GetLastWin32Error();
        }
        finally { Marshal.FreeHGlobal(buffer); }

        if (!AssignProcessToJobObject(job, GetCurrentProcess()))
            return "AssignProcessToJobObject failed: " + Marshal.GetLastWin32Error();

        return "ok";
    }
}
'@

# Compile once, reuse the assembly: Add-Type of C# source costs ~250ms and, in a
# test run that starts dozens of supervisors, it is also the part that loads the
# CPU. A cached DLL brings a cold start down to PowerShell's own startup.
$assembly = Join-Path $env:TEMP 'aicode-limits'
if (-not (Test-Path $assembly)) { New-Item -ItemType Directory -Path $assembly -Force | Out-Null }
$dll = Join-Path $assembly 'AicodeJob.dll'
$loaded = $false
if (Test-Path $dll) {
  try { [Reflection.Assembly]::LoadFrom($dll) | Out-Null; $loaded = $true } catch { $loaded = $false }
}
if (-not $loaded) {
  $tempDll = "$dll.$PID.tmp"
  try {
    Add-Type -TypeDefinition $source -OutputAssembly $tempDll -Language CSharp | Out-Null
    [Reflection.Assembly]::LoadFrom($tempDll) | Out-Null
    Move-Item -LiteralPath $tempDll -Destination $dll -Force
  } catch {
    Remove-Item -LiteralPath $tempDll -ErrorAction SilentlyContinue
    # Another supervisor won the race to publish the DLL, or the compile has to
    # stay in memory. Either way the types end up loaded.
    if (Test-Path $dll) { [Reflection.Assembly]::LoadFrom($dll) | Out-Null }
    else { Add-Type -TypeDefinition $source -Language CSharp | Out-Null }
  }
}

$jobTime = 0
if ($JobTimeSeconds -gt 0) { $jobTime = [int64]$JobTimeSeconds * 10000000 }
$status = [AicodeJob]::Apply([int64]$MemoryMB * 1MB, [uint32]$MaxProcesses, $jobTime)
if ($status -ne 'ok') {
  [Console]::Out.WriteLine('{"type":"error","message":"' + $status.Replace('"','') + '"}')
  [Console]::Out.Flush()
  exit 2
}

[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null -or $line -eq '') { break }
  if ($line -eq 'EXIT') { break }
  try {
    $request = $line | ConvertFrom-Json
  } catch {
    [Console]::Out.WriteLine('{"type":"error","message":"bad request"}')
    [Console]::Out.Flush()
    continue
  }

  $script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($request.script))
  if ($request.cwd) { Set-Location -LiteralPath $request.cwd }
  try {
    $process = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/s', '/c', $script) -NoNewWindow -PassThru -RedirectStandardOutput $request.out -RedirectStandardError $request.err
  } catch {
    $message = $_.Exception.Message.Replace('"', '')
    [Console]::Out.WriteLine('{"type":"done","id":"' + $request.id + '","code":-1,"error":"' + $message + '"}')
    [Console]::Out.Flush()
    continue
  }
  [Console]::Out.WriteLine('{"type":"started","id":"' + $request.id + '","pid":' + $process.Id + '}')
  [Console]::Out.Flush()
  # Reading Handle before waiting is what makes ExitCode reliable in PS 5.1;
  # without it WaitForExit can return with ExitCode still $null and we would
  # emit invalid JSON ("code":) — which used to hang the caller forever.
  $null = $process.Handle
  # Poll instead of blocking forever: if the CLI that owns this job is gone, the
  # command must not keep running unattended (and this PowerShell must not
  # linger). Exiting closes the job handle, and KILL_ON_JOB_CLOSE clears the rest.
  while (-not $process.WaitForExit(500)) {
    if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 3 }
  }
  $process.Refresh()
  $code = $process.ExitCode
  if ($null -eq $code) { $code = -1 }
  [Console]::Out.WriteLine('{"type":"done","id":"' + $request.id + '","code":' + [int]$code + '}')
  [Console]::Out.Flush()
}
`;

const SCRIPT_MARKER = createHash('sha256').update(SUPERVISOR_SCRIPT).digest('hex').slice(0, 12);

/** 一次性的清理：崩掉的运行会留下 out/err 文件，攒着没意义。 */
let sweptTempFiles = false;
function sweepStaleOutputs(dir: string) {
  if (sweptTempFiles) return;
  sweptTempFiles = true;
  try {
    for (const entry of readdirSync(dir)) {
      if (!/^cmd-.*\.(out|err)$/.test(entry)) continue;
      const file = join(dir, entry);
      const age = Date.now() - statSync(file).mtimeMs;
      if (age > 6 * 60 * 60 * 1000) rmSync(file, { force: true });
    }
  } catch {
    // A missing or unreadable temp dir is not worth failing a command over.
  }
}

export function supervisorScriptPath(): string {
  const dir = join(tmpdir(), 'aicode-limits');
  mkdirSync(dir, { recursive: true });
  sweepStaleOutputs(dir);
  const file = join(dir, `job-supervisor-${SCRIPT_MARKER}.ps1`);
  if (!existsSync(file)) {
    // PowerShell reads the script as UTF-16LE unless it has a BOM-less UTF-8
    // signature; write UTF-8 with BOM so Chinese messages survive.
    writeFileSync(file, `\ufeff${SUPERVISOR_SCRIPT}`, 'utf8');
  }
  // Scripts written by older builds are never read again.
  try {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('job-supervisor-') && entry.endsWith('.ps1') && entry !== `job-supervisor-${SCRIPT_MARKER}.ps1`) {
        try { rmSync(join(dir, entry), { force: true }); } catch {}
      }
    }
  } catch {}
  return file;
}

type SupervisorMessage = { type: 'ready' | 'started' | 'done' | 'error'; id?: string; pid?: number; code?: number; message?: string; error?: string };

type Supervisor = {
  child: ChildProcessWithoutNullStreams;
  limits: ResourceLimits;
  busy: boolean;
  broken: boolean;
  pending: Map<string, { resolve: (message: SupervisorMessage) => void }>;
  stdoutBuffer: string;
  setIdle: () => void;
  setActive: () => void;
};

const supervisors: Supervisor[] = [];

function startSupervisor(limits: ResourceLimits, jobTimeSeconds: number): Supervisor {
  const scriptPath = supervisorScriptPath();
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-MemoryMB', String(limits.memoryMb),
      '-MaxProcesses', String(limits.maxProcesses),
      '-JobTimeSeconds', String(jobTimeSeconds),
      '-ParentPid', String(process.pid),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const supervisor = {
    child, limits, busy: false, broken: false, pending: new Map(), stdoutBuffer: '',
  } as unknown as Supervisor;

  // A cached supervisor must not pin the CLI's event loop: an idle child with
  // piped stdio keeps Node alive, and anything that waits for the process to
  // exit (a test run, `aicode --json` finishing a turn) would hang forever
  // waiting on us waiting on it. Ref'd again while a command is in flight.
  const setIdle = () => {
    try { child.unref(); } catch { /* ignore */ }
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { (stream as unknown as { unref?: () => void }).unref?.(); } catch { /* ignore */ }
    }
  };
  const setActive = () => {
    try { child.ref(); } catch { /* ignore */ }
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { (stream as unknown as { ref?: () => void }).ref?.(); } catch { /* ignore */ }
    }
  };
  supervisor.setIdle = setIdle;
  supervisor.setActive = setActive;
  setIdle();

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    supervisor.stdoutBuffer += chunk;
    let index = supervisor.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = supervisor.stdoutBuffer.slice(0, index).trim();
      supervisor.stdoutBuffer = supervisor.stdoutBuffer.slice(index + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as SupervisorMessage;
          const waiter = message.id ? supervisor.pending.get(message.id) : undefined;
          if (waiter) {
            if (message.type === 'started' || message.type === 'done') waiter.resolve(message);
            if (message.type === 'done') supervisor.pending.delete(message.id as string);
          } else if (message.type === 'ready' || message.type === 'error') {
            const ready = supervisor.pending.get('__ready');
            ready?.resolve(message);
          }
        } catch {
          // Non-JSON on stdout means the protocol is broken. Resolve whatever is
          // waiting with an error so callers fall back instead of hanging until
          // the timeout.
          supervisor.broken = true;
          for (const [key, waiter] of supervisor.pending) {
            waiter.resolve({ type: 'error', message: 'supervisor protocol error' });
            supervisor.pending.delete(key);
          }
        }
      }
      index = supervisor.stdoutBuffer.indexOf('\n');
    }
  });
  // Supervisor dying takes the whole job with it (KILL_ON_JOB_CLOSE).
  child.on('close', () => { supervisor.broken = true; });
  child.on('error', () => { supervisor.broken = true; });
  return supervisor;
}

function waitForReady(supervisor: Supervisor, timeoutMs = 10_000): Promise<SupervisorMessage> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      supervisor.pending.delete('__ready');
      resolve({ type: 'error', message: 'supervisor did not become ready' });
    }, timeoutMs);
    supervisor.pending.set('__ready', {
      resolve: (message) => {
        clearTimeout(timer);
        supervisor.pending.delete('__ready');
        resolve(message);
      },
    });
  });
}

function takeIdleSupervisor(limits: ResourceLimits): Supervisor | undefined {
  const reusable = supervisors.find(
    (candidate) => !candidate.busy
      && !candidate.broken
      && candidate.limits.memoryMb === limits.memoryMb
      && candidate.limits.maxProcesses === limits.maxProcesses,
  );
  return reusable;
}

export type LimitedRunOptions = {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  signal?: AbortSignal;
  limits: ResourceLimits;
};

export type LimitedRunResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  cancelled: boolean;
  pid?: number;
  /** supervisor 自身失败（没有 PowerShell、job 建不起来）——调用方应回退到直接 spawn。 */
  unavailable?: string;
};

/**
 * 在 job 里跑一条命令。
 *
 * 返回 `unavailable` 表示这层用不了（没有 PowerShell、job 创建失败），调用方
 * 必须回退到普通 spawn：宁可少一道限制，也不能让所有命令都跑不起来。
 */
export async function runWithResourceLimits(options: LimitedRunOptions): Promise<LimitedRunResult> {
  const jobTimeSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  let supervisor = takeIdleSupervisor(options.limits);

  if (!supervisor) {
    const fresh = startSupervisor(options.limits, jobTimeSeconds);
    const ready = await waitForReady(fresh);
    if (ready.type !== 'ready') {
      fresh.broken = true;
      try { fresh.child.kill(); } catch { /* ignore */ }
      return {
        stdout: '', stderr: '', code: null, timedOut: false, cancelled: false,
        unavailable: ready.message ?? 'job supervisor unavailable',
      };
    }
    supervisors.push(fresh);
    supervisor = fresh;
  }

  const active = supervisor;
  active.busy = true;
  active.setActive();
  const id = `cmd-${randomUUID()}`;
  const workDir = join(tmpdir(), 'aicode-limits');
  mkdirSync(workDir, { recursive: true });
  const outFile = join(workDir, `${id}.out`);
  const errFile = join(workDir, `${id}.err`);
  const cleanup = () => {
    try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
    try { rmSync(errFile, { force: true }); } catch { /* ignore */ }
  };

  const request = JSON.stringify({
    id,
    script: Buffer.from(options.command, 'utf8').toString('base64'),
    cwd: options.cwd,
    out: outFile,
    err: errFile,
  });

  let childPid: number | undefined;
  let settled = false;
  let timedOut = false;
  let cancelled = false;

  const killTree = () => {
    if (!childPid) return;
    try {
      spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(childPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } catch { /* ignore */ }
  };

  // Waiting for the supervisor to actually die matters: resolving the promise
  // while the child still holds its cwd makes the caller's cleanup fail with
  // EBUSY on Windows (temp workspace rmdir has nowhere to go).
  const waitForExit = (child: ChildProcessWithoutNullStreams, capMs: number) => new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => { if (finished) return; finished = true; resolve(); };
    const cap = setTimeout(finish, capMs);
    child.once('close', () => { clearTimeout(cap); finish(); });
  });

  const done = await new Promise<SupervisorMessage>((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      timedOut = true;
      killTree();
      // 超时兜底：连 supervisor 一起收掉，job 里的残留进程随 KILL_ON_JOB_CLOSE 消失。
      try { active.child.kill(); } catch { /* ignore */ }
      active.broken = true;
      void waitForExit(active.child, 3_000).then(() => resolve({ type: 'done', id, code: null as unknown as number }));
    }, options.timeoutMs);

    const abort = () => {
      if (settled) return;
      settled = true;
      cancelled = true;
      clearTimeout(timer);
      killTree();
      // Same reason as the timeout path: give the kill a moment to land before
      // the caller inspects (and deletes) anything.
      void Promise.race([
        new Promise<void>((doneWaiting) => {
          const poll = setInterval(() => {
            let alive = true;
            try { process.kill(childPid as number, 0); } catch { alive = false; }
            if (!alive) { clearInterval(poll); doneWaiting(); }
          }, 25);
          setTimeout(() => { clearInterval(poll); doneWaiting(); }, 1_500);
          poll.unref?.();
        }),
      ]).then(() => resolve({ type: 'done', id, code: null as unknown as number }));
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();

    active.pending.set(id, {
      resolve: (message) => {
        if (message.type === 'started') {
          childPid = message.pid;
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        resolve(message);
      },
    });

    try {
      active.child.stdin.write(`${request}\n`);
    } catch {
      settled = true;
      clearTimeout(timer);
      resolve({ type: 'error', message: 'supervisor stdin closed' });
    }
  });

  active.busy = false;
  active.setIdle();
  if (active.broken) {
    const index = supervisors.indexOf(active);
    if (index >= 0) supervisors.splice(index, 1);
  }

  if (done.type === 'error') {
    cleanup();
    return {
      stdout: '', stderr: '', code: null, timedOut: false, cancelled: false,
      unavailable: done.message ?? 'supervisor request failed',
    };
  }

  const readCapped = (file: string, cap: number): { text: string; truncated: boolean } => {
    try {
      const raw = readFileSync(file);
      if (raw.length <= cap) return { text: raw.toString('utf8'), truncated: false };
      return { text: raw.subarray(0, cap).toString('utf8'), truncated: true };
    } catch {
      return { text: '', truncated: false };
    }
  };

  const stdout = readCapped(outFile, options.maxBuffer);
  const stderr = readCapped(errFile, options.maxBuffer);
  cleanup();

  return {
    stdout: stdout.text,
    stderr: `${stderr.text}${stdout.truncated || stderr.truncated ? `\n(output truncated: maxBuffer ${options.maxBuffer} bytes)` : ''}`,
    code: typeof done.code === 'number' ? done.code : null,
    timedOut,
    cancelled,
    pid: childPid,
  };
}

/** 测试用：收掉所有常驻 supervisor。 */
export function shutdownLimitSupervisors() {
  for (const supervisor of supervisors.splice(0)) {
    try { supervisor.child.stdin.write('EXIT\n'); } catch { /* ignore */ }
    try { supervisor.child.kill(); } catch { /* ignore */ }
  }
}
