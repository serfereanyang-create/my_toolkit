'use strict';
/**
 * sandbox.cjs — desktop-side sandbox policy for agent tool approvals.
 *
 * The CLI asks the desktop to decide every risky tool call via an
 * `approval_needed` event. Before the user is ever prompted, the main process
 * runs the event through this pure policy engine. Three modes:
 *
 *  'off'       — no interception; every approval goes to the user (default).
 *  'workspace' — auto-DENY anything that provably escapes the sandbox:
 *                file writes outside the workspace root, and shell commands
 *                matching a conservative destructive-pattern list.
 *                Everything else still asks the user.
 *  'strict'    — workspace rules PLUS: read-risk tools are auto-APPROVED
 *                (no prompt), and shell/network writes are auto-denied
 *                outright. Only in-workspace writes ask.
 *
 * The engine is pure and synchronous: evaluate(event, policy) →
 *  { decision: 'pass' | 'allow' | 'deny', reason?: string }.
 * 'pass' means "let the user decide" — the caller forwards the event
 * untouched. 'allow'/'deny' mean the main process answers the CLI broker
 * immediately and annotates the event so the UI card shows why.
 *
 * Security note: this is a UX/blast-radius guard layered on top of the CLI's
 * own approval flow, NOT a substitute for OS sandboxing. Pattern matching is
 * deliberately conservative (deny only on clear matches) so ambiguous commands
 * still reach a human.
 */

// Destructive shell fragments, matched case-insensitively against the
// whitespace-normalised command text. indexOf-based (no regex) to keep the
// matcher trivially auditable and immune to backtracking pathologies.
const DANGEROUS_SHELL = [
  'rm -rf /', 'rm -rf ~', 'rm -rf *', 'rmdir /s', 'del /f /s /q c:',
  'format c:', 'mkfs', 'dd if=', 'diskpart', 'shutdown', 'reboot',
  ':(){', 'fork bomb', '/dev/sda', 'physicaldrive',
  'curl | sh', 'curl|sh', 'wget | sh', 'wget|sh', 'Invoke-WebRequest | iex', 'iwr | iex', 'iex(',
  'Set-MpPreference -Disable', 'reg add', 'schtasks /create',
  'chmod -R 777 /', 'chown -R', 'sudo ', 'runas ',
  'git push --force', 'git push -f', 'Reset-ComputerMachinePassword',
];

/** Normalise separators/case for containment checks. */
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
}

/**
 * Resolve `.` and `..` segments so containment cannot be fooled by traversal.
 * `<root>/../../Windows/x` must not read as "inside <root>". Over-popping is
 * clamped at the drive/root marker: the result only ever moves toward the
 * filesystem root, which can only make `isInside` MORE likely to say no.
 */
function normalizeSegments(p) {
  const raw = normPath(p);
  const out = [];
  for (const part of raw.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  const joined = out.join('/');
  if (raw.startsWith('/')) return `/${joined}`;
  return joined;
}

/** True when `target` is inside `root` (or equal to it). */
function isInside(root, target) {
  const r = normalizeSegments(root).replace(/\/+$/, '');
  const t = normalizeSegments(target);
  if (!r) return false;
  return t === r || t.startsWith(r + '/');
}

/** Whitespace-collapsed lowercase command text for substring matching. */
function normCommand(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function matchesDangerous(command) {
  const c = normCommand(command);
  if (!c) return null;
  for (const pattern of DANGEROUS_SHELL) {
    if (c.includes(pattern.toLowerCase())) return pattern;
  }
  return null;
}

/** Extract the best-effort target path from an approval event. */
function eventPath(event) {
  const input = event && event.input;
  if (input && typeof input === 'object') {
    if (typeof input.path === 'string' && input.path) return input.path;
    if (typeof input.file === 'string' && input.file) return input.file;
    // copy_file writes to `to` (its `from` may legitimately sit outside the
    // workspace), so the destination is the path the containment check needs.
    if (typeof input.to === 'string' && input.to) return input.to;
  }
  if (event && event.diff && typeof event.diff.path === 'string') return event.diff.path;
  return null;
}

/** Extract the shell command text if this is a shell-ish approval. */
function eventCommand(event) {
  const input = event && event.input;
  if (!input || typeof input !== 'object') return null;
  if (typeof input.command === 'string' && input.command) return input.command;
  if (typeof input.cmd === 'string' && input.cmd) return input.cmd;
  return null;
}

/**
 * Evaluate one `approval_needed` event against the policy.
 *
 * @param {object} event  approval_needed payload from the CLI
 * @param {object} policy { mode: 'off'|'workspace'|'strict', workspaceRoot: string }
 * @returns {{decision: 'pass'|'allow'|'deny', reason?: string}}
 */
function evaluate(event, policy) {
  const mode = policy && typeof policy.mode === 'string' ? policy.mode : 'off';
  if (mode === 'off') return { decision: 'pass' };
  if (!event || event.type !== 'approval_needed') return { decision: 'pass' };

  const risk = String(event.risk || 'write');
  const command = eventCommand(event);
  const target = eventPath(event);
  const root = policy.workspaceRoot;

  // Shell: destructive patterns are denied in every non-off mode; in strict
  // mode ALL shell is denied (the sandbox has no shell escape hatch).
  if (risk === 'shell' || command) {
    const hit = matchesDangerous(command || '');
    if (hit) return { decision: 'deny', reason: `沙箱拦截：命令匹配危险模式「${hit}」` };
    if (mode === 'strict') return { decision: 'deny', reason: '沙箱 strict 模式：禁止执行 shell 命令' };
    return { decision: 'pass' };
  }

  // Network: strict mode blocks outbound tool network access outright.
  if (risk === 'network') {
    if (mode === 'strict') return { decision: 'deny', reason: '沙箱 strict 模式：禁止网络访问' };
    return { decision: 'pass' };
  }

  // Writes: anything escaping the workspace root is denied in every mode.
  if (risk === 'write' && target && root) {
    const abs = target.startsWith('/') || /^[a-zA-Z]:/.test(target)
      ? target
      : `${root.replace(/[\\/]+$/, '')}/${target}`;
    if (!isInside(root, abs)) {
      return { decision: 'deny', reason: `沙箱拦截：写入目标在工作区之外（${target}）` };
    }
  }

  // Reads: strict mode auto-approves (they are already prompt-free in the CLI
  // for read risk, but a desktop ask surfaces them — silence is the sandbox).
  if (risk === 'read' && mode === 'strict') {
    return { decision: 'allow', reason: '沙箱 strict 模式：自动批准只读操作' };
  }

  return { decision: 'pass' };
}

const MODES = new Set(['off', 'workspace', 'strict']);

/** Clamp an untrusted preference value to a known mode. */
function normalizeMode(value) {
  return typeof value === 'string' && MODES.has(value) ? value : 'off';
}

module.exports = { evaluate, normalizeMode, isInside, matchesDangerous, DANGEROUS_SHELL };
