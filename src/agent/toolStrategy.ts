import type { DelegationLevel } from '../config/types.js';
import type { SessionRecord, ToolCallRecord } from '../session/store.js';

export type ToolIntent = 'code_edit' | 'code_search' | 'disk_growth' | 'disk_capacity' | 'project_overview' | 'runtime_info' | 'unknown';

export type RecentToolResult = {
  tool: string;
  ok: boolean;
  output: string;
};

export function recentToolResultsFromSession(
  session: Pick<SessionRecord, 'messages' | 'toolCalls'>,
  limit = 6,
): RecentToolResult[] {
  if (limit <= 0) return [];

  const results: RecentToolResult[] = [];
  let messageIndex = session.messages.length - 1;
  let callIndex = session.toolCalls.length - 1;

  while (results.length < limit) {
    while (messageIndex >= 0 && session.messages[messageIndex].role !== 'tool') {
      messageIndex -= 1;
    }

    if (messageIndex < 0 || callIndex < 0) break;
    const message = session.messages[messageIndex];
    if (!message.name) break;
    const call = session.toolCalls[callIndex];
    if (!matchesToolMessage(call, message.name, message.content)) break;

    results.push({ tool: message.name, ok: call.ok, output: message.content });
    messageIndex -= 1;
    callIndex -= 1;
  }

  return results.reverse();
}

function matchesToolMessage(call: ToolCallRecord, tool: string, output: string) {
  return call.tool === tool && call.output === output;
}

export type ToolStrategyContext = {
  intent: ToolIntent;
  recommendedTools: string[];
  avoidTools: string[];
  reason: string;
  cacheHints: string[];
  recoveryHints: string[];
};

export function planToolStrategy(input: { prompt: string; recentTools: RecentToolResult[]; workspaceRoot: string }): ToolStrategyContext {
  const normalized = input.prompt.toLowerCase();
  const systemIntentText = stripPaths(normalized);
  const baseCacheHints = ['Reuse unchanged project context cacheKey when present.'];
  const hasEditVerb = hasChineseOrEnglishWord(
    normalized,
    ['修复', '修改', '实现', '新增', '删除', '重构', '优化', '改成'],
    ['fix', 'modify', 'implement', 'add', 'delete', 'refactor', 'optimize', 'update', 'create', 'write'],
  );
  const hasCodeContext = hasAny(normalized, ['代码', '源码', '源文件', 'bug', '按钮', '函数', '组件', '解析器', 'code', 'source', 'button', 'function', 'component', 'class', 'parser', 'handler']);
  const hasCodePath = CODE_PATH_PATTERN.test(input.prompt);
  const hasSearchVerb = hasChineseOrEnglishWord(
    normalized,
    ['查找', '搜索', '在哪里', '引用', '定位'],
    ['find', 'search', 'grep', 'reference', 'where'],
  );
  const hasDiskGrowth = hasAny(systemIntentText, ['增长', '涨了', '大文件', '清理', '最近文件', 'disk growth', 'large files']);
  const hasDiskCapacity = hasAny(systemIntentText, ['磁盘', '硬盘', 'c盘', 'd盘', '容量', '剩余空间', '多大', 'disk', 'drive', 'free space']);
  const hasRuntimeInfo = hasAny(systemIntentText, ['环境', '容器', '系统信息', '运行环境', '内存', '进程', 'environment', 'container', 'runtime', 'memory', 'process']);

  if (hasEditVerb && (hasCodePath || hasCodeContext || (!hasDiskGrowth && !hasDiskCapacity && !hasRuntimeInfo))) {
    return strategy(
      'code_edit',
      ['ts_hover', 'ts_goto_definition', 'ts_exact_references', 'find_symbol', 'find_references', 'project_index', 'search_text', 'read_file', 'apply_patch', 'write_file'],
      ['run_command before inspection', 'write_file before reading target files', 'list_files for broad discovery'],
      'Code editing request; locate symbols before editing.',
      [...baseCacheHints, 'Prefer find_symbol before broad file reads.', 'Prefer recently read tool results when the same file is unchanged.'],
      input.recentTools,
    );
  }

  // Explicit file search must win over residual disk/runtime subject keywords left after path stripping.
  if (hasSearchVerb && hasCodePath) {
    return strategy(
      'code_search',
      ['find_symbol', 'find_references', 'search_text', 'project_index', 'read_file'],
      ['list_files for broad discovery', 'run_command unless dedicated tools cannot answer'],
      'Code search request; prefer symbol navigation before broad listing.',
      [...baseCacheHints, 'Use find_symbol when looking for definitions.'],
      input.recentTools,
    );
  }

  if (hasDiskGrowth) {
    return strategy('disk_growth', ['disk_growth'], ['list_files', 'project_index', 'run_command'], 'Disk growth request; inspect recent large files directly.', baseCacheHints, input.recentTools);
  }

  if (hasDiskCapacity) {
    return strategy('disk_capacity', ['disk_info'], ['run_command'], 'Disk capacity request; use the dedicated disk tool.', baseCacheHints, input.recentTools);
  }

  if (hasRuntimeInfo) {
    const tool = hasAny(systemIntentText, ['内存', '进程', 'memory', 'process']) ? 'process_memory' : 'environment_info';
    return strategy('runtime_info', [tool], ['run_command'], 'Runtime information request; use a dedicated environment or process tool.', baseCacheHints, input.recentTools);
  }

  if (hasSearchVerb) {
    return strategy(
      'code_search',
      ['find_symbol', 'find_references', 'search_text', 'project_index', 'read_file'],
      ['list_files for broad discovery', 'run_command unless dedicated tools cannot answer'],
      'Code search request; prefer symbol navigation before broad listing.',
      [...baseCacheHints, 'Use find_symbol when looking for definitions.'],
      input.recentTools,
    );
  }

  if (hasAny(normalized, ['项目', '结构', '有哪些文件', '看看项目', '目录', '概况', 'project', 'overview', 'tree', 'files'])) {
    return strategy('project_overview', ['project_index', 'list_files'], ['run_command'], 'Project overview request; start with project_index.', [...baseCacheHints, 'Use cached project index when available.'], input.recentTools);
  }

  return strategy('unknown', [], ['run_command when a dedicated tool exists'], 'No strong intent; prefer dedicated tools over shell.', baseCacheHints, input.recentTools);
}

