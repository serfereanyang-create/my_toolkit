import { extractCommand, planCommand } from '../agent/commandExtract/index.js';
import { planToolStrategy } from '../agent/toolStrategy.js';
import type { AgentAction, AgentMessage, Provider, ProviderRequest, ProviderResponse } from './types.js';

const smokeActions: AgentAction[] = [
  { type: 'tool', tool: 'project_status', input: {} },
  { type: 'tool', tool: 'list_files', input: { path: '.', maxFiles: 80 } },
  {
    type: 'tool',
    tool: 'write_file',
    input: {
      path: '.smoke/multi-tool-result.md',
      content: '# Multi-tool smoke result\n\nmarker: AICODE_SMOKE_MULTI_TOOL\n\nThis file was created by the mock provider through the write_file tool.\n',
    },
  },
  { type: 'tool', tool: 'read_file', input: { path: '.smoke/multi-tool-result.md', maxBytes: 2000 } },
  { type: 'tool', tool: 'search_text', input: { query: 'AICODE_SMOKE_MULTI_TOOL', path: '.smoke', maxMatches: 10 } },
  { type: 'tool', tool: 'run_command', input: { command: 'node --version', timeoutMs: 30000 } },
  { type: 'message', content: 'Done. The smoke task used project inspection, file listing, file writing, file reading, search, command execution, and session persistence.' },
];

export function createMockProvider(model = 'mock-code-agent-v1'): Provider {
  return {
    name: 'mock',
    model,
    async complete(request: ProviderRequest): Promise<ProviderResponse> {
      const latestUser = latestUserMessage(request.messages);
      const content = latestUser?.content ?? '';
      const normalized = content.toLowerCase();
      const turnToolCount = currentTurnToolCount(request.messages);

      if (isSmokeDemoPrompt(normalized)) {
        return { actions: [smokeActions[Math.min(turnToolCount, smokeActions.length - 1)]] };
      }

      const plan = planNaturalLanguage(content, request.workspaceRoot);
      if (plan.length > 0) {
        return { actions: [plan[Math.min(turnToolCount, plan.length - 1)]] };
      }

      const smallTalk = answerSmallTalk(content);
      return { actions: [{ type: 'message', content: smallTalk }] };
    },
  };
}

function isSmokeDemoPrompt(normalized: string) {
  return normalized.includes('multi-tool') || normalized.includes('smoke task') || normalized.includes('smoke multi');
}

function planNaturalLanguage(prompt: string, workspaceRoot: string): AgentAction[] {
  const normalized = prompt.toLowerCase();
  const actions: AgentAction[] = [];
  const path = extractPath(prompt);
  const marker = extractMarker(prompt) ?? 'AICODE_NL_DRIVE';
  const writePath = path && isWritableSmokePath(path) ? path : '.smoke/natural-language-note.md';
  const hasExplicitWrite = hasChineseOrEnglishWord(normalized, ['写', '创建', '生成'], ['write', 'create']);
  const hasExplicitRead = hasChineseOrEnglishWord(normalized, ['读取', '读', '打开', '查看'], ['read', 'open', 'show']);

  // Keep multi-tool write demos deterministic for smoke-style NL chains.
  if (hasExplicitWrite) {
    actions.push({
      type: 'tool',
      tool: 'write_file',
      input: {
        path: writePath,
        content: `# Natural language tool result\n\nmarker: ${marker}\n\nThis file was created from a natural-language request.\n`,
      },
    });
    if (hasExplicitRead) {
      actions.push({ type: 'tool', tool: 'read_file', input: { path: path ?? writePath, maxBytes: 20000 } });
    }
    appendRemainingExplicitActions(actions, prompt, normalized, marker);
    actions.push({ type: 'message', content: `Done. I translated the natural-language request into ${actions.length} tool call(s).` });
    return actions;
  }

  const extraction = extractCommand(prompt);
  const sharedPlan = planCommand(extraction);
  if (sharedPlan.mode === 'execute' && sharedPlan.steps.length > 0) {
    const tools = sharedPlan.steps.map((step) => ({ type: 'tool' as const, tool: step.tool, input: step.input }));
    return [...tools, { type: 'message', content: `Done. I translated the natural-language request into ${tools.length} tool call(s).` }];
  }

  if (extraction.intent === 'code_edit') {
    // Keep path tokens in the search query for code-edit demos (e.g. "修复 src/disk.ts 的显示问题").
    const query = extractSearchQuery(prompt, { keepPaths: true })
      || extraction.slots.query
      || (hasAny(normalized, ['问题', 'bug', 'error', 'fix']) ? 'TODO' : undefined)
      || 'TODO';
    const tools: AgentAction[] = [
      { type: 'tool', tool: 'project_index', input: { path: '.', maxFiles: 1000 } },
      { type: 'tool', tool: 'search_text', input: { query, path: '.', maxMatches: 20 } },
      { type: 'tool', tool: 'read_file', input: { path: path ?? 'package.json', maxBytes: 20000 } },
    ];
    return [...tools, { type: 'message', content: `Done. I translated the natural-language request into ${tools.length} tool call(s).` }];
  }

  if (extraction.intent === 'code_search') {
    if (!extraction.slots.query && !extraction.slots.path) {
      return [
        { type: 'tool', tool: 'project_index', input: { path: '.', maxFiles: 1000 } },
        { type: 'message', content: 'Done. I translated the natural-language request into 1 tool call(s).' },
      ];
    }
    const query = extractSearchQuery(prompt, { keepPaths: true })
      || extraction.slots.query
      || extraction.slots.path
      || marker;
    return [
      { type: 'tool', tool: 'search_text', input: { query, path: '.', maxMatches: 20 } },
      { type: 'tool', tool: 'project_index', input: { path: '.', maxFiles: 1000 } },
      { type: 'message', content: 'Done. I translated the natural-language request into 2 tool call(s).' },
    ];
  }

  // Preserve a few mock-only demo intents that are intentionally strategy-only in the shared planner.
  const strategy = planToolStrategy({ prompt, recentTools: [], workspaceRoot });
  if (strategy.intent === 'project_overview' || hasAny(normalized, ['文件', '目录', '列出', '看看项目', '有哪些', 'list', 'files', 'tree'])) {
    actions.push({ type: 'tool', tool: 'list_files', input: { path: '.', maxFiles: 100 } });
  }
  if (extraction.intent === 'shell_command' || hasAny(normalized, ['运行', '执行', 'run command'])) {
    actions.push({ type: 'tool', tool: 'run_command', input: { command: extraction.slots.command ?? extractShellCommand(prompt) ?? 'node --version', timeoutMs: 30000 } });
  }
  if (actions.length === 0 && path) {
    actions.push({ type: 'tool', tool: 'read_file', input: { path, maxBytes: 20000 } });
  }
  if (actions.length > 0) {
    actions.push({ type: 'message', content: `Done. I translated the natural-language request into ${actions.length} tool call(s).` });
  }
  return actions;
}

