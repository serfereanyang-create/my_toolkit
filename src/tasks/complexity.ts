export type TaskComplexity = 'small' | 'standard' | 'large';

export type TaskComplexityInput = {
  prompt: string;
  /** Optional metadata for callers that already separated attachments from text. */
  attachments?: readonly unknown[] | number;
};

export type TaskComplexityAnalysis = {
  complexity: TaskComplexity;
  hasReadIntent: boolean;
  hasWriteIntent: boolean;
  isPlanCommand: boolean;
  actionCount: number;
};

/**
 * Classify the user's requested work without inspecting the repository.
 *
 * This is deliberately a prompt-level classifier.  Static AST/file complexity
 * belongs to a later, task-specific step; feeding it into every turn would
 * make routing depend on work that has not started yet.
 */
export function classifyTaskComplexity(
  input: string | TaskComplexityInput,
  options?: Omit<TaskComplexityInput, 'prompt'>,
): TaskComplexity {
  return analyzeTaskComplexity(input, options).complexity;
}

/** Return the shared signals used by planner, reasoning, and tool-scope routing. */
export function analyzeTaskComplexity(
  input: string | TaskComplexityInput,
  options?: Omit<TaskComplexityInput, 'prompt'>,
): TaskComplexityAnalysis {
  const prompt = typeof input === 'string' ? input : input.prompt;
  const metadata = typeof input === 'string' ? options : input;
  const text = normalizePrompt(prompt);
  const isPlanCommand = PLAN_COMMAND_PATTERN.test(text);

  // A plan command is an explicit request for orchestration, even when its
  // remainder is short (for example, "/plan implement login").
  if (isPlanCommand) {
    return {
      complexity: 'large',
      hasReadIntent: false,
      hasWriteIntent: true,
      isPlanCommand: true,
      actionCount: 3,
    };
  }

  const hasReadIntent = hasAnyChinese(text, READ_TERMS) || hasAnyEnglishWord(text, READ_ENGLISH_TERMS);
  const hasWriteIntent = hasAnyChinese(text, WRITE_TERMS) || hasAnyEnglishWord(text, WRITE_ENGLISH_TERMS);
  // Environment and runtime inspection ("还有多少磁盘空间", "process list") is a
  // read in intent but not in tooling: compact scope has no run_command, so
  // classifying it `small` hands the agent a toolset that cannot answer the
  // question it just accepted. It stays out of the `large` bucket (one look
  // around is not a project); it just cannot be compact.
  const hasExecutionIntent = hasAnyChinese(text, EXECUTION_TERMS)
    || hasAnyChinese(text, RESOURCE_TERMS)
    || hasAnyEnglishWord(text, EXECUTION_ENGLISH_TERMS)
    || hasAnyEnglishWord(text, RESOURCE_ENGLISH_TERMS);
  const actionCount = countActionGroups(text);
  const hasLargeMarker = hasAnyChinese(text, LARGE_CHINESE_TERMS)
    // "and tests" / "with tests" describe a *large change* only when something
    // is being changed: "read the README and tests folder" is one read.
    || (hasWriteIntent && hasAnyEnglishPhrase(text, LARGE_ENGLISH_PHRASES))
    || hasNumberedSteps(text)
    || hasLongAttachmentList(metadata);

  // "解释一下项目架构" names a large-sounding subject, but it asks for prose, not
  // for work: one read action, no mutation. Measured before this guard, pure
  // explanation questions mentioning 架构/architecture were drafted as four-task
  // boards on every turn.
  const isExplanationAsk = EXPLANATION_OPENERS.test(text) && !hasWriteIntent && actionCount <= 1;

  if ((hasLargeMarker && !isExplanationAsk) || actionCount >= 3) {
    return { complexity: 'large', hasReadIntent, hasWriteIntent, isPlanCommand, actionCount };
  }

  // A write request is never `small`: "small" resolves to compact scope, which
  // has no write tools at all, so the agent would be given a toolset that
  // cannot perform the change it was just asked to make. Pure write work is
  // `standard`; two action groups raise it to the same place.
  if (hasWriteIntent || actionCount >= 2) {
    return { complexity: 'standard', hasReadIntent, hasWriteIntent, isPlanCommand, actionCount };
  }

  // Direct inspection, lookup, and small-talk requests are compact. Unknown
  // requests stay standard so the agent has enough tools to clarify safely.
  if ((hasReadIntent && !hasExecutionIntent) || isSmallTalk(text)) {
    return { complexity: 'small', hasReadIntent, hasWriteIntent, isPlanCommand, actionCount };
  }

  return { complexity: 'standard', hasReadIntent, hasWriteIntent, isPlanCommand, actionCount };
}

