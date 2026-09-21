import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { resolve } from 'node:path';
const SECRET_ENV_KEYS = [
  /^OPENAI_API_KEY$/i,
  /^ANTHROPIC_API_KEY$/i,
  /^MOCK_API_KEY$/i,
  /^AICODE_.*KEY$/i,
  /^AWS_SECRET_ACCESS_KEY$/i,
  /^AWS_ACCESS_KEY_ID$/i,
  /^AWS_SESSION_TOKEN$/i,
  /^GITHUB_TOKEN$/i,
  /^GH_TOKEN$/i,
  /^NPM_TOKEN$/i,
  /^NODE_AUTH_TOKEN$/i,
  /^HF_TOKEN$/i,
  /^HUGGINGFACE_.*TOKEN$/i,
  /^AZURE_.*KEY$/i,
  /^GOOGLE_APPLICATION_CREDENTIALS$/i,
  /^PRIVATE_KEY$/i,
  /^.*_SECRET$/i,
  /^.*_PASSWORD$/i,
  /^.*_TOKEN$/i,
];

const KEEP_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'SystemRoot',
  'SYSTEMROOT',
  'COMSPEC',
  'ComSpec',
  'windir',
  'WINDIR',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NODE_OPTIONS',
  'npm_config_user_agent',
  'npm_config_registry',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
  'PUBLIC',
  'USERNAME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
];

export type SandboxOptions = {
  command: string;
  cwd: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  scrubSecrets?: boolean;
  shell?: boolean | string;
};

export type SandboxResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  scrubbed: boolean;
  pid?: number;
};

export function isSandboxScrubEnabled(env: NodeJS.ProcessEnv = process.env) {
  const value = env.AICODE_SANDBOX;
  if (value === '0' || value === 'false' || value === 'off') return false;
  return true;
}

export function buildSandboxEnv(
  base: NodeJS.ProcessEnv = process.env,
  options?: { scrubSecrets?: boolean; extra?: Record<string, string | undefined> },
): NodeJS.ProcessEnv {
  const scrub = options?.scrubSecrets ?? isSandboxScrubEnabled(base);
  const out: NodeJS.ProcessEnv = {};

  if (!scrub) {
    Object.assign(out, base);
  } else {
    for (const key of KEEP_ENV_KEYS) {
      const value = base[key];
      if (typeof value === 'string') out[key] = value;
    }
    // Always keep essential PATH even if case differs on Windows.
    if (!out.PATH && !out.Path) {
      const pathValue = base.PATH ?? base.Path;
      if (typeof pathValue === 'string') out.PATH = pathValue;
    }
    for (const [key, value] of Object.entries(base)) {
      if (typeof value !== 'string') continue;
      if (isSecretEnvKey(key)) continue;
      if (KEEP_ENV_KEYS.includes(key)) continue;
      // Drop unknown keys that look like credentials even if not in list patterns above
      if (/key|token|secret|password|credential/i.test(key) && !/^npm_config_/i.test(key)) continue;
      // Keep a small set of AICODE non-secret knobs
      if (/^AICODE_/i.test(key) && !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)) {
        out[key] = value;
      }
    }
  }

  if (options?.extra) {
    for (const [key, value] of Object.entries(options.extra)) {
      if (value === undefined) delete out[key];
      else out[key] = value;
    }
  }
  return out;
}

export function isSecretEnvKey(key: string) {
  return SECRET_ENV_KEYS.some((pattern) => pattern.test(key));
}

/**
 * Find an MSYS/Git-Bash drive path (`/c/Users/me/x.txt`, `/mnt/c/...`) in a
 * command that will be handed to cmd.exe, where no such path exists.
 *
 * Detection only — the command is never rewritten. The same text can be a regex
 * or a quoted literal, so rewriting it would silently change what the command
 * means. An actionable error costs one round trip; a wrong rewrite costs a
 * wrong result.
 */
