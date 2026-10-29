/**
 * 结构化命令分析。
 *
 * 原来的实现只有一串正则打在整条命令上，于是 `cmd /c "del /s /q C:\"`、
 * `powershell -EncodedCommand <base64>`、`curl … | sh`、`for /r %i in (*) do del %i`
 * 全部能穿过去 —— 正则看的是字符串长相，不是命令结构。
 *
 * 这里按壳层语法切开命令，逐段看「跑的是哪个程序、带什么参数」，遇到解释器
 * （cmd /c、powershell -Command、bash -c、node -e…）就递归进去看里面那条命令。
 * 目标是把「看起来像危险」升级成「结构上是危险」。
 *
 * 三档结论：
 *   ok      放行（策略层其余规则照常）
 *   prompt  必须由人确认（即使 auto 模式也不静默执行）
 *   blocked 直接拒绝，任何模式都不执行
 */

import { homedir } from 'node:os';
import { evaluateNetworkTarget } from './network.js';

export type CommandVerdict = 'ok' | 'prompt' | 'blocked';

export type CommandAnalysis = {
  verdict: CommandVerdict;
  reason: string;
  /** 切出来的段，便于调用方在审批提示里展示真实执行体。 */
  segments: string[];
};

/** 一段命令：是否由管道接在上一段之后。 */
export type CommandSegment = { text: string; piped: boolean };

/** 硬拒绝：这些程序/子命令一旦出现就没有「确认后放行」的空间。 */
const BLOCKED_PROGRAMS = new Set([
  'format', 'diskpart', 'mkfs', 'mkfs.ext4', 'mkfs.xfs', 'fdisk', 'parted',
  'shutdown', 'reboot', 'poweroff', 'halt', 'logoff',
  'bcdedit', 'vssadmin', 'wbadmin', 'bootrec',
  'mkswap', 'wipefs', 'shred', 'srm',
]);

/** 需要看子命令的：reg add/delete、netsh advfirewall、sc delete、net user… */
const PRIVILEGED_PROGRAMS = new Set(['reg', 'netsh', 'sc', 'net', 'icacls', 'takeown', 'cipher', 'attrib', 'set-mppreference', 'add-mppreference']);

/** 递归/强制删除类程序：就算目标是工作区内也要人确认。 */
const DESTRUCTIVE_PROGRAMS = new Set(['rm', 'del', 'erase', 'rmdir', 'rd', 'remove-item', 'ri', 'rni', 'sdelete']);

/** 解释器：参数里可能是另一条命令，要递归分析。 */
const INTERPRETERS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'node', 'nodejs', 'python', 'python3', 'py', 'perl', 'ruby', 'deno', 'bun', 'php', 'lua']);

/** 直接执行脚本文件、无法静态看内容的。 */
const SCRIPT_HOSTS = new Set(['wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32']);

/**
 * 读文件的程序：`cat ~/.ssh/id_rsa` 绕过了 read 工具的围栏。
 * 只对凭据目录下杀手 —— 判断「工作区外」需要读白名单，那个信息在 policy 层，
 * 这里不做，避免两处规则漂移。
 */
const READ_PROGRAMS = new Set([
  'cat', 'type', 'head', 'tail', 'less', 'more', 'bat', 'gc', 'get-content', 'select-string', 'sls',
  'strings', 'xxd', 'od', 'rg', 'grep', 'findstr', 'diff', 'sort', 'uniq', 'wc', 'awk', 'sed', 'jq',
]);

/**
 * 搬运/解包类程序：参数里既有源也有目标，两边都必须在工作区内。
 * `copy .\a.txt C:\Windows\` 和 `copy C:\Windows\win.ini .` 都不该通。
 */
const COPY_PROGRAMS = new Set(['copy', 'move', 'xcopy', 'robocopy', 'cp', 'mv', 'tee', 'unzip', 'zip', 'tar', '7z', 'ln', 'touch', 'mkdir', 'md']);

/**
 * 出网程序：shell 里的 `curl` 原来不受 `fetch_url` 的网络白名单约束，
 * 于是把 `.env` POST 出去只要一条命令。这里用同一份白名单判。
 * `certutil -urlcache` / `bitsadmin /transfer` 是 Windows 上的同类通道。
 */
