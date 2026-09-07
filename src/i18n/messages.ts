import type { Locale } from './locale.js';
import type { ToolRisk } from '../safety/policy.js';

export type ApprovalRisk = ToolRisk;

const riskLabel = {
  en: { read: 'read', write: 'write', shell: 'shell', network: 'network' },
  zh: { read: '只读', write: '写入', shell: '命令', network: '联网' },
} as const;

export function formatApprovalPrompt(options: {
  locale: Locale;
  tool: string;
  risk: ApprovalRisk;
  path?: string;
  from?: string;
  to?: string;
  command?: string;
  preview?: string;
}) {
  const risk = riskLabel[options.locale][options.risk];
  const bits: string[] = [];
  if (options.path) bits.push(options.locale === 'zh' ? `路径=${options.path}` : `path=${options.path}`);
  if (options.from) bits.push(options.locale === 'zh' ? `从=${options.from}` : `from=${options.from}`);
  if (options.to) bits.push(options.locale === 'zh' ? `到=${options.to}` : `to=${options.to}`);
  if (options.command) bits.push(options.locale === 'zh' ? `命令=${options.command}` : `command=${options.command}`);
  const detail = bits.length ? ` ${bits.join(' ')}` : '';
  const preview = options.preview ?? '';
  if (options.locale === 'zh') {
    return `是否批准${risk}工具 ${options.tool}${detail}？${preview}`;
  }
  return `Approve ${options.risk} tool ${options.tool}${detail}?${preview}`;
}

export function formatApprovalOutcome(options: {
  locale: Locale;
  kind: 'blocked' | 'cancelled' | 'no_confirm' | 'unknown_tool' | 'invalid_input' | 'failed';
  tool: string;
  reason?: string;
  detail?: string;
}) {
  const reason = options.reason ?? '';
  const detail = options.detail ? `: ${options.detail}` : '';
  if (options.locale === 'zh') {
    switch (options.kind) {
      case 'blocked':
        return `工具 ${options.tool} 已拦截：${localizeReason(reason, 'zh')}`;
      case 'cancelled':
        return `工具 ${options.tool} 已由用户取消`;
      case 'no_confirm':
        return `工具 ${options.tool} 已拦截：${localizeReason(reason, 'zh')}；当前无确认交互`;
      case 'unknown_tool':
        return `未知工具：${options.tool}`;
      case 'invalid_input':
        return `工具 ${options.tool} 输入无效${detail}`;
      case 'failed':
        return `工具 ${options.tool} 失败${detail}`;
    }
  }
  switch (options.kind) {
    case 'blocked':
      return `Tool ${options.tool} blocked: ${reason}`;
    case 'cancelled':
      return `Tool ${options.tool} cancelled by user`;
    case 'no_confirm':
      return `Tool ${options.tool} blocked: ${reason}; no confirmation handler is available`;
    case 'unknown_tool':
      return `Unknown tool: ${options.tool}`;
    case 'invalid_input':
      return `Invalid input for ${options.tool}${detail}`;
    case 'failed':
      return `Tool ${options.tool} failed${detail}`;
  }
}

export function localizeReason(reason: string, locale: Locale): string {
  if (locale !== 'zh') return reason;
  const map: Array<[RegExp, string]> = [
    [/^read-only tool$/i, '只读工具'],
    [/^approval mode denies write and shell tools$/i, '当前审批模式禁止写入与命令工具'],
    [/^blocked destructive command pattern$/i, '匹配到危险命令模式'],
    [/^command is not in auto approval allowlist$/i, '命令不在自动批准白名单'],
    [/^write target is not in auto approval allowlist$/i, '写入目标不在自动批准白名单'],
    [/^interactive approval required$/i, '需要交互确认'],
    [/^auto approval allowlist$/i, '已在自动批准白名单'],
  ];
  for (const [pattern, zh] of map) {
    if (pattern.test(reason)) return zh;
  }
  return reason;
}

export function formatGitConfirm(options: {
  locale: Locale;
  kind: 'init_repo' | 'board_commit' | 'publish';
  branch?: string;
  boardId?: string;
  remote?: string;
  localRef?: string;
  remoteBranch?: string;
}) {
  if (options.locale === 'zh') {
    switch (options.kind) {
      case 'init_repo':
        return '当前工作区还不是 Git 仓库。是否初始化本地仓库以启用恢复快照？';
      case 'board_commit':
        return `是否提交已完成任务板 ${options.boardId ?? ''} 到分支 ${options.branch ?? '当前分支'}？`;
      case 'publish':
        return `是否推送 ${options.localRef} 到远程 ${options.remote}（${options.remoteBranch}）？`;
    }
  }
  switch (options.kind) {
    case 'init_repo':
      return 'Workspace is not a Git repository. Initialize a local repository for recovery snapshots?';
    case 'board_commit':
      return `Commit completed board ${options.boardId} on ${options.branch}?`;
    case 'publish':
      return `Publish ${options.localRef} to ${options.remote} (${options.remoteBranch})?`;
  }
}

/** Stable markers kept for control-flow matching (agent/tests). */
export const STABLE = {
  cancelled: 'cancelled by user',
  blocked: 'blocked:',
  pathEscapes: 'Path escapes workspace',
} as const;

export function isCancelledOutput(output: string) {
  return output.includes(STABLE.cancelled) || output.includes('已由用户取消');
}

export function isBlockedOutput(output: string) {
  return output.includes(STABLE.blocked) || output.includes('已拦截') || output.includes(STABLE.pathEscapes) || output.includes('路径越出工作区');
}
