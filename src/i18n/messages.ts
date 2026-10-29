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
  /** Multiple targets for one call (e.g. the files `git restore` discards). */
  paths?: string[];
  from?: string;
  to?: string;
  command?: string;
  preview?: string;
}) {
  const risk = riskLabel[options.locale][options.risk];
  const bits: string[] = [];
  if (options.path) bits.push(options.locale === 'zh' ? `路径=${options.path}` : `path=${options.path}`);
  if (options.paths && options.paths.length > 0) {
    const joined = options.paths.join(', ');
    bits.push(options.locale === 'zh' ? `路径=${joined}` : `paths=${joined}`);
  }
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

/**
 * policy 层的英文 reason → 中文。
 *
 * 这些字符串来自 `safety/policy.ts`、`safety/network.ts`、`safety/commandAnalysis.ts`，
 * 由 `formatApprovalOutcome` 拼进「工具 X 已拦截：…」。旧表只覆盖 7 条，
 * 且 `approval mode denies write and shell tools` 这条早已改成
 * `… write, shell, and network tools`——中文模式下最常见的 deny 模式提示
 * 因此一直是英文原样。表里按「先具体后笼统」排列，参数化文案单独放行。
 */
const REASON_RULES: Array<[RegExp, string | ((match: RegExpExecArray) => string)]> = [
  [/^blocked destructive command pattern(?::\s*(.+))?$/i, (match) => `匹配到危险命令模式${match[1] ? `：${match[1]}` : ''}`],
  [/^approval mode denies write, shell, and network tools$/i, '当前审批模式禁止写入、命令与联网工具'],
  // 旧文案，历史会话/日志里仍然会出现。
  [/^approval mode denies write and shell tools$/i, '当前审批模式禁止写入与命令工具'],
  [/^plan mode requires confirmation before every change$/i, '计划模式：每次改动前都需要确认'],
  [/^destructive tool requires explicit confirmation$/i, '破坏性工具需要明确确认'],
  [/^command is not in auto approval allowlist$/i, '命令不在自动批准白名单'],
  [/^write target is not in auto approval allowlist$/i, '写入目标不在自动批准白名单'],
  [/^interactive approval required for network request$/i, '联网请求需要交互确认'],
  [/^interactive approval required$/i, '需要交互确认'],
  [/^auto approval allowlist$/i, '已在自动批准白名单'],
  [/^command runs an always-allowed app$/i, '命令属于始终允许的应用'],
  [/^computerAnyApp allows non-destructive commands in auto mode$/i, '“任意应用”允许在自动模式下执行非破坏性命令'],
  [/^confirmation required:\s*(.+)$/i, (match) => `需要确认：${match[1]}`],
  [/^read-only tool$/i, '只读工具'],
  [/^invalid URL$/i, 'URL 无效'],
  [/^unsupported protocol\s+(.+)$/i, (match) => `不支持的协议 ${match[1]}`],
  [/^target resolves to a private or loopback address \(SSRF blocked\)$/i, '目标是私有或回环地址（已阻止 SSRF）'],
  [
    /^(.+?) is not in the network allowlist \(the request was blocked before it left the machine\)[\s\S]*$/i,
    (match) => `${match[1]} 不在联网白名单（请求未离开本机就被拦下）；可加入 .aicode/config.json 的 network.allowlist，或设置 AICODE_NETWORK_ALLOWLIST`,
  ],
  [/^host is in the network allowlist$/i, '主机已在联网白名单'],
];

export function localizeReason(reason: string, locale: Locale): string {
  if (locale !== 'zh') return reason;
  // 已经是中文的 reason（commandAnalysis 产出的就是中文）原样返回。
  for (const [pattern, zh] of REASON_RULES) {
    const match = pattern.exec(reason);
    if (match) return typeof zh === 'string' ? zh : zh(match);
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
  /**
   * tools 内联的硬拒绝（`后台浏览器…被策略拒绝：…`，见 backgroundBrowser.ts）。
   * 它和 registry 的「已拦截」是同一种判定——策略说不行，重试没有意义——
   * 但绕过 registry 直接返回，所以检测表必须显式覆盖，否则那个工具的拒绝
   * 会被当成普通失败交给模型重试。只匹配「被策略拒绝」，不匹配
   * 「自动审核拒绝」：后者是可换路重试的审核判定。
   */
  policyRefused: '被策略拒绝',
} as const;

export function isCancelledOutput(output: string) {
  return output.includes(STABLE.cancelled) || output.includes('已由用户取消');
}

/**
 * True when a tool refused because its target resolved outside the workspace.
 *
 * Deliberately NOT part of {@link isBlockedOutput}. A path escape is an input
 * mistake, not a policy verdict: the model can immediately recover by
 * addressing a path inside the workspace. Folding it into the "blocked" bucket
 * ended the whole turn, so an agent that reached for `../other-pkg/README.md`
 * simply stopped instead of correcting the path.
 */
export function isPathEscapeOutput(output: string) {
  // Case-insensitive: the marker is also emitted lowercase by the unified
  // patch / openapi paths (`path escapes workspace: ...`).
  const normalized = output.toLowerCase();
  return normalized.includes(STABLE.pathEscapes.toLowerCase()) || output.includes('路径越出工作区');
}

export function isBlockedOutput(output: string) {
  return output.includes(STABLE.blocked) || output.includes('已拦截') || output.includes(STABLE.policyRefused);
}
