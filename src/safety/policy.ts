import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ApprovalMode } from '../providers/types.js';
import { analyzeCommand, isCredentialPath, splitCommandSegments, tokenizeCommand } from './commandAnalysis.js';
import { evaluateNetworkTarget } from './network.js';

export type ToolRisk = 'read' | 'write' | 'shell' | 'network';

/**
 * How far a path may reach.
 *
 * The approval mode is the single tier knob: it already decides how often the
 * user is asked, and it now also decides the reachable file scope, so the two
 * cannot contradict each other. They used to be separate — `--approval` reached
 * the CLI while the desktop's 沙箱模式 never did — which made 「完全访问」 a
 * label that only reduced prompts without granting the access it named.
 *
 *   'workspace'    — workspace plus the read allowlist (Desktop/Documents/
 *                    Downloads/home). What every mode except 'auto' uses.
 *   'unrestricted' — any path on the machine. Only approval 'auto' (完全访问).
 */
export type PathScope = 'workspace' | 'unrestricted';

/**
 * Map an approval mode to its path scope.
 *
 * Only 完全访问 widens: every other mode keeps the existing allowlist, because
 * reading a Desktop document is behaviour users already rely on and narrowing
 * it would be a silent regression.
 */
export function pathScopeFor(approval: ApprovalMode): PathScope {
  return approval === 'auto' ? 'unrestricted' : 'workspace';
}

export type ApprovalDecision = {
  allowed: boolean;
  reason: string;
  needsPrompt: boolean;
};

/**
 * The `reason` a destructive (`alwaysPrompt`) call carries all the way to the
 * approval request. Exported because more than one consumer has to recognise
 * this specific prompt and refuse to answer it on the user's behalf: the
 * sub-agent confirm (there is no human to ask) and the auto-reviewer (a model
 * must not stand in for the last human check). Matching on the string keeps
 * those consumers from needing a new field threaded through the approval path;
 * `tests/subagent-destructive-guard.test.ts` pins it.
 */
export const DESTRUCTIVE_CONFIRM_REASON = 'destructive tool requires explicit confirmation';

/** True for an approval request that only a human may answer. */
export function isDestructiveApprovalRequest(request: { reason: string }): boolean {
  return request.reason === DESTRUCTIVE_CONFIRM_REASON;
}

/**
 * Legacy pattern list. `rm -rf` / `del /s` / `rmdir /s` used to live here and were
 * refused unconditionally — including `rm -rf ./dist`, which the agent needs to
 * clean build output. Those now go through `analyzeCommand`, which judges the
 * TARGET: system paths and anywhere outside the workspace are blocked, inside
 * the workspace is a prompt. What stays here is what no target can redeem.
 */
