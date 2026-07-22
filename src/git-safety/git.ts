import { execFile } from 'node:child_process';
import { isAbsolute, posix, win32 } from 'node:path';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type GitRunOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  stdin?: string | Buffer;
};

export type GitCommandErrorKind = 'exit' | 'spawn' | 'timeout' | 'stdin';

type GitCommandFailure = {
  kind: GitCommandErrorKind;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  errnoCode?: string;
};

export class GitCommandError extends Error {
  readonly stderr: string;
  readonly kind: GitCommandErrorKind;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly errnoCode?: string;

  constructor(stderr: string, failure: GitCommandFailure) {
    const sanitizedStderr = sanitizeError(stderr);
    const status = failure.kind === 'exit'
      ? `exit code ${String(failure.exitCode ?? null)}`
      : failure.kind === 'timeout'
        ? 'timeout'
        : failure.kind === 'spawn'
          ? `spawn error${failure.errnoCode ? ` ${failure.errnoCode}` : ''}`
          : `stdin error${failure.errnoCode ? ` ${failure.errnoCode}` : ''}`;
    super(`Git command failed (${status})${sanitizedStderr ? `: ${sanitizedStderr}` : ''}`);
    this.name = 'GitCommandError';
    this.stderr = sanitizedStderr;
    this.kind = failure.kind;
    this.exitCode = failure.exitCode ?? null;
    this.signal = failure.signal ?? null;
    this.timedOut = failure.timedOut ?? false;
    this.errnoCode = failure.errnoCode;
  }
}

export class GitProcess {
  constructor(readonly cwd: string) {}

  async text(args: readonly string[], options?: GitRunOptions): Promise<string> {
    return (await this.buffer(args, options)).toString('utf8');
  }

  buffer(args: readonly string[], options: GitRunOptions = {}): Promise<Buffer> {
    const env = buildGitEnvironment(process.env, options.env);
    // Quiet Windows CRLF / ignored-path advice that otherwise floods every snapshot turn.
    const argv = [...GIT_QUIET_CONFIG_ARGS, ...args];
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        operation();
      };
      const child = execFile(
        'git',
        argv,
        {
          cwd: this.cwd,
          windowsHide: true,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER_BYTES,
          env,
          encoding: 'buffer',
        },
        (error, stdout, stderr) => {
          const stdoutBuffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          const stderrText = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '');
          if (error) {
            const failure = commandFailure(error);
            const cleaned = stripGitNoise(stderrText);
            // Only swallow exit=1 when stderr was non-empty noise (CRLF/ignore advice).
            // Empty-stderr failures (e.g. missing config key) must still reject.
            if (
              failure.kind === 'exit'
              && failure.exitCode === 1
              && stderrText.trim().length > 0
              && !cleaned.trim()
            ) {
              settle(() => resolve(stdoutBuffer));
              return;
            }
            settle(() => reject(new GitCommandError(cleaned || stderrText, failure)));
            return;
          }
          settle(() => resolve(stdoutBuffer));
        },
      );

      child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
        settle(() => reject(new GitCommandError('', {
          kind: 'stdin',
          errnoCode: error.code,
        })));
      });
      try {
        child.stdin?.end(options.stdin);
      } catch (error) {
        const failure = error as NodeJS.ErrnoException;
        settle(() => reject(new GitCommandError('', {
          kind: 'stdin',
          errnoCode: failure.code,
        })));
      }
    });
  }
}

export function assertObjectId(value: string): string {
  if (!/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value)) {
    throw new Error('Unsafe Git object ID');
  }
  return value;
}

export function assertSafeRef(value: string): string {
  const invalidCharacter = /[\u0000-\u0020\u007f~^:?*\[]/;
  if (
    !value
    || value.startsWith('-')
    || value === '@'
    || value.startsWith('/')
    || value.endsWith('/')
    || value.startsWith('.')
    || value.endsWith('.')
    || value.includes('..')
    || value.includes('@{')
    || value.includes('\\')
    || invalidCharacter.test(value)
  ) {
    throw new Error('Unsafe Git ref');
  }

  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.lock'))) {
    throw new Error('Unsafe Git ref');
  }
  return value;
}

export function assertSafeCheckpointRef(value: string): string {
  const prefix = 'refs/aicode/checkpoints/';
  assertSafeRef(value);
  if (!value.startsWith(prefix)) throw new Error('Unsafe Git checkpoint ref');
  const suffix = value.slice(prefix.length);
  if (!suffix) {
    throw new Error('Unsafe Git checkpoint ref');
  }
  return value;
}