/** Compatibility-friendly alias for callers that describe this as a getter. */
export const getTaskComplexity = classifyTaskComplexity;

const RESOURCE_TERMS = ['磁盘', '硬盘', '内存', '剩余空间', '进程', '进程列表'];
const RESOURCE_ENGLISH_TERMS = ['disk', 'free space', 'memory', 'process'];

/** Requests for prose. They can name a large subject without doing large work. */
const EXPLANATION_OPENERS = /^(?:解释|说明|介绍|讲一下|讲讲|总结|概括|describe|explain|summari[sz]e|introduce|walk me through)/i;

const PLAN_COMMAND_PATTERN = /(?:^|\s)\/plan(?:\s|$)/i;

const READ_TERMS = [
  '读取', '读一下', '打开', '查看', '看看', '查找', '搜索', '查询', '检索', '定位', '解释', '说明', '介绍',
  '总结', '概况', '状态', '列出', '有哪些', '剩余空间', '磁盘', '硬盘', '内存', '环境', '进程',
  '阅读', '审阅', '检查', '分析', '预览', '只读', '只查看',
];

const WRITE_TERMS = [
  '实现', '开发', '新增', '添加', '创建', '生成', '编写', '写入', '写', '修改', '修复', '重构',
  '优化', '删除', '移除', '改成', '改为', '更新', '构建', '发布', '迁移', '接入', '补充', '增加',
  '改正', '纠正', '替换', '替换为', '调整', '重命名', '移动', '格式化', '整理', '清理', '修正',
];

/**
 * Commands that only exist at `standard` scope or above.
 *
 * Used solely to keep a read-shaped request ("磁盘还剩多少") out of `compact`;
 * it does not count as a write and does not make a prompt `large`.
 */
const EXECUTION_TERMS = [
  '运行', '执行', '命令', '进程', '环境', '安装', '构建', '编译', '部署', '重启', '启停',
];

const LARGE_CHINESE_TERMS = [
  '分步', '分步骤', '逐步', '多步骤', '多步', '任务板', '看板', '完整流程', '完整功能', '端到端',
  '跨模块', '跨文件', '全流程', '架构', '系统性', '一并测试', '并补测试', '并添加测试', '并编写测试',
  '并验证', '验收',
];

const READ_ENGLISH_TERMS = [
  'read', 'open', 'show', 'view', 'inspect', 'search', 'find', 'look at', 'look for', 'explain', 'summarize', 'describe',
  'review', 'check', 'list', 'query', 'what is', 'disk', 'free space', 'memory', 'process', 'environment',
  'status', 'overview', 'read-only', 'readonly',
];

const EXECUTION_ENGLISH_TERMS = [
  'run', 'execute', 'command', 'process', 'environment', 'install', 'build', 'compile', 'deploy', 'restart',
];

const WRITE_ENGLISH_TERMS = [
  'implement', 'develop', 'add', 'create', 'build', 'write', 'modify', 'edit', 'fix', 'refactor', 'optimize',
  'delete', 'remove', 'update', 'generate', 'change', 'migrate', 'publish',
  'adjust', 'bump', 'rename', 'replace', 'correct', 'tweak', 'move', 'reformat', 'clean up', 'cleanup',
];

const LARGE_ENGLISH_PHRASES = [
  'multi-step', 'multi step', 'step by step', 'end-to-end', 'end to end', 'task board', 'full workflow',
  'complete workflow', 'complete feature', 'cross-module', 'cross module', 'cross-file', 'cross file',
  'architecture', 'and test', 'and tests', 'with tests', 'then verify', 'then test', 'plan and',
];

const ACTION_GROUPS: readonly (readonly string[])[] = [
  [...READ_TERMS, ...READ_ENGLISH_TERMS],
  [...WRITE_TERMS, ...WRITE_ENGLISH_TERMS],
  ['测试', '验证', '验收', '运行', '执行', 'test', 'tests', 'verify', 'validate', 'run', 'execute'],
  ['部署', '发布', 'deploy', 'release', 'ship'],
];

