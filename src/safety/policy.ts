import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ApprovalMode } from '../providers/types.js';

export type ToolRisk = 'read' | 'write' | 'shell';

export type ApprovalDecision = {
  allowed: boolean;
  reason: string;
  needsPrompt: boolean;
};

const blockedCommandPatterns = [
  /(^|[;&|])\s*rm\s+-rf(\s|$)/i,
  /(^|[;&|])\s*del\s+\/s(\s|$)/i,
  /(^|[;&|])\s*rmdir\s+\/s(\s|$)/i,
  /(^|[;&|])\s*format(\s|$)/i,
  /(^|[;&|])\s*shutdown(\.exe)?(\s|$)/i,
  /(^|[;&|])\s*poweroff(\s|$)/i,
  /(^|[;&|])\s*reboot(\s|$)/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;/,
];

const autoAllowedCommandPatterns = [
  /^node\s+--version$/i,
  /^npm\s+--version$/i,
  /^npm\s+run\s+(typecheck|build|test|smoke|audit:100)$/i,
  /^npm\s+test$/i,
  /^pwd$/i,
  /^whoami$/i,
  /^date(\s+\/t)?$/i,
  /^time(\s+\/t)?$/i,
  /^ver$/i,
  /^git(?:\.exe)?\s+status(?:\s+--(?:short|branch|porcelain(?:=v1)?))*$/i,
  /^git(?:\.exe)?\s+diff(?:\s+--(?:cached|stat|name-only))*$/i,
  /^git(?:\.exe)?\s+log(?:\s+--(?:oneline|decorate|all)|\s+-n\s+\d+)*$/i,
  /^git(?:\.exe)?\s+branch\s+--(?:show-current|list)$/i,
  /^ls(\s+[-\w.\/]+)*$/i,
  /^dir(\s+[-\w.\\/]+)*$/i,
  /^wmic\s+logicaldisk\s+get\s+/i,
  /^fsutil\s+volume\s+diskfree\s+[a-z]:\\?$/i,
  /^powershell(\.exe)?\s+(-NoProfile\s+)?(-Command\s+)?"?\s*Get-PSDrive\s+-Name\s+[A-Za-z]/i,
  /^powershell(\.exe)?\s+(-NoProfile\s+)?(-Command\s+)?"?\s*Get-CimInstance\s+Win32_LogicalDisk/i,
];

export function resolveWorkspacePath(workspaceRoot: string, targetPath: string) {
  const resolved = resolve(workspaceRoot, targetPath);
  const rel = relative(workspaceRoot, resolved);
  if (rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith('..'))) {
    return resolved;
  }
  throw new Error(`Path escapes workspace: ${targetPath}`);
}

/**
 * Read-only path resolution. Allows:
 * - workspace-relative paths
 * - desktop/... and bare desktop filenames
 * - absolute paths under home Desktop / Documents / Downloads / home / workspace
 * Writes still use resolveWorkspacePath (except dedicated desktop tools).
 */
export function resolveReadablePath(workspaceRoot: string, targetPath: string) {
  const raw = targetPath.trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('path is required');
  const normalized = raw.replace(/\\/g, '/');

  if (/^desktop(\/|$)/i.test(normalized)) {
    const rest = normalized.replace(/^desktop\/?/i, '');
    const desktop = join(homedir(), 'Desktop');
    const resolved = rest ? resolve(desktop, rest) : desktop;
    assertUnderAllowedReadRoot(resolved, workspaceRoot);
    return resolved;
  }

  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    const resolved = resolve(raw);
    assertUnderAllowedReadRoot(resolved, workspaceRoot);
    return resolved;
  }

  try {
    return resolveWorkspacePath(workspaceRoot, raw);
  } catch {
    // Fall through: maybe user meant Desktop/file without the desktop/ prefix
    const desktopCandidate = resolve(join(homedir(), 'Desktop'), raw);
    if (isPathInside(join(homedir(), 'Desktop'), desktopCandidate)) {
      return desktopCandidate;
    }
    throw new Error(`Path escapes workspace: ${targetPath}`);
  }
}

export function isInsideWorkspace(workspaceRoot: string, targetPath: string) {
  try {
    resolveWorkspacePath(workspaceRoot, targetPath);
    return true;
  } catch {
    return false;
  }
}

function allowedReadRoots(workspaceRoot: string) {
  const home = homedir();
  return [
    resolve(workspaceRoot),
    join(home, 'Desktop'),
    join(home, 'Documents'),
    join(home, 'Downloads'),
    home,
  ];
}