const NETWORK_PROGRAMS = new Set(['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'http', 'https', 'aria2c', 'certutil', 'bitsadmin']);

/** 只有 `user@host` 形式的目标，没有 URL —— 拿 host 去判。 */
const REMOTE_SHELL_PROGRAMS = new Set(['ssh', 'scp', 'sftp', 'rsync', 'ftp', 'telnet', 'nc', 'ncat', 'netcat', 'mosh']);

const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s"'`|;&<>()]+/gi;

/**
 * 包装器：真正的动作在参数里。`for /r %i in (*) do del %i` 的 program 是
 * `for`，按首 token 判断会漏掉后面那个 `del`。
 */
const WRAPPERS = new Set(['for', 'foreach', 'while', 'if', 'do', 'then', 'else', 'call', 'start', 'exec', 'sudo', 'runas', 'xargs', 'timeout', 'find', 'watch', 'parallel', 'okcmd']);

/** 任务运行器：参数里出现 `format` 之类只是脚本名，不是命令。 */
const TASK_RUNNERS = new Set(['npm', 'npx', 'yarn', 'pnpm', 'cargo', 'go', 'make', 'pip', 'pip3', 'gradle', 'mvn', 'dotnet', 'uv', 'poetry', 'just', 'task', 'git']);

/** 扫描时认的危险程序名（`format` 容易撞脚本名，所以靠跳过引号/参数值兜底）。 */
const SCANNABLE_PROGRAMS = new Set([...DESTRUCTIVE_PROGRAMS, 'format', 'diskpart', 'mkfs', 'shutdown', 'reboot', 'poweroff', 'bcdedit', 'vssadmin', 'wipefs']);

/** 内联代码里命中这些名字就不再是「也许」，直接拒绝。 */
const INLINE_BLOCKING_PROGRAMS = new Set(['format', 'diskpart', 'mkfs', 'shutdown', 'reboot', 'poweroff', 'bcdedit', 'vssadmin', 'wipefs']);

/**
 * 在内联代码里找危险程序名。
 *
 * 解释器内联的代码 `node -e "require('child_process').execSync('format c:')"`
 * 用 shell 的词法拆出来是一整块，靠空格分词根本切不出 `format`；这里按
 * 「非标识符」切，把代码里的调用名一个个拎出来看。
 */
function findDangerousProgramInText(text: string): string | null {
  for (const piece of text.split(/[^A-Za-z0-9_.\-\\/:]+/)) {
    const name = baseName(piece);
    if (SCANNABLE_PROGRAMS.has(name)) return name;
  }
  return null;
}

/** 系统目录：递归删除落在这些路径上一律拒绝。 */
const SYSTEM_PATH_PATTERNS = [
  /^[a-z]:[\\/]*$/i,                       // 盘符根 C:\
  /^[\\/]+$/,                              // /
  /^[a-z]:[\\/]windows([\\/]|$)/i,
  /^[a-z]:[\\/]program files( \(x86\))?([\\/]|$)/i,
  /^[a-z]:[\\/]programdata([\\/]|$)/i,
  /^[a-z]:[\\/]users([\\/]?$)/i,           // C:\Users 本身
  /^[a-z]:[\\/]system32([\\/]|$)/i,
  /^(\/etc|\/usr|\/bin|\/sbin|\/lib|\/var|\/boot|\/dev|\/proc|\/sys)(\/|$)/i,
  /^~\/?$/,
];

/** 截断的 base64 命令行只可能来自 -EncodedCommand，解码后再分析。 */
function decodePowerShellEncoded(value: string): string | null {
  try {
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length === 0) return null;
    // PowerShell 编码的是 UTF-16LE
    const decoded = buffer.toString('utf16le');
    // 解码成功应当是可打印文本；二进制垃圾直接判失败。
    if (!decoded || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * 按壳层操作符把命令切成段，遵守引号：`echo "a && b"` 是一段，
 * `a && b` 是两段。`piped` 记录这一段是不是被 `|` 喂进来的。
 */
export function splitCommandSegments(command: string): CommandSegment[] {
  const segments: CommandSegment[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let piped = false;
  const push = (nextPiped: boolean) => {
    const text = current.trim();
    if (text) segments.push({ text, piped });
    current = '';
    piped = nextPiped;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    const two = command.slice(index, index + 2);
    if (two === '&&' || two === '||') { push(false); index += 1; continue; }
    if (char === '|') { push(true); continue; }
    if (char === ';' || char === '\n' || char === '\r') { push(false); continue; }
    // 单个 & 在 cmd 里也是串行分隔符；在 bash 里是后台。两种都算分段。
    if (char === '&') { push(false); continue; }
    current += char;
  }
  push(false);
  return segments;
}

/** 拆参数，去掉引号，保留引号内的空格。 */
export function tokenizeCommand(segment: string): string[] {
  return tokenizeDetailed(segment).map((token) => token.text);
}

/**
 * 同上，但记住每个 token 当初是否被引号包住。`rg "rm -rf" docs` 里的
 * `rm -rf` 是搜索词，不是要执行的命令 —— 扫描危险程序名时必须跳过它。
 */
export function tokenizeDetailed(segment: string): Array<{ text: string; quoted: boolean }> {
  const tokens: Array<{ text: string; quoted: boolean }> = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  let quoted = false;
  const flush = () => {
    if (current || started) tokens.push({ text: current, quoted });
    current = '';
    started = false;
    quoted = false;
  };
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; quoted = true; continue; }
    if (/\s/.test(char)) { flush(); continue; }
    current += char;
    started = true;
  }
  flush();
  return tokens;
}

function baseName(token: string): string {
  const cleaned = token.replace(/^["']|["']$/g, '').trim();
  const last = cleaned.replace(/\\/g, '/').split('/').pop() ?? cleaned;
  return last.toLowerCase().replace(/\.(exe|com|bat|cmd|ps1|sh|py|js|mjs|cjs)$/, '');
}

function looksLikeSystemPath(target: string): boolean {
  const normalized = target.replace(/^["']|["']$/g, '').replace(/\\/g, '/');
  return SYSTEM_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Credential stores: readable-looking paths that are never legitimate input for
 * a coding task. An agent that can read these can exfiltrate every key on the
 * machine with one `cat`, and can write into `~/.ssh/authorized_keys` with one
 * `echo`. Lives here because both the command analyser and the file-tool path
 * fence in policy.ts need it, and this module has no dependencies.
 */
const CREDENTIAL_PATH_SEGMENTS = [
  '/.ssh/',
  '/.aws/',
  '/.gnupg/',
  '/.kube/',
  '/.docker/config.json',
  '/.git-credentials',
  '/.npmrc',
  '/.netrc',
  '/.pypirc',
  '/.config/gh/hosts.yml',
  '/.config/gcloud/',
  '/appdata/roaming/github desktop/',
  '/appdata/roaming/gnupg/',
  '/appdata/roaming/putty/',
];

export function isCredentialPath(target: string): boolean {
  // Pad with a trailing slash so a path that ENDS in one of these (`.ssh/id_rsa`)
  // still contains the `/dir/` needle.
  const normalized = `${target.replace(/\\/g, '/').toLowerCase()}/`;
  return CREDENTIAL_PATH_SEGMENTS.some((segment) => normalized.includes(segment));
}

/**
 * 解析删除目标真正落到哪里：绝对路径照写，`~` 展开成 home，相对路径相对工作区。
 * 只看字面量会漏掉 `rm -rf ../..`，也会漏掉 `rm -rf ../../other` 这种爬出去的写法。
 */
function resolveTarget(target: string, workspaceRoot?: string): string {
  const cleaned = target.replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleaned) return '';
  if (cleaned === '~' || cleaned.startsWith('~/')) return `~/${cleaned.slice(2)}`;
  const absolute = /^([a-z]:|\/)/i.test(cleaned) ? cleaned : `${(workspaceRoot ?? '.').replace(/\\/g, '/')}/${cleaned}`;
  const parts: string[] = [];
  for (const part of absolute.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  const joined = parts.join('/');
  return /^[a-z]:$/i.test(joined) ? `${joined}/` : joined;
}

function isInsideWorkspaceTarget(target: string, workspaceRoot?: string): boolean {
  const resolved = resolveTarget(target, workspaceRoot);
  if (!resolved || looksLikeSystemPath(resolved)) return false;
  if (resolved.startsWith('~')) return false;
  if (!workspaceRoot) return false;
  const root = resolveTarget(workspaceRoot);
  const lowered = resolved.toLowerCase();
  return lowered === root.toLowerCase() || lowered.startsWith(`${root.toLowerCase()}/`);
}

/** 参数里的旗标（/s、-rf），不是路径：单独一个 `/` 仍然是路径。 */
function isFlagToken(arg: string): boolean {
  if (arg.startsWith('-')) return true;
  // `/s`、`/q`、`/C:"text"`、`/out:path` 都是开关；`/tmp/x` 不是。
  return /^\/[a-z]{1,3}(?::|$)/i.test(arg);
}

/** 看起来是路径而不是开关/URL 的参数。 */
function isPathLike(arg: string): boolean {
  const cleaned = arg.replace(/^["']|["']$/g, '');
  if (!cleaned) return false;
  if (/^(?:https?|ftp):\/\//i.test(cleaned)) return false;
  // 绝对路径、`~`、`./`、`../` 开头，或带路径分隔符 —— 单独的文件名按工作区解析即可。
  return /^(?:[a-z]:|[\\/~]|\.\.?[\\/])/i.test(cleaned) || /[\\/]/.test(cleaned);
}

/** 是否是绝对目标（盘符、UNC、POSIX 根或 `~`），不看它落在哪个系统目录。 */
function isAbsoluteTarget(arg: string): boolean {
  const cleaned = arg.replace(/^["']|["']$/g, '');
  return /^(?:[a-z]:|[\\/]|~)/i.test(cleaned) || /^\.\.?[\\/]/.test(cleaned);
}

function normalizeForCompare(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function underAnyRoot(resolved: string, roots: string[]): boolean {
  const target = normalizeForCompare(resolved);
  return roots.some((root) => {
    const base = normalizeForCompare(root);
    return target === base || target.startsWith(`${base}/`);
  });
}

/**
 * 没有 workspaceRoot 信息时的读根：用户自己的目录、临时目录，以及所有盘符根
 * 之外的常见用户位置。系统目录（C:/Windows、/etc…）不在其中，所以「没给
 * 白名单」不再等于「随便读」。用 homedir 而不是字面量 `~`，才能和
 * resolveTarget 展开后的值对上。
 */
const DEFAULT_READ_ROOTS = (() => {
  const home = homedir().replace(/\\/g, '/');
  return [home, 'c:/users', 'd:/users', '/home', '/users', '/tmp', '/var/tmp'];
})();

/**
 * 一条命令里所有要出网的目标。URL 原样取；`ssh user@host` 这类只有 host 的，
 * 补一个假 scheme 再交给同一个判定函数。
 */
export function networkTargets(text: string, remoteShell = false): string[] {
  const found = [...text.matchAll(URL_PATTERN)].map((match) => match[0]);
  for (const match of text.matchAll(/\b[a-z0-9._-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)) {
    found.push(`https://${match[1]}`);
  }
  if (remoteShell) {
    // `ssh host`, `scp file host:` —— 裸主机名。
    for (const token of text.split(/\s+/)) {
      if (isFlagToken(token) || isPathLike(token) || token.includes('@')) continue;
      if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:\/|$)/i.test(token)) found.push(`https://${token.split(/[/:]/)[0]}`);
    }
  }
  return found;
}

/** `curl -o <path>` / `wget -O <path>` / `--output=<path>`：下载内容往哪写。 */
export function outputTargets(args: string[]): string[] {
  const targets: string[] = [];
  const flags = new Set(['-o', '--output', '-output', '-outfile', '--out', '-out']);
  for (const [index, arg] of args.entries()) {
    const lowered = arg.toLowerCase();
    if (flags.has(lowered)) {
      const next = args[index + 1];
      if (next && !isFlagToken(next)) targets.push(next);
      continue;
    }
    // `--output=C:\Windows\x` / `-OutFile:...` 这类连写形式。
    const inline = arg.match(/^(?:--output|-outfile|-out|-o)[=:](.+)$/i);
    if (inline && inline[1]) targets.push(inline[1]);
  }
  return targets;
}

/** `7z x a.7z -oC:\out` / `/out:path` 这类把目标写在开关里的形式。 */
function flagEmbeddedTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (const arg of args) {
    const inline = arg.match(/^(?:-[oO]|--out(?:put)?=|\/out:?)(.+)$/);
    if (inline && inline[1] && /^(?:[a-z]:|[\\/~]|\.\.?[\\/])/i.test(inline[1])) targets.push(inline[1]);
  }
  return targets;
}

/**
 * 重定向的目标文件：`echo hi > C:\Users\me\x.txt`。
 *
 * 写文件走的是 write 工具的路径围栏，而 `>` 绕过了它 —— 一条 `echo` 就能
 * 在工作区外落文件。这里把 `>`、`>>`、`2>` 后面的目标抓出来，按写路径判。
 */
export function redirectTargets(segment: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index] as string;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char !== '>') continue;
    // 吃掉 `>>`，再从下一个非空字符开始读目标。
    let cursor = index + 1;
    if (segment[cursor] === '>') cursor += 1;
    while (cursor < segment.length && /\s/.test(segment[cursor] as string)) cursor += 1;
    let target = '';
    let targetQuote: '"' | "'" | null = null;
    for (; cursor < segment.length; cursor += 1) {
      const next = segment[cursor] as string;
      if (targetQuote) {
        if (next === targetQuote) { targetQuote = null; continue; }
        target += next;
        continue;
      }
      if (next === '"' || next === "'") { targetQuote = next; continue; }
      if (/[\s;&|]/.test(next)) break;
      target += next;
    }
    // `2>&1` 这类是复制描述符，不是文件。
    if (target && !target.startsWith('&') && !target.startsWith('$')) targets.push(target);
    index = cursor - 1;
  }
  return targets;
}

/** 递归/强制标志：命中任一就要按危险删除处理。 */
function hasRecursiveFlag(program: string, args: string[]): boolean {
  const lowered = args.map((arg) => arg.toLowerCase());
  // 长写法 `rm --recursive --force` 在 GNU coreutils 与 BusyBox 里是同一条命令，
  // 但原来只认 `-r`/`-rf`，于是 `/` 或盘符根只被判成「需要确认」——再经
  // 「任意应用」就直接执行了。
  const longRecursive = lowered.some((arg) => arg === '--recursive' || arg === '--force' || arg.startsWith('--recursive=') || arg.startsWith('--force='));
  if (program === 'del' || program === 'erase') {
    return lowered.some((arg) => arg === '/s' || arg === '/f' || arg === '/q' || /^\/[sfq]{2,}$/.test(arg));
  }
  if (program === 'rmdir' || program === 'rd') {
    return lowered.some((arg) => arg === '/s' || /^\/[sq]{2,}$/.test(arg));
  }
  if (program === 'remove-item' || program === 'ri' || program === 'rni' || program === 'rm') {
    return longRecursive || lowered.some((arg) => /^-(r|re|rec|recursive|rf|fr|force|fo)$/.test(arg) || /^-\w*r\w*$/.test(arg));
  }
  return lowered.length > 0;
}

/**
 * `git` 子命令级的破坏性判断。由 policy 注入：policy 已经 import 本模块，
 * 反过来 import 会形成循环，而两份规则各写一遍又会漂移（shell 路径认得
 * `git rm`，工具路径不认）。
 */
export type DestructiveGitPredicate = (subcommand: string, rest: string) => boolean;

/** 从一段 token 里认出 git 真正的子命令（跳过 `-C dir` 这类全局开关的值）。 */
function gitInvocation(detailed: Array<{ text: string }>): { subcommand: string; rest: string } | null {
  const tokens = detailed.map((token) => token.text);
  const program = baseName(tokens[0] ?? '');
  if (program !== 'git') return null;
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] as string;
    if (/^(?:-C|--git-dir|--work-tree|-c|--namespace|--exec-path)$/.test(token)) { index += 2; continue; }
    if (token.startsWith('-')) { index += 1; continue; }
    break;
  }
  const subcommand = tokens[index];
  if (!subcommand) return null;
  return { subcommand: subcommand.toLowerCase(), rest: tokens.slice(index + 1).join(' ') };
}

type AnalyzeOptions = {
  workspaceRoot?: string;
  depth: number;
  piped: boolean;
  /** 允许读取的根目录；给了就按它判绝对路径的读参数。 */
  readRoots?: string[];
  /** 网络白名单；给了就按它判 curl/ssh 之类。 */
  networkAllowlist?: string[];
  /** git 子命令级破坏性判断（policy 注入）。 */
  destructiveGit?: DestructiveGitPredicate;
};

function analyzeTokens(
  detailed: Array<{ text: string; quoted: boolean }>,
  options: AnalyzeOptions,
): CommandAnalysis {
  const tokens = detailed.map((token) => token.text);
  const segments = [tokens.join(' ')];
  const [rawProgram = '', ...args] = tokens;
  const program = baseName(rawProgram);

  if (program === 'iex' || program === 'invoke-expression') {
    return { verdict: 'blocked', reason: '命令会执行动态拼接的字符串（Invoke-Expression / iex）', segments };
  }

  // `git` 子命令级的破坏性动作（reset --hard / clean -f / rm / stash clear …）。
  // 必须在分段内判：policy 层的同一个判断只看得到第一段，`cmd /c "git clean -fdx"`
  // 因此曾经整条放行。与 policy 的硬拒绝同一档：`git rm` / `git clean -f` 丢掉的
  // 工作区内容没有任何一条审批可以恢复，所以是 blocked 而不是 prompt。
  if (program === 'git' && options.destructiveGit) {
    const invocation = gitInvocation(detailed);
    if (invocation && options.destructiveGit(invocation.subcommand, invocation.rest)) {
      return {
        verdict: 'blocked',
        reason: `git ${invocation.subcommand} 会丢弃未提交的改动或删除引用，任何模式下都不自动执行`,
        segments,
      };
    }
  }

  if (BLOCKED_PROGRAMS.has(program)) {
    return { verdict: 'blocked', reason: `${program} 是磁盘/引导/电源级操作，不允许由智能体执行`, segments };
  }

  if (SCRIPT_HOSTS.has(program)) {
    return { verdict: 'prompt', reason: `${program} 会执行内容无法静态检查的脚本`, segments };
  }

  if (READ_PROGRAMS.has(program)) {
    // 不给 readRoots 不等于「不判」：先前这里只挡凭据目录，于是 `findstr /C:"x"
    // C:\Windows\win.ini` 这类整条命令里的绝对路径读参在 auto 模式（任意应用）
    // 下直接执行。fh 与 mkfs 那类无关；拿字面量根目录兜底，不需要调用方知道
    // 工作区在哪也能挡住系统路径。
    const explicitRoots = Boolean(options.readRoots && options.readRoots.length > 0);
    const roots = explicitRoots ? options.readRoots! : DEFAULT_READ_ROOTS;
    for (const arg of args.filter((item) => !isFlagToken(item))) {
      const resolved = resolveTarget(arg, options.workspaceRoot);
      if (isCredentialPath(resolved)) {
        return { verdict: 'blocked', reason: `${program} 在读凭据目录 ${arg}`, segments };
      }
      // 读工具的围栏不覆盖 `cat`：工作区 + 用户文档目录之外一律拒绝。
      // 有显式白名单时相对路径也一起判（它会按工作区解析）；只有兜底根时只判
      // 绝对路径 —— 相对路径落点未知，不能拿字面量根目录去误伤。
      const judged = explicitRoots ? isPathLike(arg) : isAbsoluteTarget(arg);
      if (judged && !underAnyRoot(resolved, roots)) {
        return { verdict: 'blocked', reason: `${program} 在读允许范围之外的路径 ${arg}`, segments };
      }
    }
  }

  if (COPY_PROGRAMS.has(program)) {
    // 目标也可能藏在开关里：`7z x a.7z -oC:\out`。
    const pathArgs = [...args.filter((item) => !isFlagToken(item) && isPathLike(item)), ...flagEmbeddedTargets(args)];
    for (const arg of pathArgs) {
      const resolved = resolveTarget(arg, options.workspaceRoot);
      if (isCredentialPath(resolved)) {
        return { verdict: 'blocked', reason: `${program} 碰到凭据目录 ${arg}`, segments };
      }
      // 搬运是双向的：源和目的都得在工作区里，`copy x C:\` 不该有商量余地。
      if (options.workspaceRoot && !isInsideWorkspaceTarget(arg, options.workspaceRoot)) {
        return { verdict: 'blocked', reason: `${program} 的参数在工作区之外 ${arg}`, segments };
      }
    }
  }

  if (NETWORK_PROGRAMS.has(program) || REMOTE_SHELL_PROGRAMS.has(program)) {
    for (const target of networkTargets(detailed.map((token) => token.text).join(' '), REMOTE_SHELL_PROGRAMS.has(program))) {
      // 没有配置白名单时不做网络判断（配置层负责），有白名单就一视同仁。
      if (!options.networkAllowlist) continue;
      const verdict = evaluateNetworkTarget(target, options.networkAllowlist);
      if (!verdict.ok) {
        return {
          verdict: 'blocked',
          reason: `${program} 访问 ${verdict.host ?? target}：${verdict.reason}`,
          segments,
        };
      }
    }
    // `curl -o <path>` 同样是写文件，走重定向那套判断。
    for (const target of outputTargets(args)) {
      const resolved = resolveTarget(target, options.workspaceRoot);
      if (isCredentialPath(resolved)) {
        return { verdict: 'blocked', reason: `${program} 往凭据目录写下载内容 ${target}`, segments };
      }
      if (options.workspaceRoot && !isInsideWorkspaceTarget(target, options.workspaceRoot)) {
        return { verdict: 'blocked', reason: `${program} 把下载内容写到工作区之外 ${target}`, segments };
      }
    }
  }

  if (PRIVILEGED_PROGRAMS.has(program)) {
    const lowered = args.map((arg) => arg.toLowerCase());
    const risky =
      (program === 'reg' && lowered.some((arg) => arg === 'add' || arg === 'delete' || arg === 'import')) ||
      (program === 'netsh' && lowered.some((arg) => arg === 'advfirewall' || arg === 'firewall')) ||
      (program === 'sc' && lowered.some((arg) => arg === 'delete' || arg === 'stop' || arg === 'config')) ||
      (program === 'net' && lowered.some((arg) => arg === 'user' || arg === 'localgroup')) ||
      (program === 'icacls' && lowered.some((arg) => arg === '/reset' || arg === '/grant' || arg === '/deny')) ||
      (program === 'takeown') ||
      (program === 'cipher' && lowered.some((arg) => arg.startsWith('/w'))) ||
      program.startsWith('set-mp') || program.startsWith('add-mp');
    if (risky) return { verdict: 'blocked', reason: `${program} 会修改系统安全配置/权限/账户`, segments };
  }

  if (DESTRUCTIVE_PROGRAMS.has(program)) {
    const targets = args.filter((arg) => !isFlagToken(arg));
    const recursive = hasRecursiveFlag(program, args);
    // 系统路径先判、且与递归无关：`del C:\Windows\*.*`（不带 /s）原来只被
    // 判成「需要确认」，再经「任意应用」就直接执行了。系统目录不是工作内容。
    for (const target of targets) {
      if (looksLikeSystemPath(resolveTarget(target, options.workspaceRoot))) {
        return { verdict: 'blocked', reason: `${program} 的删除目标落在系统路径 ${target}`, segments };
      }
    }
    if (!recursive) return { verdict: 'prompt', reason: `${program} 删除文件，需要确认`, segments };
    // 只有旗标没有目标（`del /s`）：范围等于「当前目录下的一切」，不给放行余地。
    if (targets.length === 0) {
      return { verdict: 'blocked', reason: `${program} 递归删除没有指定目标，范围不可控`, segments };
    }
    const outside = targets.some((target) => !isInsideWorkspaceTarget(target, options.workspaceRoot));
    if (outside) {
      return { verdict: 'blocked', reason: `${program} 的递归删除目标在工作区之外`, segments };
    }
    return { verdict: 'prompt', reason: `${program} 递归删除工作区内内容，需要确认`, segments };
  }

  // 管道把内容喂给解释器：`curl … | sh`、`iwr … | iex`、`… | bash`
  if (options.piped && INTERPRETERS.has(program)) {
    const evaluated = args.some((arg) => /^(-e|\/c|-c|-command|\/k)$/i.test(arg));
    if (evaluated || ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(program)) {
      return { verdict: 'blocked', reason: `管道把内容直接喂给 ${program} 执行`, segments };
    }
  }

  if (INTERPRETERS.has(program)) {
    if (options.depth >= 2) return { verdict: 'prompt', reason: '嵌套层级过深，无法可靠静态检查', segments };
    const lowered = args.map((arg) => arg.toLowerCase());
    // -EncodedCommand / -enc：解出来再看
    const encodedIndex = lowered.findIndex((arg) => ['-encodedcommand', '-enc', '-ec', '/encodedcommand'].includes(arg));
    if (encodedIndex >= 0 && args[encodedIndex + 1]) {
      const decoded = decodePowerShellEncoded(args[encodedIndex + 1] as string);
      if (!decoded) return { verdict: 'prompt', reason: 'EncodedCommand 无法解码，必须人工确认', segments };
      const inner = analyzeCommand(decoded, { ...options, depth: options.depth + 1 });
      if (inner.verdict !== 'ok') return { ...inner, segments: [...segments, ...inner.segments] };
      return { verdict: 'prompt', reason: 'EncodedCommand 解析后无危险特征，但仍需人工确认', segments };
    }
    const inlineIndex = lowered.findIndex((arg) => ['/c', '/k', '-c', '/command', '-command', '-e', '--eval', '-eval', '-p'].includes(arg));
    if (inlineIndex >= 0 && args[inlineIndex + 1]) {
      const inline = args.slice(inlineIndex + 1).join(' ');
      const inner = analyzeCommand(inline, { ...options, depth: options.depth + 1 });
      if (inner.verdict !== 'ok') return { ...inner, segments: [...segments, ...inner.segments] };
      const dangerous = findDangerousProgramInText(inline);
      if (dangerous) {
        const verdict: CommandVerdict = INLINE_BLOCKING_PROGRAMS.has(dangerous) ? 'blocked' : 'prompt';
        return {
          verdict,
          reason: `内联代码里出现危险程序名 ${dangerous}`,
          segments: [...segments, inline],
        };
      }
    }
  }

  // 包装器/循环里的动作不在首位：`for /r %i in (*) do del %i`、`find … -exec rm {} ;`
  // 扫一遍剩下的 token，命中危险程序就从那里重新按「一条命令」分析。
  // 任务运行器不扫：`npm run format` 里的 format 是脚本名。
  if (WRAPPERS.has(program) || !TASK_RUNNERS.has(program)) {
    for (const [index, token] of detailed.entries()) {
      if (index === 0 || token.quoted) continue;
      // `--pretty=format:%h` 这类是参数值，不是命令。
      if (token.text.includes('=') || token.text.startsWith('-')) continue;
      const hit = token.text
        .split(/[^A-Za-z0-9_.\-\\/:]+/)
        .map((piece) => baseName(piece))
        .find((piece) => SCANNABLE_PROGRAMS.has(piece));
      if (!hit) continue;
      const inner = analyzeTokens(detailed.slice(index), options);
      if (inner.verdict !== 'ok') return { ...inner, segments: [...segments, ...inner.segments] };
    }
  }

  return { verdict: 'ok', reason: '没有命中危险结构', segments };
}

/**
 * 分析整条命令。`workspaceRoot` 用于判断递归删除目标是否在工作区内：
 * 工作区内 → 需要确认；工作区外或系统路径 → 直接拒绝。
 */
export function analyzeCommand(
  command: string,
  options: {
    workspaceRoot?: string;
    depth?: number;
    /** 允许读取的根目录（policy 层给；不给就用 DEFAULT_READ_ROOTS 兜底）。 */
    readRoots?: string[];
    /** 网络白名单（policy 层给；不给就不判出网）。 */
    networkAllowlist?: string[];
    /** git 子命令级破坏性判断（policy 层给；不给就不做该判断）。 */
    destructiveGit?: DestructiveGitPredicate;
  } = {},
): CommandAnalysis {
  const depth = options.depth ?? 0;
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return { verdict: 'ok', reason: '空命令', segments: [] };
  const collected: string[] = [];
  let worst: CommandAnalysis = { verdict: 'ok', reason: '没有命中危险结构', segments: [] };
  const rank: Record<CommandVerdict, number> = { ok: 0, prompt: 1, blocked: 2 };
  for (const segment of segments) {
    const detailed = tokenizeDetailed(segment.text);
    if (detailed.length === 0) continue;
    const analysis = analyzeTokens(detailed, {
      workspaceRoot: options.workspaceRoot,
      depth,
      piped: segment.piped,
      readRoots: options.readRoots,
      networkAllowlist: options.networkAllowlist,
      destructiveGit: options.destructiveGit,
    });
    collected.push(...analysis.segments);
    if (rank[analysis.verdict] > rank[worst.verdict]) worst = { ...analysis, segments: collected };
    if (worst.verdict === 'blocked') return { ...worst, segments: collected };
    // `>` 绕过 write 工具的路径围栏：`echo hi > C:\Users\me\x.txt` 落文件在工作区外。
    for (const target of redirectTargets(segment.text)) {
      const resolved = resolveTarget(target, options.workspaceRoot);
      if (isCredentialPath(resolved)) {
        return { verdict: 'blocked', reason: `重定向写入凭据目录 ${target}`, segments: [...collected, segment.text] };
      }
      // 只有知道工作区在哪时才判断「外面」；不知道就挡系统路径、根目录和
      // 盘符根。之前没有 workspaceRoot 时 `>` 是直接放行的（`echo hi >
      // C:\x.txt` 走 `/run` 路径时无人问），这跟「写路径必须可判」相矛盾。
      if (looksLikeSystemPath(resolved) || (!options.workspaceRoot && isAbsoluteTarget(target))) {
        return { verdict: 'blocked', reason: `重定向写入系统路径 ${target}`, segments: [...collected, segment.text] };
      }
      if (options.workspaceRoot && !isInsideWorkspaceTarget(target, options.workspaceRoot)) {
        return { verdict: 'blocked', reason: `重定向写入工作区之外 ${target}`, segments: [...collected, segment.text] };
      }
    }
  }
  return { ...worst, segments: collected };
}