export function assertSafeRelativePath(value: string): string {
  if (
    !value
    || value === '.'
    || value.includes('\u0000')
    || value.includes('\\')
    || value.startsWith(':(')
    || /[*?[\u0000]/.test(value)
    || isAbsolute(value)
    || posix.isAbsolute(value)
    || win32.isAbsolute(value)
    || /^[A-Za-z]:/.test(value)
  ) {
    throw new Error('Unsafe repository-relative path');
  }

  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Unsafe repository-relative path');
  }
  return value;
}

export function assertSafeWorkspacePathspec(value: string): string {
  return value === '.' ? value : assertSafeRelativePath(value);
}

export function literalPathspec(value: string): string {
  return `:(literal)${assertSafeRelativePath(value)}`;
}

export function sanitizeRemote(remote: string): string {
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(remote)) return remote;
  try {
    const parsed = new URL(remote);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid remote URL]';
  }
}

/** Config flags applied to every aicode git-safety child process. */
export const GIT_QUIET_CONFIG_ARGS = [
  '-c', 'advice.addIgnoredFile=false',
  '-c', 'core.safecrlf=false',
] as const;

export function stripGitNoise(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/LF will be replaced by CRLF/i.test(trimmed)) return false;
      if (/CRLF will be replaced by LF/i.test(trimmed)) return false;
      if (/warning:\s+in the working copy of/i.test(trimmed)) return false;
      if (/The following paths are ignored by one of your \.gitignore files/i.test(trimmed)) return false;
      if (/^hint:\s+/i.test(trimmed)) return false;
      if (/Use -f if you really want to add them/i.test(trimmed)) return false;
      if (/Disable this message with \"git config/i.test(trimmed)) return false;
      // Bare path listed under the ignore advice (e.g. ".aicode")
      if (/^\.aicode(?:\/.*)?$/i.test(trimmed)) return false;
      return true;
    })
    .join('\n');
}

export function sanitizeError(error: string): string {
  const truncated = error.length > 64 * 1024 ? `${error.slice(0, 64 * 1024)}\n[truncated]` : error;
  const withoutNoise = stripGitNoise(truncated);
  const withoutAuthHeaders = withoutNoise.replace(/\bAuthorization[ \t]*:[^\r\n]*/gi, '[REDACTED]');
  const withoutUrls = withoutAuthHeaders.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g, (remote) => sanitizeRemote(remote));
  const withoutBearer = withoutUrls.replace(/\b(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '[REDACTED]');
  return withoutBearer.replace(
    /\b(?:password|passwd|token|access[_-]?token|auth[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?token|secret|credential)\s*[:=]\s*(?:"[^"\r\n]{0,256}"|'[^'\r\n]{0,256}'|[^\s,;\r\n]{1,256})/gi,
    '[REDACTED]',
  );
}

const BASE_ENVIRONMENT_KEYS = new Set([
  'comspec',
  'home',
  'homedrive',
  'homepath',
  'lang',
  'language',
  'path',
  'pathext',
  'ssh_agent_pid',
  'ssh_auth_sock',
  'systemroot',
  'temp',
  'tmp',
  'tmpdir',
  'userprofile',
  'windir',
]);

export function buildGitEnvironment(
  inputEnv: Readonly<Record<string, string | undefined>> = process.env,
  overrides?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inputEnv)) {
    if (value !== undefined && isBaseEnvironmentKey(key)) setEnvironmentValue(env, key, value);
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    setEnvironmentValue(env, key, value);
  }
  return env;
}

function isBaseEnvironmentKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return BASE_ENVIRONMENT_KEYS.has(normalized) || normalized.startsWith('lc_');
}

function setEnvironmentValue(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
  for (const existingKey of Object.keys(env)) {
    if (existingKey.toLowerCase() === key.toLowerCase()) delete env[existingKey];
  }
  if (value !== undefined) env[key] = value;
}

function commandFailure(error: Error): GitCommandFailure {
  const failure = error as NodeJS.ErrnoException & {
    code?: number | string | null;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
  const signal = failure.signal ?? null;
  if (failure.killed) {
    return {
      kind: 'timeout',
      signal,
      timedOut: true,
      errnoCode: typeof failure.code === 'string' ? failure.code : undefined,
    };
  }
  if (typeof failure.code === 'number') {
    return { kind: 'exit', exitCode: failure.code, signal };
  }
  return {
    kind: 'spawn',
    signal,
    errnoCode: typeof failure.code === 'string' ? failure.code : undefined,
  };
}