function normalizePrompt(prompt: string) {
  let text = prompt.replace(/\r/g, '').trim().toLowerCase();
  if (!text) return '';

  // Prepared attachment context contains arbitrary user text.  It must not
  // turn a simple "summarize this file" request into a large coding task.
  text = text
    .replace(/^\s*\[(?:attachments?|user provided files?|attached files?)\]\s*$/gim, '\n[attachment-context]\n')
    .replace(/\n\s*\[attachment-context\][\s\S]*$/i, '')
    .replace(/\(\+\d+\s+attachments?\s*:[^)]*\)/gi, '')
    .replace(/```[\s\S]*?```/g, ' ');

  // Remove path tokens before matching English verbs. This handles both
  // "searchdisk.ts" (not the word "search") and "搜索disk.ts" (CJK directly
  // adjacent to a path) without requiring spaces around the path.
  text = text.replace(DIRECTORY_PATH_PATTERN, ' ').replace(FILE_PATH_PATTERN, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function countActionGroups(text: string) {
  let count = 0;
  for (const group of ACTION_GROUPS) {
    const chinese = group.filter((term) => /[^a-z0-9]/i.test(term));
    const english = group.filter((term) => /^[a-z0-9 -]+$/i.test(term));
    if (hasAnyChinese(text, chinese) || hasAnyEnglishWord(text, english)) count += 1;
  }
  return count;
}

function hasAnyChinese(value: string, terms: readonly string[]) {
  return terms.some((term) => value.includes(term));
}

function hasAnyEnglishWord(value: string, terms: readonly string[]) {
  return terms.some((term) => englishWordPattern(term).test(value));
}

function hasAnyEnglishPhrase(value: string, terms: readonly string[]) {
  return terms.some((term) => {
    if (/\s/.test(term) || term.includes('-')) return value.includes(term);
    return englishWordPattern(term).test(value);
  });
}

function englishWordPattern(term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // ASCII boundaries intentionally allow CJK adjacency but reject identifier
  // substrings such as "update" in "updateFile" or "read" in "readme".
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i');
}

function hasNumberedSteps(value: string) {
  // An enumerated *list* is not a multi-step *task*. Bullets are excluded: a
  // request to summarize three feedback items ("以下是反馈：\n- 慢\n- 卡\n- 崩")
  // used to become a four-task board because its input happened to be a list.
  // Only ordered steps ("1. inspect 2. fix 3. test") count, and only when the
  // input is a request for work rather than a body of text to read.
  const ordered = value.match(/(?:^|\s)\d+[.)]\s+/g);
  return (ordered?.length ?? 0) >= 3 && !/^(?:总(?:结|体)|概括|汇总|summari[sz]e\b|tl;?dr\b)/i.test(value);
}

function isSmallTalk(value: string) {
  return /^(?:(?:你好|您好|嗨|谢谢|帮助|什么是)[^\n]{0,80}|(?:hello|hi|thanks?|help|what is)\b[^\n]{0,80})$/i.test(value);
}

function hasLongAttachmentList(metadata: TaskComplexityInput | Omit<TaskComplexityInput, 'prompt'> | undefined) {
  // Attachment count is intentionally not a complexity multiplier for one or
  // two source files. Three or more explicitly supplied files are a meaningful
  // batch request only when the prompt also asks for work, not for mere reading.
  if (!metadata || typeof metadata.attachments === 'undefined') return false;
  const count = typeof metadata.attachments === 'number' ? metadata.attachments : metadata.attachments.length;
  return count >= 3;
}

const PATH_TOKEN_CHAR = 'A-Za-z0-9_./\\\\@+~%-';
const FILE_PATH_PATTERN = new RegExp(
  `(?<![${PATH_TOKEN_CHAR}])(?:[${PATH_TOKEN_CHAR}]+[\\\\/])*[${PATH_TOKEN_CHAR}]+\\.(?:[cm]?[jt]sx?|json|ya?ml|toml|md|txt|csv|tsv|xml|html?|css|scss|less|py|rb|go|rs|java|kt|kts|swift|cs|cpp|cc|cxx|c|h|hpp|vue|svelte|docx?|pdf|xlsx?|pptx?|png|jpe?g|gif|webp|zip|log)(?![${PATH_TOKEN_CHAR}])`,
  'gi',
);
const DIRECTORY_PATH_PATTERN = new RegExp(
  `(?<![${PATH_TOKEN_CHAR}])(?:[a-z]:)?(?:[${PATH_TOKEN_CHAR}]+[\\\\/])+[${PATH_TOKEN_CHAR}]+(?![${PATH_TOKEN_CHAR}])`,
  'gi',
);