export function formatToolStrategy(strategy: ToolStrategyContext) {
  return [
    'Tool strategy:',
    `intent=${strategy.intent}`,
    strategy.recommendedTools.length ? `recommended=${strategy.recommendedTools.join(', ')}` : undefined,
    strategy.avoidTools.length ? `avoid=${strategy.avoidTools.join(', ')}` : undefined,
    `reason=${strategy.reason}`,
    strategy.cacheHints.length ? `cacheHints=${strategy.cacheHints.join(' | ')}` : undefined,
    strategy.recoveryHints.length ? `recoveryHints=${strategy.recoveryHints.join(' | ')}` : undefined,
  ].filter((line): line is string => typeof line === 'string').join('\n');
}

function strategy(intent: ToolIntent, recommendedTools: string[], avoidTools: string[], reason: string, cacheHints: string[], recentTools: RecentToolResult[]): ToolStrategyContext {
  return { intent, recommendedTools, avoidTools, reason, cacheHints, recoveryHints: recentTools.filter((tool) => !tool.ok).flatMap((tool) => recoveryHintForToolFailure(tool.tool, tool.output) ?? []) };
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

const ENGLISH_WORD_BOUNDARY_PATTERNS = new Map<string, RegExp>();

function englishWordBoundaryPattern(needle: string) {
  let pattern = ENGLISH_WORD_BOUNDARY_PATTERNS.get(needle);
  if (!pattern) {
    // Callers already lowercase `value`; keep the pattern case-sensitive and cached.
    pattern = new RegExp(`\\b${needle}\\b`);
    ENGLISH_WORD_BOUNDARY_PATTERNS.set(needle, pattern);
  }
  return pattern;
}

function hasChineseOrEnglishWord(value: string, chineseNeedles: string[], englishNeedles: string[]) {
  if (chineseNeedles.some((needle) => value.includes(needle))) return true;
  return englishNeedles.some((needle) => englishWordBoundaryPattern(needle).test(value));
}

const CODE_PATH_EXTENSIONS = '[cm]?[jt]sx?|java|kt|kts|py|rb|go|rs|swift|cs|cpp|cc|cxx|c|h|hpp|vue|svelte|json|ya?ml|toml|md';
// ASCII path-token chars only so CJK adjacency is a boundary (e.g. 搜索disk.ts中的quota).
const CODE_PATH_TOKEN_CHAR = 'A-Za-z0-9_./\\\\@+~%-';
const CODE_PATH_PATTERN = new RegExp(
  `(?<![${CODE_PATH_TOKEN_CHAR}])(?:[${CODE_PATH_TOKEN_CHAR}]+[\\\\/])*[${CODE_PATH_TOKEN_CHAR}]+\\.(?:${CODE_PATH_EXTENSIONS})(?![${CODE_PATH_TOKEN_CHAR}])`,
  'i',
);
const CODE_PATH_GLOBAL_PATTERN = new RegExp(CODE_PATH_PATTERN.source, 'gi');
const DIRECTORY_PATH_PATTERN = new RegExp(
  `(?<![${CODE_PATH_TOKEN_CHAR}])(?:[a-z]:)?(?:[${CODE_PATH_TOKEN_CHAR}]+[\\\\/])+[${CODE_PATH_TOKEN_CHAR}]+(?![${CODE_PATH_TOKEN_CHAR}])`,
  'gi',
);

function stripPaths(value: string) {
  return value
    .replace(DIRECTORY_PATH_PATTERN, ' ')
    .replace(CODE_PATH_GLOBAL_PATTERN, ' ');
}

export function recoveryHintForToolFailure(tool: string, output: string): string | undefined {
  const normalized = output.toLowerCase();
  // A path escape is recoverable: the model picked a target outside the
  // workspace and can retry with an in-workspace path. (It used to be treated
  // as terminal, which ended the turn instead of letting the model correct.)
  if (normalized.includes('path escapes workspace') || output.includes('路径越出工作区')) {
    return `The ${tool} target resolved outside the workspace; retry with a workspace-relative path (use list_files or project_index to find it).`;
  }
  if (normalized.includes('cancelled by user')) return undefined;
  if (normalized.includes('blocked:')) return 'The command was blocked; choose a dedicated read-only tool or ask for approval only if shell access is required.';
  if (normalized.includes('old text not found') || normalized.includes('text not found')) return `The ${tool} edit anchor was not found; read_file the target and retry with exact surrounding text.`;
  if (normalized.includes('not found') || normalized.includes('no such file') || normalized.includes('enoent')) return `The ${tool} target was not found; use project_index, list_files, or search_text to locate the correct path.`;
  if (normalized.includes('is not recognized') || normalized.includes('command not found')) return `The ${tool} command failed on this platform; use a platform-correct command or a dedicated tool.`;
  if (tool === 'search_text' && normalized.includes('no matches')) return 'The search had no matches; broaden the query or use project_index before reading random files.';
  return undefined;
}

/**
 * Suggest next steps after a successful tool call to guide the agent toward
 * more efficient workflows. Only returns hints for tools where there's a clear
 * better alternative or common next step.
 */
export function nextStepHint(tool: string, output: string, outputLength: number): string | undefined {
  const normalized = output.toLowerCase();
  
  // Large file reads → suggest targeted tools
  if (tool === 'read_file' && outputLength > 10000) {
    return 'Large file. Consider: read_lines for specific ranges, or search_text to find relevant sections.';
  }
  
  // Symbol search success → suggest deeper inspection
  if (tool === 'find_symbol' && !normalized.includes('no symbols matched')) {
    return 'Found symbols. Next: use ts_hover to see type info, or ts_goto_definition to jump to source.';
  }
  
  // Project index → suggest focused tools
  if (tool === 'project_index' && normalized.includes('files:')) {
    return 'Got project overview. Next: use find_symbol for specific symbols, or search_text for code patterns.';
  }
  
  // Write operations → suggest verification
  if ((tool === 'write_file' || tool === 'apply_patch' || tool === 'edit_lines') && normalized.includes('patched') || normalized.includes('wrote')) {
    return 'File modified. Consider: read_file to verify changes, or run_command to test the code.';
  }
  
  return undefined;
}

/**
 * The parts of the hint that do not depend on the level: the expert roster, the
 * dependsOn rules, and what to do with the answers. Shared so a level can only
 * change the *policy*, never the mechanics.
 *
 * Declared first because the level hints below interpolate it at module load.
 */
const DELEGATION_SHARED_TAIL = `
**expert 角色选择指南：**
- 只需读代码/查找符号 → code_search
- 实现/修改/重构代码 → code_edit
- 编写或运行测试 → test_verify
- Shell 命令/构建/安装 → shell_runtime
- Git add/commit/push → git_ops
- 生成 Word/PPT/PDF 文档 → doc_generation
- 处理 JSON/CSV/YAML 数据 → data_processing
- 不确定 → general

**dependsOn 使用规则：**
- 无数据依赖的任务 → 不设 dependsOn，框架自动并行
- B 需要 A 的结果 → B.dependsOn = ["A"]，框架自动串行并将 A 的答案注入 B 的 prompt

**你的职责：** spawn_subagent 完成后，读取每个子 agent 的答案并整合给用户一个完整的最终回复。
`.trim();

/**
 * Sub-agent strategy hint appended to the system tool-strategy block.
 * Tells the main agent when and how to delegate via spawn_subagent.
 *
 * This is the `balanced` level, kept verbatim: it is the behaviour the CLI had
 * before the delegation level existed, and it is what a user gets by choosing
 * 均衡.
 */
export const SUBAGENT_STRATEGY_HINT = `
## 子智能体委派（spawn_subagent）
当遇到以下情况时，优先调用 spawn_subagent 工具而不是独自完成所有工作：

**适合委派的场景：**
- 任务可以分解为 2 个或以上相互独立的子目标（如：同时搜索多个模块、同时写多个文件）
- 需要先调研再实现（code_search 子 agent 调研 → code_edit 子 agent 实现）
- 实现代码 + 写测试 + 写文档可以独立完成（code_edit、test_verify、doc_generation 各自委派）
- Git 操作与代码修改可以分离（code_edit 先改代码，git_ops 后提交）

${DELEGATION_SHARED_TAIL}
`.trim();

/**
 * `eager`: delegate by default, but keep writes on the main agent.
 *
 * The write restriction is not stylistic. `runSubAgent` hardcodes every
 * approval to true (subagent/runner.ts) because a sub-agent has no channel to
 * prompt the user — so a write performed by a sub-agent is a write the user
 * never confirms. If delegation became the normal path for edits, the default
 * 「每次询问」approval mode would be quietly bypassed for most changes.
 *
 * Delegating the *investigation* instead keeps the requested behaviour (almost
 * every turn produces a sub-agent run) while every actual edit still surfaces
 * in an approval card.
 */
const EAGER_DELEGATION_HINT = `
## 子智能体委派（spawn_subagent）
**默认委派。** 除非是纯闲聊、单步问答，或整个请求你自己一次工具调用就能答完，否则先派子智能体。

**怎么做：**
- 只要请求里存在任何一个可以独立完成的部分，就派一个子智能体去做。不要因为「我自己两下就做完了」而跳过委派。
- 只读的调研、搜索、定位、解释、总结 → 交给 code_search 子智能体。
- 需要看多个地方、多个文件、多种可能性 → 拆成多个子智能体并行。
- 你负责把子智能体的答案整合成一个完整的最终回复。

**写操作留在你自己手里（重要）：**
子智能体没有向用户请求确认的通道，它们的写操作会直接执行、不弹确认框。所以：
- 任何会修改文件、提交、推送、删除的工作，都由你自己调用工具完成，让用户能在确认框里看到。
- 需要先调研再动手的：先派只读子智能体（code_search）把情况摸清楚，拿到结论后你自己改。
- 不要派 code_edit / git_ops / shell_runtime 这类可写子智能体替用户改东西。

${DELEGATION_SHARED_TAIL}
`.trim();

/**
 * `off`: do the work in this conversation.
 *
 * Still names the tool, because the tool is injected into every turn whether or
 * not this block mentions it — saying nothing would leave the model to decide
 * on its own, which is the behaviour this level exists to switch off.
 */
const NO_DELEGATION_HINT = `
## 子智能体（spawn_subagent）
不要派子智能体：直接使用工具自己完成任务，并在最终回复里给出结果。
`.trim();

/**
 * Delegation eagerness when nothing configured it.
 *
 * `eager`, because the feature is only useful if it fires: a level the user has
 * to discover and switch on is indistinguishable from no feature. The cost is
 * real (every sub-agent is a fresh session with a cold prompt cache), which is
 * why `balanced` and `off` exist.
 *
 * Declared here rather than in config.ts because the prompt builder needs it
 * too, and this module must not import config.ts (config.ts imports this one).
 */
export const DEFAULT_DELEGATION_LEVEL: DelegationLevel = 'eager';

/**
 * The delegation block for a level.
 *
 * The block lives in the STABLE part of the system prompt (protocol.ts), so it
 * is inside the cached prefix. That is safe because the level is configuration,
 * not per-turn state: it is byte-identical across the turns of a session. What
 * it does mean is that changing the level invalidates the cache once, exactly
 * like changing the tool scope does.
 */
export function delegationHint(level: DelegationLevel): string {
  if (level === 'off') return NO_DELEGATION_HINT;
  if (level === 'eager') return EAGER_DELEGATION_HINT;
  return SUBAGENT_STRATEGY_HINT;
}

