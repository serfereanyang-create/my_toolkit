# Tool Strategy Coding Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic tool strategy layer so the CLI agent chooses coding and diagnostic tools more deliberately, with specific recovery hints and modest cache guidance.

**Architecture:** Create a pure `toolStrategy` module that classifies prompts and recent tool failures into recommended tools, avoided tools, cache hints, and recovery hints. Inject formatted strategy guidance into hosted provider prompts, reuse the classifier in the mock provider, and make recoverable tool failures visible to the next model step with concrete guidance.

**Tech Stack:** TypeScript, Node.js test runner, existing CLI provider/tool/session architecture.

---

## File Structure

- Create `cli/src/agent/toolStrategy.ts`
  - Owns intent classification, strategy formatting, recent tool extraction, and failure recovery hints.
  - Pure functions only; no file I/O or provider calls.

- Modify `cli/src/providers/types.ts`
  - Add optional `toolStrategy?: string` to `ProviderRequest`.

- Modify `cli/src/providers/protocol.ts`
  - Extend `buildToolSystemPrompt()` to accept and render strategy guidance.

- Modify `cli/src/providers/openai.ts`
  - Pass `request.toolStrategy` into `buildToolSystemPrompt()`.

- Modify `cli/src/providers/anthropic.ts`
  - Pass `request.toolStrategy` into `buildToolSystemPrompt()`.

- Modify `cli/src/agent/agent.ts`
  - Build strategy once per turn from prompt and recent tool messages.
  - Pass formatted strategy to provider calls.
  - Add specific recovery hints to the recoverable-failure session trail.

- Modify `cli/src/providers/mock.ts`
  - Reuse `planToolStrategy()` for common intents.
  - Keep smoke demo behavior intact.

- Create `cli/tests/tool-strategy.test.ts`
  - Unit tests for classification, formatted prompt guidance, recent tool extraction, and recovery hints.

- Modify `cli/tests/smoke.test.ts`
  - Add prompt-level assertions that code edit/search mock planning uses smarter inspect/search/read choices.

- Modify `cli/tests/autonomy.test.ts`
  - Add assertion that recoverable failures include specific recovery guidance.

- Modify `cli/src/audit/checks.ts`
  - Register the new file and test coverage needles.

---

### Task 1: Add Tool Strategy Classifier

**Files:**
- Create: `cli/src/agent/toolStrategy.ts`
- Test: `cli/tests/tool-strategy.test.ts`

- [ ] **Step 1: Write failing tests for strategy classification**

Create `cli/tests/tool-strategy.test.ts` with:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatToolStrategy, planToolStrategy } from '../src/agent/toolStrategy.js';

test('tool strategy classifies disk growth prompts narrowly', () => {
  const strategy = planToolStrategy({ prompt: '帮我检查最近的大文件导致磁盘增长', recentTools: [], workspaceRoot: process.cwd() });

  assert.equal(strategy.intent, 'disk_growth');
  assert.deepEqual(strategy.recommendedTools, ['disk_growth']);
  assert.ok(strategy.avoidTools.includes('list_files'));
  assert.ok(strategy.avoidTools.includes('run_command'));
});

test('tool strategy classifies code edit prompts as inspect first', () => {
  const strategy = planToolStrategy({ prompt: '修复登录按钮点击后没有反应的问题', recentTools: [], workspaceRoot: process.cwd() });

  assert.equal(strategy.intent, 'code_edit');
  assert.deepEqual(strategy.recommendedTools, ['project_index', 'search_text', 'read_file', 'apply_patch', 'write_file']);
  assert.ok(strategy.avoidTools.includes('run_command before inspection'));
  assert.ok(strategy.cacheHints.some((hint) => hint.includes('project_index')));
});

test('tool strategy classifies code search prompts before broad listing', () => {
  const strategy = planToolStrategy({ prompt: '查找用户认证逻辑在哪里', recentTools: [], workspaceRoot: process.cwd() });

  assert.equal(strategy.intent, 'code_search');
  assert.deepEqual(strategy.recommendedTools, ['search_text', 'project_index', 'read_file']);
  assert.ok(strategy.avoidTools.includes('list_files for broad discovery'));
});