function answerSmallTalk(prompt: string) {
  const normalized = prompt.trim().toLowerCase();
  if (hasAny(normalized, ['你好', 'hello', 'hi'])) {
    return '你好。我是 aicode CLI 的本地演示 agent。你可以直接用自然语言让我查看项目、读取文件、搜索文本、写入 .smoke 目录里的文件，或运行允许的命令。';
  }
  if (hasAny(normalized, ['啥意思', '什么意思', '是啥', '这是什么', '你是谁', '你能干嘛', 'help', '帮助'])) {
    return [
      '这是一个本地 CLI 编程助手 MVP。当前 mock 模式不联网，但可以把明确的自然语言任务转换成本地工具调用。',
      '你可以这样说：',
      '1. 帮我看看这个项目有哪些文件',
      '2. 读取 cli/src/index.ts',
      '3. 搜索 AICODE_SMOKE_MULTI_TOOL',
      '4. 请帮我写 .smoke/test.md，读取它，搜索 AICODE_NL_MARKER，然后运行 node --version',
      '如果要真正开放式聊天和推理，请用 --provider openai 或 --provider anthropic 并配置 API key。',
    ].join('\n');
  }
  return [
    '我没有把这句话识别成可执行任务。mock 模式主要演示本地工具链，不是完整大模型聊天。',
    '可以试试：帮我看看这个项目有哪些文件；读取 cli/src/index.ts；搜索 AICODE_SMOKE_MULTI_TOOL；运行 node --version。',
  ].join('\n');
}

function latestUserMessage(messages: AgentMessage[]) {
  return [...messages].reverse().find((message) => message.role === 'user');
}

function currentTurnToolCount(messages: AgentMessage[]) {
  const lastUserIndex = findLastIndex(messages, (message) => message.role === 'user');
  if (lastUserIndex < 0) return 0;
  return messages.slice(lastUserIndex + 1).filter((message) => message.role === 'tool').length;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return index;
  }
  return -1;
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

function extractPath(prompt: string) {
  const match = prompt.match(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|(?:^|\s)(\.smoke\/[A-Za-z0-9_.-]+)|(?:^|\s)([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/);
  return match?.[0]?.trim() ?? match?.[1] ?? match?.[2];
}

function extractMarker(prompt: string) {
  const upper = prompt.match(/\b[A-Z][A-Z0-9_]{4,}\b/);
  if (upper) return upper[0];
  const quoted = prompt.match(/["'“”‘’]([^"'“”‘’]{2,80})["'“”‘’]/);
  return quoted?.[1];
}

function extractSearchQuery(prompt: string, options?: { keepPaths?: boolean }) {
  let cleaned = prompt
    .replace(/帮我|请|一下|修复|修改|实现|新增|删除|重构|优化|查找|搜索|在哪里|的问题|问题/gi, ' ')
    .replace(/\b(?:please|kindly|fix|modify|implement|add|delete|refactor|optimize|update|find|search|look\s+for|locate)\b/gi, ' ')
    .replace(/^\s*for\b/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!options?.keepPaths) {
    cleaned = cleaned.replace(/(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+|(?:^|\s)([A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/g, ' ').replace(/\s+/g, ' ').trim();
  }
  return cleaned || extractMarker(prompt);
}

function appendRemainingExplicitActions(actions: AgentAction[], prompt: string, normalized: string, marker: string) {
  if (hasAny(normalized, ['搜索', '查找', '出现在哪里', 'search', 'find', 'grep'])) {
    actions.push({ type: 'tool', tool: 'search_text', input: { query: marker, path: '.', maxMatches: 20 } });
  }

  const command = extractShellCommand(prompt);
  if (command || hasAny(normalized, ['运行', '执行', 'run command'])) {
    actions.push({ type: 'tool', tool: 'run_command', input: { command: command ?? 'node --version', timeoutMs: 30000 } });
  }
}

function extractShellCommand(prompt: string) {
  const match = prompt.match(/(?:运行|执行|run|execute)\s+([^，。\n]+)/i);
  return match?.[1]?.trim();
}

function isWritableSmokePath(path: string) {
  return path.replace(/\\/g, '/').startsWith('.smoke/');
}