function assertUnderAllowedReadRoot(resolved: string, workspaceRoot: string) {
  const roots = allowedReadRoots(workspaceRoot);
  if (roots.some((root) => isPathInside(root, resolved))) return;
  throw new Error(`Path not allowed for read: ${resolved}. Allowed: workspace, Desktop, Documents, Downloads, home.`);
}

function isPathInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isBlockedCommand(command: string) {
  const trimmed = command.trim();
  if (blockedCommandPatterns.some((pattern) => pattern.test(trimmed))) return true;
  return isDestructiveGitCommand(trimmed);
}

export function isAutoAllowedCommand(command: string) {
  const trimmed = command.trim();
  return !isBlockedCommand(trimmed) && autoAllowedCommandPatterns.some((pattern) => pattern.test(trimmed));
}

function isDestructiveGitCommand(command: string) {
  const match = command.match(/^git(?:\.exe)?\s+((?:(?:-[a-zA-Z]|--[a-zA-Z0-9][a-zA-Z0-9-]*)(?:\s+[^\s]+)?\s+)*)([a-zA-Z0-9][\w-]*)\b(.*)$/i);
  if (!match) return false;
  const subcommand = (match[2] ?? '').toLowerCase();
  const rest = match[3] ?? '';
  if (subcommand === 'reset' && /(?:^|\s)--hard(?:\s|$)/i.test(rest)) return true;
  if (subcommand === 'clean' && /(?:^|\s)-(?:f|fd|fdx|fx|dff|dfx|x)+/i.test(rest)) return true;
  if ((subcommand === 'checkout' || subcommand === 'restore') && /(?:^|\s)(?:-f|--force)(?:\s|$)/i.test(rest)) return true;
  if (subcommand === 'push' && /(?:^|\s)--force(?:-with-lease)?(?:\s|$)/i.test(rest)) return true;
  if (subcommand === 'branch' && /(?:^|\s)(?:-[dD]|--delete)(?:\s|$)/i.test(rest)) return true;
  return false;
}

export function isAutoAllowedWrite(workspaceRoot: string, targetPath: string) {
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  if (normalizedTarget.startsWith('desktop/') && normalizedTarget.endsWith('.docx')) return true;
  const resolved = resolveWorkspacePath(workspaceRoot, targetPath);
  const rel = relative(workspaceRoot, resolved).replace(/\\/g, '/');
  return rel.startsWith('.smoke/') || rel.startsWith('cli/.smoke/') || rel.startsWith('cli/tests/fixtures/') || rel.startsWith('.aicode-smoke/');
}

export function decideApproval(options: {
  mode: ApprovalMode;
  risk: ToolRisk;
  command?: string;
  targetPath?: string;
  workspaceRoot: string;
}): ApprovalDecision {
  if (options.risk === 'read') return { allowed: true, needsPrompt: false, reason: 'read-only tool' };
  if (options.mode === 'deny') return { allowed: false, needsPrompt: false, reason: 'approval mode denies write and shell tools' };

  if (options.risk === 'shell') {
    const command = options.command ?? '';
    if (isBlockedCommand(command)) return { allowed: false, needsPrompt: false, reason: 'blocked destructive command pattern' };
    if (options.mode === 'auto' && !isAutoAllowedCommand(command)) {
      return { allowed: false, needsPrompt: false, reason: 'command is not in auto approval allowlist' };
    }
  }

  if (options.risk === 'write' && options.mode === 'auto') {
    if (!options.targetPath || !isAutoAllowedWrite(options.workspaceRoot, options.targetPath)) {
      return { allowed: false, needsPrompt: false, reason: 'write target is not in auto approval allowlist' };
    }
  }

  if (options.mode === 'ask') {
    return { allowed: true, needsPrompt: true, reason: 'interactive approval required' };
  }

  return { allowed: true, needsPrompt: false, reason: 'auto approval allowlist' };
}

export async function askForApproval(message: string, options?: { locale?: 'zh' | 'en' }) {
  const rl = createInterface({ input, output });
  try {
    const suffix = options?.locale === 'zh' ? ' [y是/N否] ' : ' [y/N] ';
    // Avoid double suffix if caller already appended one.
    const prompt = /\[y\/N\]|\[y是\/N否\]/i.test(message) ? `${message} ` : `${message}${suffix}`;
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === '是' || answer === '好' || answer === '确认';
  } finally {
    rl.close();
  }
}