export function findPosixDrivePath(command: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  // At least one character must follow the drive slash: `/c/` alone is far more
  // likely to be a regex or a literal than a path, and flagging it would reject
  // working commands such as `grep -o "/c/" file`.
  const pattern = /(?:^|[\s"'`(=&|;])((?:\/mnt)?\/[a-zA-Z]\/[^\s"'`;|&()]+)/;
  const match = pattern.exec(command);
  return match?.[1];
}

/** Throw with a fix-it message when a command carries an MSYS drive path. */
export function assertNoPosixDrivePath(command: string) {
  const posixPath = findPosixDrivePath(command);
  if (!posixPath) return;
  const windowsPath = `${posixPath.replace(/^\/(?:mnt\/)?([a-zA-Z])\//, (_m, drive: string) => `${drive.toUpperCase()}:\\`).replace(/\//g, '\\')}`;
  throw new Error(
    `commands run through cmd.exe on Windows, which cannot resolve the MSYS path "${posixPath}". `
    + `Re-issue it with a Windows path ("${windowsPath}") or a workspace-relative path.`,
  );
}

export function validateSandboxCommand(command: string) {
  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('command is required');
  }
  if (command.includes('\0')) {
    throw new Error('command must not contain null bytes');
  }
  if (command.length > 32_768) {
    throw new Error('command exceeds 32KB limit');
  }
  assertNoPosixDrivePath(command);
}

/**
 * Undo the classic chat/markdown HTML-entity corruption: a `&&` emitted by
 * the model or round-tripped through an escaping layer can arrive as
 * `&amp;&amp;`, which cmd.exe splits into a bogus `amp` command
 * ("'amp' 不是内部或外部命令"). Rewrite `&amp;` back to `&`, but only
 * OUTSIDE double quotes — a quoted URL like "a=1&amp;b=2" is valid data and
 * must survive untouched. Deterministic and unit-tested.
 */
export function unescapeAmpEntities(command: string): string {
  if (!command.includes('&amp;')) return command;
  let out = '';
  let inQuotes = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
      out += ch;
      continue;
    }
    if (!inQuotes && command.startsWith('&amp;', i)) {
      out += '&';
      i += 4;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Windows consoles default to the OEM codepage (GBK 936 on zh-CN), so native
 * tools write Chinese as GBK bytes while we decode with utf8 — mojibake.
 * Flipping the session to 65001 before the real command runs makes child
 * processes (which inherit the console CP) emit UTF-8.
 */
export function buildWindowsShellCommand(command: string): string {
  return `chcp 65001>nul 2>&1 && ${command}`;
}

/**
 * Full Windows channel prep shared by the foreground sandbox runner and the
 * background job manager: entity repair first, codepage flip second.
 */
export function prepareShellCommand(command: string, isWin: boolean): string {
  const repaired = unescapeAmpEntities(command);
  return isWin ? buildWindowsShellCommand(repaired) : repaired;
}

export async function runSandboxedCommand(options: SandboxOptions): Promise<SandboxResult> {
  validateSandboxCommand(options.command);
  const cwd = resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBuffer = options.maxBuffer ?? 1024 * 1024;
  const scrubbed = options.scrubSecrets ?? isSandboxScrubEnabled(options.env ?? process.env);
  const env = buildSandboxEnv(options.env ?? process.env, { scrubSecrets: scrubbed });

  const isWin = process.platform === 'win32';
  const shell = options.shell ?? true;
  // Windows channel hardening: repair `&amp;&amp;` entity corruption before the
  // string reaches cmd.exe, and switch the console to UTF-8 so Chinese tool
  // output survives our utf8 decoding (the OEM GBK default was the mojibake
  // root cause).
  const finalCommand = isWin ? buildWindowsShellCommand(unescapeAmpEntities(options.command)) : unescapeAmpEntities(options.command);
  const spawnOpts: SpawnOptions = {
    cwd,
    env,
    windowsHide: true,
    shell,
    // On POSIX put children in a new process group so timeout can kill the tree.
    detached: !isWin,
  };

  return await new Promise<SandboxResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(finalCommand, [], spawnOpts) as ChildProcessWithoutNullStreams;
    } catch (error) {
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const finish = (result: SandboxResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid, isWin);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBuffer) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code, signal) => {
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        stderr = `${stderr}\n(output truncated: maxBuffer ${maxBuffer} bytes)`.trim();
      }
      finish({
        stdout,
        stderr,
        code,
        signal,
        timedOut,
        scrubbed,
        pid: child.pid,
      });
    });
  });
}

export function formatSandboxResult(result: SandboxResult, command: string) {
  if (result.timedOut) {
    return {
      ok: false as const,
      output: `Command timed out after limit; process tree killed.\n${joinStreams(result)}`.trim(),
      data: { command, timedOut: true, scrubbed: result.scrubbed, code: result.code, signal: result.signal },
    };
  }
  if ((result.code ?? 0) !== 0) {
    return {
      ok: false as const,
      output: joinStreams(result) || `Command failed with code ${result.code}`,
      data: { command, timedOut: false, scrubbed: result.scrubbed, code: result.code, signal: result.signal },
    };
  }
  return {
    ok: true as const,
    output: joinStreams(result) || '(no output)',
    data: { command, timedOut: false, scrubbed: result.scrubbed, code: result.code ?? 0 },
  };
}

function joinStreams(result: SandboxResult) {
  return [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n');
}

function killProcessTree(pid: number | undefined, isWin: boolean) {
  if (!pid || !Number.isFinite(pid)) return;
  try {
    if (isWin) {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    // ignore kill races
  }
}