const blockedCommandPatterns = [
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

/**
 * Write-path resolution: confined to the workspace, unless the scope says
 * otherwise.
 *
 * The default is 'workspace' so every existing caller — and every test that
 * pins the confinement — keeps its behaviour without change.
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
  scope: PathScope = 'workspace',
) {
  const resolved = resolve(workspaceRoot, targetPath);
  if (scope === 'unrestricted') return resolved;
  const rel = relative(workspaceRoot, resolved);
  // `isAbsolute(rel)` is load-bearing on Windows: for a target on a DIFFERENT
  // drive, path.relative returns that drive's absolute path instead of a
  // `..`-prefixed one — `relative('C:/work', 'D:/x')` is `'D:\\x'`. Without this
  // check the guard saw a path not starting with `..` and admitted it, so any
  // other drive bypassed the workspace confinement entirely.
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !resolve(rel).startsWith('..'))) {
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
 *
 * Every spelling of a path is resolved against the SAME allowlist. It used to
 * be two different rules: a workspace-relative path went through
 * resolveWorkspacePath (workspace only), while an absolute path went through
 * assertUnderAllowedReadRoot (workspace, Desktop, Documents, Downloads, home).
 * So one file had two verdicts depending on how it was written —
 * `../cli/package.json` was refused while `C:/.../cli/package.json` was allowed,
 * both naming the same file. Whether a read worked came down to which form the
 * model happened to emit, which reads as an unreliable tool rather than a rule.
 */
export function resolveReadablePath(
  workspaceRoot: string,
  targetPath: string,
  scope: PathScope = 'workspace',
) {
  const raw = targetPath.trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new Error('path is required');
  const normalized = raw.replace(/\\/g, '/');

  if (/^desktop(\/|$)/i.test(normalized)) {
    const rest = normalized.replace(/^desktop\/?/i, '');
    const desktop = join(homedir(), 'Desktop');
    const resolved = rest ? resolve(desktop, rest) : desktop;
    if (scope === 'unrestricted') return resolved;
    assertUnderAllowedReadRoot(resolved, workspaceRoot);
    return resolved;
  }

  // Absolute: already unambiguous.
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    const resolved = resolve(raw);
    if (scope === 'unrestricted') return resolved;
    assertUnderAllowedReadRoot(resolved, workspaceRoot);
    return resolved;
  }

  // Relative: resolve it the same way, then apply the same allowlist. A path
  // that climbs out of the workspace is judged by where it LANDS, not by the
  // fact that it climbed — so `../cli/package.json` and its absolute spelling
  // now agree.
  const resolved = resolve(workspaceRoot, raw);
  if (scope === 'unrestricted') return resolved;
  try {
    assertUnderAllowedReadRoot(resolved, workspaceRoot);
    return resolved;
  } catch {
    // Preserve the friendlier Desktop alias: a bare filename may be meant as
    // Desktop/<name>, which the model writes without the `desktop/` prefix.
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

/**
 * Paths whose contents are credentials, not project files (list lives in
 * commandAnalysis so the shell analyser and this fence agree on one set).
 * Checked after the allowlist, so even `home` being allowed does not open them.
 */
/**
 * Roots a read may land in without further argument: the workspace plus the
 * user's own documents folders. Exported because the shell analyser judges
 * `cat`/`type` arguments by the same list — two copies of this would drift.
 */
export function readableRootsFor(workspaceRoot: string): string[] {
  return allowedReadRoots(workspaceRoot).map((root) => resolve(root));
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
  if (isCredentialPath(resolved)) {
    throw new Error(`Path not allowed for read: ${resolved}. Credential stores are off limits.`);
  }
  const roots = allowedReadRoots(workspaceRoot);
  if (roots.some((root) => isPathInside(root, resolved))) return;
  throw new Error(`Path not allowed for read: ${resolved}. Allowed: workspace, Desktop, Documents, Downloads, home.`);
}

function isPathInside(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Structured check, not just a regex sweep.
 *
 * The patterns above only recognise dangerous SPELLINGS (`rm -rf`, `del /s` at
 * the start of a segment). The analysis below recognises dangerous STRUCTURE:
 * interpreter wrappers (`cmd /c`, `powershell -EncodedCommand`), pipes into a
 * shell (`curl … | sh`), recursive deletes by any spelling or alias, and the
 * disk/boot/account-level programs the patterns never listed at all.
 */
export function isBlockedCommand(command: string, workspaceRoot?: string) {
  const trimmed = command.trim();
  if (blockedCommandPatterns.some((pattern) => pattern.test(trimmed))) return true;
  if (containsDestructiveGit(trimmed)) return true;
  return analyzeCommand(trimmed, { workspaceRoot, destructiveGit: isDestructiveGitInvocation }).verdict === 'blocked';
}

export function isAutoAllowedCommand(command: string) {
  const trimmed = command.trim();
  return !isBlockedCommand(trimmed) && autoAllowedCommandPatterns.some((pattern) => pattern.test(trimmed));
}

/**
 * True when the command launches one of the user's always-allowed apps.
 * Matches the first token (program name or path, quotes stripped) against the
 * configured list case-insensitively; also matches bare exe names with or
 * without the .exe suffix. Chained commands (a && b) never match.
 */
export function isAllowedAppCommand(command: string, apps?: string[]): boolean {
  if (!apps || apps.length === 0) return false;
  const trimmed = command.trim();
  if (/[;&|]/.test(trimmed)) return false;
  // Quoted program path takes precedence over whitespace tokenizing.
  const quoted = trimmed.match(/^"([^"]+)"/);
  const firstTokenRaw = quoted ? quoted[1]! : trimmed.split(/\s+/)[0] ?? '';
  const normalized = firstTokenRaw.toLowerCase();
  if (!normalized) return false;
  return apps.some((raw) => {
    const app = raw.trim().toLowerCase();
    if (!app) return false;
    const base = app.endsWith('.exe') ? app.slice(0, -4) : app;
    // Path entry (contains / or \): exact or suffix match against full token.
    // Bare name entry: compare against the token's basename so both
    // "python" and "C:/tools/python.exe" match the entry "python".
    const isPathEntry = /[\\/]/.test(app);
    const tokenBasename = normalized.split(/[\\/]/).pop() ?? '';
    const tokenNoExe = tokenBasename.endsWith('.exe') ? tokenBasename.slice(0, -4) : tokenBasename;
    if (normalized === app || normalized === base) return true;
    if (normalized.endsWith(`\\${app}`) || normalized.endsWith(`/${app}`)) return true;
    if (base && (normalized.endsWith(`\\${base}`) || normalized.endsWith(`/${base}`))) return true;
    if (!isPathEntry && (tokenBasename === app || tokenBasename === base || tokenNoExe === base)) return true;
    return false;
  });
}

/**
 * Position-independent destructive git detection for `decideApproval`'s shell
 * branch.
 *
 * The old head-only regex only ever saw the FIRST command in a string, so
 * `npm test && git rm -r src`, `cmd /c "git clean -fdx"` and `git push -f`
 * (short form) all walked past it. Segmenting the string with the same
 * quote-aware splitter the analyser uses, then resolving the real subcommand
 * per segment, closes the chain and the interpreter wrapper. Nested wrappers
 * (`cmd /c "…"`) are still covered by `analyzeCommand`'s own recursion.
 */
function containsDestructiveGit(command: string): boolean {
  for (const segment of splitCommandSegments(command)) {
    const tokens = tokenizeCommand(segment.text);
    if (!tokens.length) continue;
    const program = tokens[0]!.trim().replace(/^["']|["']$/g, '').split(/[/\\]/).pop()?.toLowerCase() ?? '';
    if (!/^git(?:\.exe)?$/.test(program)) continue;
    // Skip global options and their values (`git -C dir push -f`), then judge
    // the subcommand with the same rule set the analyser uses.
    let index = 1;
    while (index < tokens.length && tokens[index]!.startsWith('-')) {
      index += /^(?:-C|--git-dir|--work-tree|-c|--namespace|--exec-path)$/i.test(tokens[index]!) ? 2 : 1;
    }
    const subcommand = tokens[index];
    if (subcommand && isDestructiveGitInvocation(subcommand.toLowerCase(), tokens.slice(index + 1).join(' '))) return true;
  }
  return false;
}

/**
 * The git rule set, exported so `analyzeCommand` can apply it inside segments.
 *
 * `policy` imports `commandAnalysis`, so the rule lives here and is INJECTED
 * into the analyser rather than imported back. One copy matters: `git rm`,
 * `stash clear`, `update-ref -d` and short `push -f` all used to exist in
 * exactly one of the two places, and the shell path was the one missing them.
 */
export function isDestructiveGitInvocation(subcommand: string, rest: string): boolean {
  if (subcommand === 'reset' && /(?:^|\s)--hard(?:\s|$)/i.test(rest)) return true;
  if (subcommand === 'clean' && /(?:^|\s)-(?:d*[a-z]*f[a-z]*)(?:\s|$)/i.test(rest)) return true;
  if ((subcommand === 'checkout' || subcommand === 'restore') && /(?:^|\s)(?:-f|--force)(?:\s|$)/i.test(rest)) return true;
  // `git push -f` was not covered by the long-form-only rule, so a short-form
  // force push passed and — in auto mode with 任意应用 — ran with no prompt.
  if (subcommand === 'push' && /(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|$)/i.test(rest)) return true;
  // `-D`/`-d` branch delete has a dedicated tool; a bare shell invocation of it
  // is not recoverable from the shell.
  if (subcommand === 'branch' && /(?:^|\s)(?:-d|-D|--delete)(?:\s|$)/i.test(rest)) return true;
  // Every other `git rm` is a working-tree delete git will not hand back from
  // the index; `--cached` is the recoverable unstage.
  if (subcommand === 'rm' && !/(?:^|\s)--cached(?:\s|$)/i.test(rest)) return true;
  if (subcommand === 'stash' && /^\s*(?:clear|drop)\b/i.test(rest)) return true;
  if (subcommand === 'tag' && /(?:^|\s)(?:-d|--delete)(?:\s|$)/i.test(rest)) return true;
  if (subcommand === 'update-ref' && /(?:^|\s)(?:-d|--delete)(?:\s|$)/i.test(rest)) return true;
  // History pruning: unreachable commits become garbage immediately.
  if (subcommand === 'reflog' && /^\s*expire\b/i.test(rest) && /(?:--all|--expire=now)(?:\s|$)/i.test(rest)) return true;
  if (subcommand === 'gc' && /(?:^|\s)--prune=now(?:\s|$)/i.test(rest)) return true;
  return false;
}

/**
 * True when a shell command contains a git working-tree discard — anywhere in
 * the string, including inside `cmd /c "…"`.
 *
 * `git restore <paths>` drops uncommitted edits (recoverable only from an
 * editor's history). `git restore --staged` only unstages, and `git checkout
 * <branch>` only switches, so neither is destructive here. The analyser already
 * hard-blocks `-f/--force` and `reset --hard`; this is about the "safe-looking"
 * restore form that still destroys work.
 */
function isDestructiveShellGit(command: string): boolean {
  const lowered = command.toLowerCase().replace(/\\/g, '/');
  for (const match of lowered.matchAll(/git(?:\.exe)?\s+restore\b([^&|;\n]*)/g)) {
    if (!/(?:^|\s)--staged(?:\s|$)/.test(match[1] ?? '')) return true;
  }
  for (const match of lowered.matchAll(/git(?:\.exe)?\s+checkout\b([^&|;\n]*)/g)) {
    const rest = (match[1] ?? '').trim();
    // `git checkout -- <paths>` and `git checkout .` overwrite working-tree
    // files; `git checkout main` / `-b x` just switch or create a branch.
    //
    // `git checkout <commit-ish> -- <paths>` is the same discard with the
    // restore point named: `git checkout HEAD~1 -- src/app.ts` writes the old
    // blob over uncommitted edits. Only a BARE `--` is the path separator —
    // `--detach`/`--ours` are options — so the token needs space around it.
    if (rest === '--' || rest.startsWith('-- ') || rest.startsWith('- -') || rest.startsWith('.')) return true;
    if (/(?:^|\s)--(?:\s|$)/.test(rest)) return true;
  }
  return false;
}

// Directories under the workspace that must never be auto-written even in
// `auto` mode: version-control internals and dependency/build output where an
// accidental write is high blast-radius.
const protectedWorkspaceDirs = ['.git/', 'node_modules/'];

/**
 * Whether `auto` mode may write this target without asking.
 *
 * Returns false rather than throwing on a path the scope does not reach. It
 * used to let resolveWorkspacePath's throw escape, and decideApproval does not
 * catch it while registry.execute calls decideApproval OUTSIDE its try block —
 * so a write outside the workspace raised an unhandled error instead of
 * producing an ordinary denial the model can read and recover from.
 */
export function isAutoAllowedWrite(
  workspaceRoot: string,
  targetPath: string,
  scope: PathScope = 'workspace',
) {
  const normalizedTarget = targetPath.replace(/\\/g, '/').toLowerCase();
  if (normalizedTarget.startsWith('desktop/') && normalizedTarget.endsWith('.docx')) return true;

  let resolved: string;
  try {
    resolved = resolveWorkspacePath(workspaceRoot, targetPath, scope);
  } catch {
    return false;
  }

  const rel = relative(workspaceRoot, resolved).replace(/\\/g, '/');
  // Historical smoke/test fixture allowlist kept explicit so audits and smoke
  // runs stay stable: .smoke/, cli/.smoke/, cli/tests/fixtures/, .aicode-smoke/.
  const relLower = rel.toLowerCase();
  // A path outside the workspace has a leading `..`, so it can never match a
  // protected prefix below — protection applies to the workspace's own
  // internals, which is what those directories are.
  if (protectedWorkspaceDirs.some((dir) => relLower === dir.slice(0, -1) || relLower.startsWith(dir))) return false;
  return true;
}

/**
 * The verdicts that no mode may lift: SSRF/private targets, blocked network
 * hosts, and destructive command structure. Extracted from the shell/network
 * branches so the top of `decideApproval` can apply them before `plan` or
 * `alwaysPrompt` get a chance to turn "blocked" into "ask".
 *
 * Returns the refusal reason, or null when nothing hard-denies.
 */
function hardDenyReason(options: {
  risk: ToolRisk;
  command?: string;
  url?: string;
  networkAllowlist?: string[];
  workspaceRoot: string;
}): string | null {
  if (options.risk === 'network') {
    const verdict = evaluateNetworkTarget(options.url ?? '', options.networkAllowlist ?? []);
    return verdict.ok ? null : verdict.reason;
  }
  if (options.risk !== 'shell') return null;
  const command = options.command ?? '';
  const analysis = analyzeCommand(command, {
    workspaceRoot: options.workspaceRoot,
    readRoots: readableRootsFor(options.workspaceRoot),
    networkAllowlist: options.networkAllowlist,
    destructiveGit: isDestructiveGitInvocation,
  });
  if (analysis.verdict === 'blocked') return `blocked destructive command pattern: ${analysis.reason}`;
  if (blockedCommandPatterns.some((pattern) => pattern.test(command.trim()))) return 'blocked destructive command pattern';
  if (containsDestructiveGit(command.trim())) return 'blocked destructive command pattern';
  return null;
}

/**
 * Network verdicts live in `./network.ts` (the shell analyser shares them) and
 * are re-exported here so existing imports keep working.
 */
export { evaluateNetworkTarget, isBlockedNetworkHost, hostMatchesAllowlist } from './network.js';

export function decideApproval(options: {
  mode: ApprovalMode;
  risk: ToolRisk;
  command?: string;
  targetPath?: string;
  url?: string;
  networkAllowlist?: string[];
  autoApprove?: boolean;
  /**
   * Tools that destroy work the model cannot reconstruct must never be approved
   * silently. Unlike `autoApprove` (which skips the allowlist), this forces the
   * interactive prompt even in `auto` mode, and the registry refuses the call
   * when no confirmation handler is available.
   */
  alwaysPrompt?: boolean;
  /** Desktop "任意应用" setting: auto mode may run any non-destructive command. */
  computerAnyApp?: boolean;
  /** Desktop "始终允许的应用" list: app names/paths exempt from confirmation. */
  allowedApps?: string[];
  /**
   * Computer-control tools are live this turn (session armed via /computer use,
   * or auto-wake). Their shell-risk GUI actions carry no `command` string, so
   * the command allowlists below never match — in auto mode they run directly;
   * ask mode still confirms each click/keystroke via the prompt path below.
   */
  computerUse?: boolean;
  workspaceRoot: string;
}): ApprovalDecision {
  if (options.risk === 'read') return { allowed: true, needsPrompt: false, reason: 'read-only tool' };
  // HARD DENY is decided FIRST, before any mode branch. `plan` and `alwaysPrompt`
  // both answer "prompt" for anything they see, so while `plan` sat above the
  // shell branch a blocked command (`rm -rf /`, cloud-metadata curl) came back
  // as `allowed: true, needsPrompt: true` — one human or auto-reviewer yes away
  // from executing what every mode is supposed to refuse. The user still gets a
  // plan-mode prompt for whatever is NOT hard-denied, below.
  if (options.mode !== 'deny') {
    const hardDeny = hardDenyReason(options);
    if (hardDeny) return { allowed: false, needsPrompt: false, reason: hardDeny };
  }
  if (options.mode === 'deny') return { allowed: false, needsPrompt: false, reason: 'approval mode denies write, shell, and network tools' };
  // Irreversible tools (e.g. `git restore`, which discards uncommitted edits)
  // are never approved silently, in ANY mode: the user must see the exact
  // targets before the work is destroyed. The registry turns `needsPrompt`
  // without a confirmation handler into a refusal rather than a silent run.
  //
  // This branch sits ABOVE the plan-mode branch on purpose. It used to sit
  // below it, so plan mode answered first with its generic reason and the
  // destructive marker was lost: the broker then cached an `allow_session` from
  // an ordinary plan-mode write under `write:git_restore`, and the next
  // destructive `git restore` was answered from that cache without a word.
  if (options.alwaysPrompt) return { allowed: true, needsPrompt: true, reason: DESTRUCTIVE_CONFIRM_REASON };
  // plan mode: allow reads freely, prompt before every write/shell/network action
  if (options.mode === 'plan') {
    // A shell working-tree discard keeps its destructive marker in plan mode
    // too: otherwise the same `git restore .` that is non-reviewable in ask
    // mode becomes reviewable here, and a model reviewer can answer it.
    const destructiveShell = options.risk === 'shell' && isDestructiveShellGit(options.command ?? '');
    return {
      allowed: true,
      needsPrompt: true,
      reason: destructiveShell ? DESTRUCTIVE_CONFIRM_REASON : 'plan mode requires confirmation before every change',
    };
  }

  if (options.computerUse && options.risk === 'shell' && !options.command) {
    if (options.mode === 'auto') {
      return { allowed: true, needsPrompt: false, reason: 'computer use armed: GUI action runs in auto mode' };
    }
  }

  if (options.risk === 'network') {
    const verdict = evaluateNetworkTarget(options.url ?? '', options.networkAllowlist ?? []);
    if (!verdict.ok) {
      return { allowed: false, needsPrompt: false, reason: verdict.reason };
    }
    // Allowlisted host: auto mode proceeds without a prompt; ask mode still
    // confirms each outbound request so the user sees where data is going.
    if (options.mode === 'ask') {
      return { allowed: true, needsPrompt: true, reason: 'interactive approval required for network request' };
    }
    return { allowed: true, needsPrompt: false, reason: verdict.reason };
  }

  if (options.risk === 'shell') {
    const command = options.command ?? '';
    const analysis = analyzeCommand(command, {
      workspaceRoot: options.workspaceRoot,
      // 读工具的白名单和网络白名单同样约束 shell：`cat` 与 `curl` 不该
      // 因为换了层就绕过去。
      readRoots: readableRootsFor(options.workspaceRoot),
      networkAllowlist: options.networkAllowlist,
      // 同一份 git 破坏性规则也用在分段里：`cmd /c "git clean -fdx"` 的第一段
      // 是 cmd，policy 的整串判断看不到里面的 git。
      destructiveGit: isDestructiveGitInvocation,
    });
    // Destructive commands are ALWAYS blocked — anyApp/allowedApps never lift
    // this. The structured verdict comes first so the refusal names the real
    // reason (which target, which program) instead of a generic pattern hit.
    const legacyBlocked =
      analysis.verdict !== 'blocked' &&
      (blockedCommandPatterns.some((pattern) => pattern.test(command.trim())) || containsDestructiveGit(command.trim()));
    if (analysis.verdict === 'blocked' || legacyBlocked) {
      return {
        allowed: false,
        needsPrompt: false,
        reason:
          analysis.verdict === 'blocked'
            ? `blocked destructive command pattern: ${analysis.reason}`
            : 'blocked destructive command pattern',
      };
    }
    // Explicitly allowed apps run without confirmation in both auto and ask mode.
    if (isAllowedAppCommand(command, options.allowedApps)) {
      return { allowed: true, needsPrompt: false, reason: 'command runs an always-allowed app' };
    }
    // Structural suspicion that is not automatically fatal — a workspace-scoped
    // recursive delete, a script host, an undecodable -EncodedCommand — must be
    // seen by a human even in auto mode. 完全访问 means "don't ask about the
    // ordinary", not "don't ask about this".
    //
    // The prompt reason must NAME the destructive structural verdict it is
    // asking about. `git restore .` (the shell form — always a working-tree
    // discard) reaches this branch and used to carry the generic `confirmation
    // required: …` reason, which every destructive-aware consumer keys on: the
    // broker cached an `allow_session` for it, the auto-reviewer was allowed to
    // answer it, and in plan mode a cached yes could then answer the next one.
    // Carrying DESTRUCTIVE_CONFIRM_REASON is what makes the existing exemptions
    // apply to shell git discards without threading a new field.
    if (analysis.verdict === 'prompt') {
      return {
        allowed: true,
        needsPrompt: true,
        reason: isDestructiveShellGit(command) ? DESTRUCTIVE_CONFIRM_REASON : `confirmation required: ${analysis.reason}`,
      };
    }
    // A shell working-tree discard (`git restore .`) is destructive even
    // though the analyser has no `blocked` vote for it: it must be asked about
    // in auto/任意应用 too, and its reason must be the marker the broker and
    // the reviewer key on — otherwise "allow this session" from an ordinary
    // command would answer the next discard silently.
    if (isDestructiveShellGit(command)) {
      return { allowed: true, needsPrompt: true, reason: DESTRUCTIVE_CONFIRM_REASON };
    }
    // "任意应用": auto mode may run any non-destructive command.
    if (options.mode === 'auto' && options.computerAnyApp) {
      return { allowed: true, needsPrompt: false, reason: 'computerAnyApp allows non-destructive commands in auto mode' };
    }
    // A plugin the user explicitly marked autoApprove bypasses the built-in
    // shell allowlist in auto mode (governance handed to the manifest author),
    // but still passes the destructive blocklist above.
    if (options.mode === 'auto' && !options.autoApprove && !isAutoAllowedCommand(command)) {
      return { allowed: false, needsPrompt: false, reason: 'command is not in auto approval allowlist' };
    }
  }

  if (options.risk === 'write' && options.mode === 'auto' && !options.autoApprove) {
    // autoApprove marks a curated safe write (e.g. built-in git write operations
    // that carry no path target and have destructive variants already excluded).
    // Such tools skip the path allowlist in auto mode but, like every write,
    // still prompt in ask mode and are refused in deny mode.
    if (!options.targetPath || !isAutoAllowedWrite(options.workspaceRoot, options.targetPath, pathScopeFor(options.mode))) {
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