test('formatToolStrategy renders compact provider guidance', () => {
  const strategy = planToolStrategy({ prompt: '修改 cli/src/index.ts', recentTools: [], workspaceRoot: process.cwd() });
  const formatted = formatToolStrategy(strategy);

  assert.match(formatted, /Tool strategy:/);
  assert.match(formatted, /intent=code_edit/);
  assert.match(formatted, /recommended=project_index, search_text, read_file, apply_patch, write_file/);
  assert.match(formatted, /avoid=run_command before inspection/);
  assert.match(formatted, /cacheHints=/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "tool strategy"
```

Expected: FAIL because `../src/agent/toolStrategy.js` does not exist.

- [ ] **Step 3: Implement `toolStrategy.ts`**

Create `cli/src/agent/toolStrategy.ts`:

```ts
export type ToolIntent = 'code_edit' | 'code_search' | 'disk_growth' | 'disk_capacity' | 'project_overview' | 'runtime_info' | 'unknown';

export type RecentToolResult = {
  tool: string;
  ok: boolean;
  output: string;
};

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
  const baseCacheHints = ['Reuse unchanged project context cacheKey when present.'];

  if (hasAny(normalized, ['增长', '涨了', '大文件', '清理', '最近文件', 'disk growth', 'large files'])) {
    return strategy('disk_growth', ['disk_growth'], ['list_files', 'project_index', 'run_command'], 'Disk growth request; inspect recent large files directly.', baseCacheHints, input.recentTools);
  }

  if (hasAny(normalized, ['磁盘', '硬盘', 'c盘', 'd盘', '容量', '剩余空间', '多大', 'disk', 'drive', 'free space'])) {
    return strategy('disk_capacity', ['disk_info'], ['run_command'], 'Disk capacity request; use the dedicated disk tool.', baseCacheHints, input.recentTools);
  }

  if (hasAny(normalized, ['环境', '容器', '系统信息', '运行环境', '内存', '进程', 'environment', 'container', 'runtime', 'memory', 'process'])) {
    const tool = hasAny(normalized, ['内存', '进程', 'memory', 'process']) ? 'process_memory' : 'environment_info';
    return strategy('runtime_info', [tool], ['run_command'], 'Runtime information request; use a dedicated environment or process tool.', baseCacheHints, input.recentTools);
  }

  if (hasAny(normalized, ['修复', '修改', '实现', '新增', '删除', '重构', '优化', '改成', 'fix', 'modify', 'implement', 'add', 'delete', 'refactor', 'optimize', 'update'])) {
    return strategy(
      'code_edit',
      ['project_index', 'search_text', 'read_file', 'apply_patch', 'write_file'],
      ['run_command before inspection', 'write_file before reading target files', 'list_files for broad discovery'],
      'Code editing request; inspect relevant files before editing.',
      [...baseCacheHints, 'Use project_index before broad file reads.', 'Prefer recently read tool results when the same file is unchanged.'],
      input.recentTools,
    );
  }

  if (hasAny(normalized, ['查找', '搜索', '在哪里', '引用', '定位', 'find', 'search', 'grep', 'reference', 'where'])) {
    return strategy(
      'code_search',
      ['search_text', 'project_index', 'read_file'],
      ['list_files for broad discovery', 'run_command unless dedicated tools cannot answer'],
      'Code search request; search targeted text before broad listing.',
      [...baseCacheHints, 'Use project_index to narrow search scope when available.'],
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
  return { intent, recommendedTools, avoidTools, reason, cacheHints, recoveryHints: recentTools.flatMap((tool) => recoveryHintForToolFailure(tool.tool, tool.output) ?? []) };
}

function hasAny(value: string, needles: string[]) {
  return needles.some((needle) => value.includes(needle));
}

export function recoveryHintForToolFailure(tool: string, output: string): string | undefined {
  const normalized = output.toLowerCase();
  if (normalized.includes('path escapes workspace')) return undefined;
  if (normalized.includes('cancelled by user')) return undefined;
  if (normalized.includes('blocked:')) return 'The command was blocked; choose a dedicated read-only tool or ask for approval only if shell access is required.';
  if (normalized.includes('not found') || normalized.includes('no such file') || normalized.includes('enoent')) return `The ${tool} target was not found; use project_index, list_files, or search_text to locate the correct path.`;
  if (normalized.includes('old text not found') || normalized.includes('text not found')) return `The ${tool} edit anchor was not found; read_file the target and retry with exact surrounding text.`;
  if (normalized.includes('is not recognized') || normalized.includes('command not found')) return `The ${tool} command failed on this platform; use a platform-correct command or a dedicated tool.`;
  if (tool === 'search_text' && normalized.includes('no matches')) return 'The search had no matches; broaden the query or use project_index before reading random files.';
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "tool strategy"
```

Expected: PASS for all `tool strategy` tests.

- [ ] **Step 5: Commit if this workspace is a git repository**

Run:

```bash
git rev-parse --is-inside-work-tree && git add cli/src/agent/toolStrategy.ts cli/tests/tool-strategy.test.ts && git commit -m "feat: add tool strategy classifier"
```

Expected in current workspace: `git rev-parse` may fail because `C:\Users\34516\ZCodeProject` is not a git repository. If it fails, skip the commit and record that in the final handoff.

---

### Task 2: Inject Strategy Guidance Into Provider Prompts

**Files:**
- Modify: `cli/src/providers/types.ts:17-22`
- Modify: `cli/src/providers/protocol.ts:2-15`
- Modify: `cli/src/providers/openai.ts:22-25`
- Modify: `cli/src/providers/anthropic.ts:23-28`
- Test: `cli/tests/tool-strategy.test.ts`

- [ ] **Step 1: Add failing tests for prompt strategy guidance**

Append to `cli/tests/tool-strategy.test.ts`:

```ts
import { buildToolSystemPrompt } from '../src/providers/protocol.js';

test('tool system prompt includes strategy guidance when provided', () => {
  const prompt = buildToolSystemPrompt([], undefined, 'Tool strategy:\nintent=code_edit\nrecommended=project_index, search_text, read_file');

  assert.match(prompt, /Tool strategy:/);
  assert.match(prompt, /intent=code_edit/);
  assert.match(prompt, /recommended=project_index, search_text, read_file/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "tool system prompt includes strategy"
```

Expected: FAIL because `buildToolSystemPrompt()` does not accept or render a third argument.

- [ ] **Step 3: Update provider request type**

Modify `cli/src/providers/types.ts` so `ProviderRequest` is:

```ts
export type ProviderRequest = {
  messages: AgentMessage[];
  tools: ProviderToolSpec[];
  workspaceRoot: string;
  projectContext?: string;
  toolStrategy?: string;
};
```

- [ ] **Step 4: Update prompt builder**

Modify `cli/src/providers/protocol.ts` function signature and body:

```ts
export function buildToolSystemPrompt(tools: ProviderToolSpec[], projectContext?: string, toolStrategy?: string) {
  return [
    'You are a local coding CLI agent. The user writes natural language. When answering requires local project inspection, file edits, search, or command execution, request one tool call and wait for the tool result.',
    'Return tool calls as JSON only, either raw JSON or fenced JSON. Do not explain before or after a tool call.',
    'For multi-step tasks, return exactly one tool call at a time. After the tool result is provided, request the next tool. Only write the final answer after all required tool results are available.',
    'If a tool fails and the failure is recoverable, choose a better dedicated tool or a platform-correct fallback instead of asking the user to run the command manually.',
    'If the user asks to create a Word document or .docx file, use create_docx. Do not use run_command for Word document creation.',
    `Runtime platform: ${process.platform}. Prefer dedicated tools over shell commands. For disk capacity/free-space questions, use disk_info. For disk growth/recent large files questions, use disk_growth. For recent activity/session/history questions, use recent_activity. For environment/container/system identity questions, use environment_info. For memory/process ranking questions, use process_memory instead of run_command. If you must run a shell command on Windows, use Windows-compatible commands.`,
    projectContext ? `Project context and instructions:\n${projectContext}` : undefined,
    toolStrategy,
    'Tool call shape:',
    '{"tool":"read_file","input":{"path":"package.json"}}',
    'Available tools:',
    ...tools.map((tool) => `- ${tool.name} [${tool.risk}]: ${tool.description}. Input: ${tool.inputHint}`),
  ].filter((line): line is string => typeof line === 'string').join('\n');
}
```

- [ ] **Step 5: Pass strategy in hosted providers**

Modify `cli/src/providers/openai.ts` message construction:

```ts
messages: [{ role: 'system', content: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy) }, ...toToolAwareMessages(request.messages)],
```

Modify `cli/src/providers/anthropic.ts` system construction:

```ts
system: buildToolSystemPrompt(request.tools, request.projectContext, request.toolStrategy),
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "tool system prompt includes strategy"
```

Expected: PASS.

- [ ] **Step 7: Commit if this workspace is a git repository**

Run:

```bash
git rev-parse --is-inside-work-tree && git add cli/src/providers/types.ts cli/src/providers/protocol.ts cli/src/providers/openai.ts cli/src/providers/anthropic.ts cli/tests/tool-strategy.test.ts && git commit -m "feat: inject tool strategy guidance"
```

Expected in current workspace: skip commit if not a git repository.

---

### Task 3: Build Strategy in Agent Turns

**Files:**
- Modify: `cli/src/agent/agent.ts:30-44`
- Test: `cli/tests/autonomy.test.ts`

- [ ] **Step 1: Add failing test that provider receives tool strategy**

Append this test to `cli/tests/autonomy.test.ts`. Also update the existing provider import near the top from `import type { Provider } from '../src/providers/types.js';` to `import type { Provider, ProviderRequest } from '../src/providers/types.js';`.

```ts
test('agent passes formatted tool strategy to provider requests', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-strategy-provider-'));
  const sessions = new SessionStore(join(workspace, 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
  let seenRequest: ProviderRequest | undefined;
  const provider: Provider = {
    name: 'mock',
    model: 'mock',
    async complete(request) {
      seenRequest = request;
      return { actions: [{ type: 'message', content: 'done' }] };
    },
  };
  const config: AppConfig = { provider: 'mock', model: 'mock', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 3, noBanner: true };

  await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, '修复登录按钮问题');

  assert.match(seenRequest?.toolStrategy ?? '', /intent=code_edit/);
  assert.match(seenRequest?.toolStrategy ?? '', /recommended=project_index, search_text, read_file/);

  await rm(workspace, { recursive: true, force: true });
});
```

If `autonomy.test.ts` already imports `ProviderRequest`, merge the import rather than duplicating it.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "agent passes formatted tool strategy"
```

Expected: FAIL because `runAgentTurn()` does not pass `toolStrategy` yet.

- [ ] **Step 3: Update `agent.ts` imports**

Add this import in `cli/src/agent/agent.ts`:

```ts
import { formatToolStrategy, planToolStrategy, recentToolResultsFromMessages } from './toolStrategy.js';
```

- [ ] **Step 4: Build and pass strategy in `runAgentTurn()`**

After project context creation, add:

```ts
  const toolStrategy = formatToolStrategy(planToolStrategy({
    prompt,
    recentTools: recentToolResultsFromMessages(runtime.session.messages),
    workspaceRoot: runtime.config.workspaceRoot,
  }));
```

Update provider request:

```ts
      response = await runtime.provider.complete({
        messages: runtime.session.messages,
        tools: runtime.tools.specs(),
        workspaceRoot: runtime.config.workspaceRoot,
        projectContext,
        toolStrategy,
      });
```

- [ ] **Step 5: Add `recentToolResultsFromMessages()` to `toolStrategy.ts`**

Add the provider type import at the top of `cli/src/agent/toolStrategy.ts` before exported types:

```ts
import type { AgentMessage } from '../providers/types.js';
```

Then append this function after `formatToolStrategy()`:

```ts
export function recentToolResultsFromMessages(messages: AgentMessage[], limit = 6): RecentToolResult[] {
  return messages
    .filter((message) => message.role === 'tool' && message.name)
    .slice(-limit)
    .map((message) => ({ tool: message.name ?? 'unknown', ok: !message.content.toLowerCase().includes('failed'), output: message.content }));
}
```

- [ ] **Step 6: Run test to verify it passes**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "agent passes formatted tool strategy|tool strategy"
```

Expected: PASS.

- [ ] **Step 7: Commit if this workspace is a git repository**

Run:

```bash
git rev-parse --is-inside-work-tree && git add cli/src/agent/agent.ts cli/src/agent/toolStrategy.ts cli/tests/autonomy.test.ts && git commit -m "feat: pass tool strategy through agent loop"
```

Expected in current workspace: skip commit if not a git repository.

---

### Task 4: Reuse Strategy in Mock Provider

**Files:**
- Modify: `cli/src/providers/mock.ts:48-121`
- Test: `cli/tests/growth.test.ts`
- Test: `cli/tests/smoke.test.ts`

- [ ] **Step 1: Add failing mock provider tests**

Append these tests to `cli/tests/smoke.test.ts`. Also update the existing fs import near the top from `import { mkdtemp, readFile, rm } from 'node:fs/promises';` to `import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';`.

```ts
test('mock provider plans code edit prompts with inspect-first tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-code-edit-plan-'));
  const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir,
    prompt: '修复登录按钮点击没有反应的问题',
    maxSteps: 10,
    noBanner: true,
  };
  const provider = createMockProvider(config.model);
  await writeFile(join(workspace, 'package.json'), '{"name":"fixture"}\n');
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

  await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

  assert.deepEqual(session.toolCalls.map((call) => call.tool), ['project_index', 'search_text', 'read_file']);
  assert.match(session.finalAnswers.at(-1) ?? '', /3 tool call/);

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider plans code search prompts with search before listing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-code-search-plan-'));
  const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir,
    prompt: '查找认证逻辑在哪里',
    maxSteps: 10,
    noBanner: true,
  };
  const provider = createMockProvider(config.model);
  await writeFile(join(workspace, 'package.json'), '{"name":"fixture"}\n');
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

  await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

  assert.deepEqual(session.toolCalls.map((call) => call.tool), ['search_text', 'project_index']);
  assert.match(session.finalAnswers.at(-1) ?? '', /2 tool call/);

  await rm(workspace, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "inspect-first|search before listing|disk_growth"
```

Expected: at least the new smoke tests fail because mock planning does not use the strategy yet.

- [ ] **Step 3: Import strategy into mock provider**

At the top of `cli/src/providers/mock.ts`, add:

```ts
import { planToolStrategy } from '../agent/toolStrategy.js';
```

- [ ] **Step 4: Use strategy at the start of `planNaturalLanguage()`**

Inside `planNaturalLanguage(prompt: string)`, after `writePath`, add:

```ts
  const toolStrategy = planToolStrategy({ prompt, recentTools: [], workspaceRoot: process.cwd() });

  if (toolStrategy.intent === 'disk_growth') {
    return [
      { type: 'tool', tool: 'disk_growth', input: { path: '.', hours: 48, minMb: 16, maxFiles: 30 } },
      { type: 'message', content: 'Done. I translated the natural-language request into 1 tool call(s).' },
    ];
  }

  if (toolStrategy.intent === 'disk_capacity') {
    return [
      { type: 'tool', tool: 'disk_info', input: { drive: normalized.includes('d盘') ? 'D' : 'C' } },
      { type: 'message', content: 'Done. I translated the natural-language request into 1 tool call(s).' },
    ];
  }

  if (toolStrategy.intent === 'code_search') {
    return [
      { type: 'tool', tool: 'search_text', input: { query: extractSearchQuery(prompt), path: '.', maxMatches: 20 } },
      { type: 'tool', tool: 'project_index', input: { path: '.', maxFiles: 1000 } },
      { type: 'message', content: 'Done. I translated the natural-language request into 2 tool call(s).' },
    ];
  }

  if (toolStrategy.intent === 'code_edit') {
    return [
      { type: 'tool', tool: 'project_index', input: { path: '.', maxFiles: 1000 } },
      { type: 'tool', tool: 'search_text', input: { query: extractSearchQuery(prompt), path: '.', maxMatches: 20 } },
      { type: 'tool', tool: 'read_file', input: { path: path ?? 'package.json', maxBytes: 20000 } },
      { type: 'message', content: 'Done. I translated the natural-language request into 3 tool call(s).' },
    ];
  }
```

This deliberately returns early for high-confidence strategy intents. It keeps the existing smoke demo and small-talk behavior intact because those are handled before `planNaturalLanguage()` or after it returns an empty plan.

- [ ] **Step 5: Add `extractSearchQuery()` helper**

Append near existing helpers in `cli/src/providers/mock.ts`:

```ts
function extractSearchQuery(prompt: string) {
  const cleaned = prompt
    .replace(/帮我|请|一下|修复|修改|实现|新增|删除|重构|优化|查找|搜索|在哪里|的问题|问题/g, ' ')
    .trim();
  return cleaned || extractMarker(prompt) || 'TODO';
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "inspect-first|search before listing|disk_growth|natural-language tool chains"
```

Expected: PASS. If the existing natural-language chain test fails because code-edit intent caught a smoke-style write prompt, narrow `code_edit` in `toolStrategy.ts` by requiring coding words such as `代码`, `bug`, `按钮`, `函数`, `组件`, `class`, `function`, `file`, or an explicit source path when prompt includes generic `写/创建`.

- [ ] **Step 7: Commit if this workspace is a git repository**

Run:

```bash
git rev-parse --is-inside-work-tree && git add cli/src/providers/mock.ts cli/tests/smoke.test.ts cli/tests/growth.test.ts && git commit -m "feat: reuse tool strategy in mock provider"
```

Expected in current workspace: skip commit if not a git repository.

---

### Task 5: Add Specific Recovery Hints to Agent Failures

**Files:**
- Modify: `cli/src/agent/agent.ts:88-116`
- Modify: `cli/src/agent/toolStrategy.ts`
- Test: `cli/tests/tool-strategy.test.ts`
- Test: `cli/tests/autonomy.test.ts`

- [ ] **Step 1: Add failing tests for recovery hint functions**

Append this test to `cli/tests/tool-strategy.test.ts`. Also merge `recoveryHintForToolFailure` into the existing top import from `../src/agent/toolStrategy.js`.

```ts
test('recovery hints explain path and edit failures', () => {
  assert.match(recoveryHintForToolFailure('read_file', 'ENOENT: no such file or directory') ?? '', /locate the correct path/);
  assert.match(recoveryHintForToolFailure('apply_patch', 'old text not found') ?? '', /retry with exact surrounding text/);
  assert.match(recoveryHintForToolFailure('run_command', 'blocked: command is not allowed') ?? '', /dedicated read-only tool/);
});
```

- [ ] **Step 2: Add failing agent recovery test**

Append to `cli/tests/autonomy.test.ts`:

```ts
test('agent records specific recovery hints after recoverable tool failure', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-recovery-hint-'));
  const sessions = new SessionStore(join(workspace, 'sessions'));
  const session = await sessions.create({ provider: 'mock', model: 'mock', workspaceRoot: workspace });
  let calls = 0;
  const provider: Provider = {
    name: 'mock',
    model: 'mock',
    async complete() {
      calls += 1;
      if (calls === 1) return { actions: [{ type: 'tool', tool: 'read_file', input: { path: 'missing.ts' } }] };
      return { actions: [{ type: 'message', content: 'recovered' }] };
    },
  };
  const config: AppConfig = { provider: 'mock', model: 'mock', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), maxSteps: 3, noBanner: true };

  const result = await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, '读取 missing.ts');

  assert.equal(result.ok, true);
  assert.ok(session.messages.some((message) => message.role === 'tool' && message.content.includes('Recovery hint:')));
  assert.ok(session.messages.some((message) => message.content.includes('locate the correct path')));

  await rm(workspace, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run tests to verify agent recovery test fails**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "recovery hints|specific recovery hints"
```

Expected: function test may pass from Task 1, but agent recovery test fails because session tool content lacks `Recovery hint:`.

- [ ] **Step 4: Update `executeToolAction()` to append hint into session output**

In `cli/src/agent/agent.ts`, import:

```ts
import { recoveryHintForToolFailure } from './toolStrategy.js';
```

If Task 3 already imports from `toolStrategy.js`, merge into one import:

```ts
import { formatToolStrategy, planToolStrategy, recentToolResultsFromMessages, recoveryHintForToolFailure } from './toolStrategy.js';
```

Inside `executeToolAction()`, before `appendToolCall`, add:

```ts
  const recoveryHint = result.ok ? undefined : recoveryHintForToolFailure(action.tool, result.output);
  const output = recoveryHint ? `${result.output}\nRecovery hint: ${recoveryHint}` : result.output;
```

Then change `appendToolCall` output field:

```ts
    output,
```

Change failure handling:

```ts
  if (!result.ok) {
    const reason = `Stopped after ${action.tool} failed: ${output}`;
    if (isTerminalToolFailure(result.output)) {
      await runtime.sessions.appendFinalAnswer(runtime.session, reason);
      return { ok: false, reason };
    }
    runtime.ui.info(recoveryHint ? `tool failed; recovery hint: ${recoveryHint}` : `tool failed; asking model to recover: ${action.tool}`);
    return { ok: true };
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
npm --prefix cli test -- --test-name-pattern "recovery hints|specific recovery hints|recoverable tool failure"
```

Expected: PASS.

- [ ] **Step 6: Commit if this workspace is a git repository**

Run:

```bash
git rev-parse --is-inside-work-tree && git add cli/src/agent/agent.ts cli/src/agent/toolStrategy.ts cli/tests/tool-strategy.test.ts cli/tests/autonomy.test.ts && git commit -m "feat: add specific tool failure recovery hints"
```

Expected in current workspace: skip commit if not a git repository.

---

### Task 6: Register Audit Coverage and Run Full Verification

**Files:**
- Modify: `cli/src/audit/checks.ts:90-118`
- Modify: `cli/src/audit/checks.ts:260-325`

- [ ] **Step 1: Add audit required file entry**

In `cli/src/audit/checks.ts`, add these required files to the `requiredFiles` list:

```ts
    'src/agent/toolStrategy.ts',
    'tests/tool-strategy.test.ts',
```

Place `src/agent/toolStrategy.ts` near other `src/agent/*` entries and `tests/tool-strategy.test.ts` near other test entries.

- [ ] **Step 2: Add audit needles for strategy implementation**

Near existing `agentNeedles` or `contextNeedles`, add:

```ts
  const toolStrategyNeedles = ['planToolStrategy', 'formatToolStrategy', 'recoveryHintForToolFailure', 'code_edit', 'disk_growth'];
  toolStrategyNeedles.forEach((needle) => checks.push({ name: `tool strategy contains ${needle}`, run: () => contains('src/agent/toolStrategy.ts', needle) }));
```

- [ ] **Step 3: Add audit needles for strategy tests**

Near other test needle sections, add:

```ts
  const toolStrategyTestNeedles = ['tool strategy classifies disk growth', 'tool strategy classifies code edit', 'tool system prompt includes strategy', 'recovery hints explain path and edit failures'];
  toolStrategyTestNeedles.forEach((needle) => checks.push({ name: `tool strategy test contains ${needle}`, run: () => contains('tests/tool-strategy.test.ts', needle) }));
```

- [ ] **Step 4: Run targeted verification**

Run:

```bash
npm --prefix cli run typecheck && npm --prefix cli test -- --test-name-pattern "tool strategy|strategy|recovery hints|inspect-first|search before listing|disk_growth" && npm --prefix cli run audit:100
```

Expected: typecheck passes, targeted tests pass, audit reports all checks passed.

- [ ] **Step 5: Run full verification**

Run:

```bash
npm --prefix cli test
```

Expected: all tests pass. Current baseline before this plan was 101 passing tests and 338 audit checks; counts should increase after adding `tool-strategy.test.ts` and audit checks.

- [ ] **Step 6: Manual smoke command**

Run:

```bash
node cli/dist/src/index.js --provider mock --approval auto --no-color --prompt "修复登录按钮点击没有反应的问题"
```

Expected output includes:

```text
Tool 1 project_index
...
Tool 2 search_text
...
Tool 3 read_file
...
Assistant
  Done. I translated the natural-language request into 3 tool call(s).
```

Run:

```bash
node cli/dist/src/index.js --provider mock --approval auto --no-color --prompt "帮我检查最近的大文件"
```

Expected output includes only one tool call before the assistant message:

```text
Tool 1 disk_growth
...
Assistant
  Done. I translated the natural-language request into 1 tool call(s).
```

- [ ] **Step 7: Commit if this workspace is a git repository**

Run:

```bash
git rev-parse --is-inside-work-tree && git add cli/src/audit/checks.ts && git commit -m "test: audit tool strategy coverage"
```

Expected in current workspace: skip commit if not a git repository.

---

## Self-Review

Spec coverage:
- Local strategy layer: Task 1.
- Intent classification and recommended/avoid tools: Task 1.
- Provider prompt injection: Task 2 and Task 3.
- Mock provider reuse: Task 4.
- Specific recoverable failure guidance: Task 5.
- Cache hints without persistent cache: Task 1 and Task 2.
- Tests and audit coverage: Task 1 through Task 6.

Placeholder scan:
- No `TBD`, `TODO`, or unspecified implementation sections remain.
- Each code step includes concrete code or exact replacement content.

Type consistency:
- `ToolStrategyContext`, `planToolStrategy()`, `formatToolStrategy()`, `recoveryHintForToolFailure()`, and `recentToolResultsFromMessages()` use consistent names across tasks.
- `ProviderRequest.toolStrategy` is optional and passed through OpenAI, Anthropic, and agent loop.

Repository note:
- The current workspace has previously reported `fatal: not a git repository`. Commit steps are included for portability but should be skipped here unless the workspace is initialized as a git repository before execution.
