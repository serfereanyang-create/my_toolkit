import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentMessage } from '../src/providers/types.js';
import { createAnthropicProvider } from '../src/providers/anthropic.js';
import { createOpenAIProvider } from '../src/providers/openai.js';
import { buildToolSystemPrompt, buildToolSystemPromptParts } from '../src/providers/protocol.js';
import { formatToolStrategy, planToolStrategy, recentToolResultsFromSession, recoveryHintForToolFailure } from '../src/agent/toolStrategy.js';
import { runCommandTool } from '../src/tools/shell.js';

test('recentToolResultsFromSession uses structured status and preserves duplicate tool order', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';
  const messages: AgentMessage[] = [
    { role: 'tool', name: 'apply_patch', content: 'Patch target text not found in cli/src/agent/agent.ts', createdAt },
    { role: 'tool', name: 'read_file', content: 'Read succeeded; failed is part of the file contents.', createdAt },
    { role: 'tool', name: 'read_file', content: 'Second read output', createdAt },
  ];

  assert.deepEqual(recentToolResultsFromSession({
    messages,
    toolCalls: [
      { id: 'tool_1', tool: 'apply_patch', input: {}, ok: false, output: messages[0].content, createdAt },
      { id: 'tool_2', tool: 'read_file', input: {}, ok: true, output: messages[1].content, createdAt },
      { id: 'tool_3', tool: 'read_file', input: {}, ok: false, output: messages[2].content, createdAt },
    ],
  }), [
    { tool: 'apply_patch', ok: false, output: 'Patch target text not found in cli/src/agent/agent.ts' },
    { tool: 'read_file', ok: true, output: 'Read succeeded; failed is part of the file contents.' },
    { tool: 'read_file', ok: false, output: 'Second read output' },
  ]);
});

test('recentToolResultsFromSession aligns identical outputs from the newest end', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';
  const duplicateMessage: AgentMessage = { role: 'tool', name: 'apply_patch', content: 'same output', createdAt };
  const toolCalls = [
    { id: 'tool_1', tool: 'apply_patch', input: {}, ok: false, output: duplicateMessage.content, createdAt },
    { id: 'tool_2', tool: 'apply_patch', input: {}, ok: true, output: duplicateMessage.content, createdAt },
  ];

  assert.deepEqual(recentToolResultsFromSession({
    messages: [duplicateMessage, { ...duplicateMessage }],
    toolCalls,
  }), [
    { tool: 'apply_patch', ok: false, output: 'same output' },
    { tool: 'apply_patch', ok: true, output: 'same output' },
  ]);

  assert.deepEqual(recentToolResultsFromSession({
    messages: [{ ...duplicateMessage }],
    toolCalls,
  }), [
    { tool: 'apply_patch', ok: true, output: 'same output' },
  ]);
});

test('recentToolResultsFromSession stops at an internal correlation gap', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';
  const messages: AgentMessage[] = [
    { role: 'tool', name: 'read_file', content: 'older output', createdAt },
    { role: 'tool', name: 'legacy_tool', content: 'missing call record', createdAt },
    { role: 'tool', name: 'read_file', content: 'latest output', createdAt },
  ];

  assert.deepEqual(recentToolResultsFromSession({
    messages,
    toolCalls: [
      { id: 'tool_1', tool: 'read_file', input: {}, ok: false, output: 'older output', createdAt },
      { id: 'tool_2', tool: 'read_file', input: {}, ok: true, output: 'latest output', createdAt },
    ],
  }), [
    { tool: 'read_file', ok: true, output: 'latest output' },
  ]);
});

test('recentToolResultsFromSession stops at an unnamed legacy tool gap', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';
  const messages: AgentMessage[] = [
    { role: 'tool', name: 'read_file', content: 'older output', createdAt },
    { role: 'tool', content: 'legacy tool message', createdAt },
    { role: 'tool', name: 'read_file', content: 'latest output', createdAt },
  ];

  assert.deepEqual(recentToolResultsFromSession({
    messages,
    toolCalls: [
      { id: 'tool_1', tool: 'read_file', input: {}, ok: false, output: 'older output', createdAt },
      { id: 'tool_2', tool: 'read_file', input: {}, ok: true, output: 'latest output', createdAt },
    ],
  }), [
    { tool: 'read_file', ok: true, output: 'latest output' },
  ]);
});

test('recentToolResultsFromSession ignores uncorrelated legacy-only histories', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';

  assert.deepEqual(recentToolResultsFromSession({
    messages: [
      { role: 'user', content: 'legacy session', createdAt },
      { role: 'tool', content: 'tool message without a name', createdAt },
      { role: 'tool', name: 'read_file', content: 'tool message without a call', createdAt },
    ],
    toolCalls: [],
  }), []);
});

test('recentToolResultsFromSession returns no results for nonpositive limits', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';
  const session = {
    messages: [{ role: 'tool' as const, name: 'read_file', content: 'output', createdAt }],
    toolCalls: [{ id: 'tool_1', tool: 'read_file', input: {}, ok: true, output: 'output', createdAt }],
  };

  assert.deepEqual(recentToolResultsFromSession(session, 0), []);
  assert.deepEqual(recentToolResultsFromSession(session, -1), []);
});

test('recentToolResultsFromSession does not mutate session history', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';
  const session = {
    messages: [
      { role: 'tool' as const, name: 'read_file', content: 'first', createdAt },
      { role: 'tool' as const, name: 'read_file', content: 'second', createdAt },
    ],
    toolCalls: [
      { id: 'tool_1', tool: 'read_file', input: { path: 'first' }, ok: false, output: 'first', createdAt },
      { id: 'tool_2', tool: 'read_file', input: { path: 'second' }, ok: true, output: 'second', createdAt },
    ],
  };
  const before = structuredClone(session);

  recentToolResultsFromSession(session, 1);

  assert.deepEqual(session, before);
});

test('recentToolResultsFromSession returns only the latest six named tool results', () => {
  const createdAt = '2026-07-10T00:00:00.000Z';
  const messages: AgentMessage[] = Array.from({ length: 7 }, (_, index) => ({
    role: 'tool' as const,
    name: 'read_file',
    content: `output ${index + 1}`,
    createdAt,
  }));

  const results = recentToolResultsFromSession({
    messages,
    toolCalls: messages.map((message, index) => ({
      id: `tool_${index + 1}`,
      tool: 'read_file',
      input: {},
      ok: index % 2 === 0,
      output: message.content,
      createdAt,
    })),
  });

  assert.deepEqual(results.map((result) => result.output), ['output 2', 'output 3', 'output 4', 'output 5', 'output 6', 'output 7']);
  assert.deepEqual(results.map((result) => result.ok), [false, true, false, true, false, true]);
  assert.deepEqual(
    recentToolResultsFromSession({
      messages,
      toolCalls: messages.map((message, index) => ({
        id: `tool_${index + 1}`,
        tool: 'read_file',
        input: {},
        ok: index % 2 === 0,
        output: message.content,
        createdAt,
      })),
    }, 2).map((result) => result.output),
    ['output 6', 'output 7'],
  );
});

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
  assert.deepEqual(strategy.recommendedTools, ['ts_hover', 'ts_goto_definition', 'ts_exact_references', 'find_symbol', 'find_references', 'project_index', 'search_text', 'read_file', 'apply_patch', 'write_file']);
  assert.ok(strategy.avoidTools.includes('run_command before inspection'));
  assert.ok(strategy.cacheHints.some((hint) => hint.includes('find_symbol')));
});

test('tool strategy does not treat English edit substrings inside search prompts as code_edit', () => {
  const additional = planToolStrategy({ prompt: 'search for additional button handlers', recentTools: [], workspaceRoot: process.cwd() });
  const prefix = planToolStrategy({ prompt: 'find the prefix function', recentTools: [], workspaceRoot: process.cwd() });
  const fixed = planToolStrategy({ prompt: 'find the fixed timeout', recentTools: [], workspaceRoot: process.cwd() });
  const updated = planToolStrategy({ prompt: 'search for updated timestamps', recentTools: [], workspaceRoot: process.cwd() });

  assert.equal(additional.intent, 'code_search');
  assert.equal(prefix.intent, 'code_search');
  assert.equal(fixed.intent, 'code_search');
  assert.equal(updated.intent, 'code_search');
});

test('tool strategy classifies English create and write prompts as code_edit', () => {
  const reactCreate = planToolStrategy({ prompt: 'create a new React component', recentTools: [], workspaceRoot: process.cwd() });
  const buttonCreate = planToolStrategy({ prompt: 'please create a new button component', recentTools: [], workspaceRoot: process.cwd() });
  const writeComponent = planToolStrategy({ prompt: 'write a new handler component', recentTools: [], workspaceRoot: process.cwd() });

  assert.equal(reactCreate.intent, 'code_edit');
  assert.equal(buttonCreate.intent, 'code_edit');
  assert.equal(writeComponent.intent, 'code_edit');
});

test('tool strategy keeps genuine English edit verbs as code_edit', () => {
  const fixLogin = planToolStrategy({ prompt: 'fix the login button', recentTools: [], workspaceRoot: process.cwd() });
  const updateHandler = planToolStrategy({ prompt: 'update the handler', recentTools: [], workspaceRoot: process.cwd() });
  const addComponent = planToolStrategy({ prompt: 'add a new component', recentTools: [], workspaceRoot: process.cwd() });

  assert.equal(fixLogin.intent, 'code_edit');
  assert.equal(updateHandler.intent, 'code_edit');
  assert.equal(addComponent.intent, 'code_edit');
});

test('tool strategy gives source edit intent precedence over incidental disk keywords', () => {
  const diskPath = planToolStrategy({ prompt: '修复 src/disk.ts 的显示问题', recentTools: [], workspaceRoot: 'C:/workspace' });
  const runtimePath = planToolStrategy({ prompt: 'modify src/runtime.ts to fix the parser', recentTools: [], workspaceRoot: 'C:/workspace' });

  assert.equal(diskPath.intent, 'code_edit');
  assert.equal(runtimePath.intent, 'code_edit');
});

test('tool strategy preserves genuine disk intent', () => {
  const cleanup = planToolStrategy({ prompt: '清理磁盘', recentTools: [], workspaceRoot: 'C:/workspace' });
  const recentFiles = planToolStrategy({ prompt: '检查最近大文件', recentTools: [], workspaceRoot: 'C:/workspace' });

  assert.equal(cleanup.intent, 'disk_growth');
  assert.equal(recentFiles.intent, 'disk_growth');
});

test('tool strategy classifies code search prompts before broad listing', () => {
  const strategy = planToolStrategy({ prompt: '查找用户认证逻辑在哪里', recentTools: [], workspaceRoot: process.cwd() });

  assert.equal(strategy.intent, 'code_search');
  assert.deepEqual(strategy.recommendedTools, ['find_symbol', 'find_references', 'search_text', 'project_index', 'read_file']);
  assert.ok(strategy.avoidTools.includes('list_files for broad discovery'));
});

test('tool strategy treats standalone diagnostic-named source files as code search', () => {
  const diskTs = planToolStrategy({ prompt: 'search disk.ts for quota', recentTools: [], workspaceRoot: 'C:/workspace' });
  const diskMd = planToolStrategy({ prompt: '搜索 disk.md 中的 quota', recentTools: [], workspaceRoot: 'C:/workspace' });
  const runtimeTs = planToolStrategy({ prompt: 'search runtime.ts for handler', recentTools: [], workspaceRoot: 'C:/workspace' });

  assert.equal(diskTs.intent, 'code_search');
  assert.equal(diskMd.intent, 'code_search');
  assert.equal(runtimeTs.intent, 'code_search');
});

test('tool strategy prefers code search when residual subject keywords remain after path stripping', () => {
  const runtimeMemory = planToolStrategy({ prompt: 'search runtime.ts for memory', recentTools: [], workspaceRoot: 'C:/workspace' });
  const runtimeProcess = planToolStrategy({ prompt: 'search src/runtime.ts for process', recentTools: [], workspaceRoot: 'C:/workspace' });
  const runtimeMemoryCjk = planToolStrategy({ prompt: '查找runtime.ts里的memory', recentTools: [], workspaceRoot: 'C:/workspace' });
  const diskFreeSpace = planToolStrategy({ prompt: 'search disk.ts for free space', recentTools: [], workspaceRoot: 'C:/workspace' });

  assert.equal(runtimeMemory.intent, 'code_search');
  assert.equal(runtimeProcess.intent, 'code_search');
  assert.equal(runtimeMemoryCjk.intent, 'code_search');
  assert.equal(diskFreeSpace.intent, 'code_search');
});

test('tool strategy treats unspaced Chinese prompts with diagnostic-named files as code search', () => {
  const diskTs = planToolStrategy({ prompt: '搜索disk.ts中的quota', recentTools: [], workspaceRoot: 'C:/workspace' });
  const runtimeTs = planToolStrategy({ prompt: '搜索runtime.ts里的handler', recentTools: [], workspaceRoot: 'C:/workspace' });
  // Residual-risk form without an explicit search verb must not fall into runtime_info.
  const runtimeView = planToolStrategy({ prompt: '查看runtime.ts里的handler', recentTools: [], workspaceRoot: 'C:/workspace' });

  assert.equal(diskTs.intent, 'code_search');
  assert.equal(runtimeTs.intent, 'code_search');
  assert.notEqual(runtimeView.intent, 'runtime_info');
});

test('tool strategy still classifies English genuine disk and runtime prompts', () => {
  const disk = planToolStrategy({ prompt: 'check free space on disk', recentTools: [], workspaceRoot: 'C:/workspace' });
  const runtime = planToolStrategy({ prompt: 'show runtime environment', recentTools: [], workspaceRoot: 'C:/workspace' });
  const memoryProcess = planToolStrategy({ prompt: 'show memory and process usage', recentTools: [], workspaceRoot: 'C:/workspace' });

  assert.equal(disk.intent, 'disk_capacity');
  assert.equal(runtime.intent, 'runtime_info');
  assert.equal(memoryProcess.intent, 'runtime_info');
});

test('tool strategy builds recovery hints only from failed recent tools', () => {
  const strategy = planToolStrategy({
    prompt: '修复登录按钮点击后没有反应的问题',
    recentTools: [
      { tool: 'read_file', ok: true, output: 'not found appears in successful content' },
      { tool: 'apply_patch', ok: false, output: 'old text not found' },
    ],
    workspaceRoot: process.cwd(),
  });

  assert.equal(strategy.recoveryHints.length, 1);
  assert.match(strategy.recoveryHints[0], /retry with exact surrounding text/);
});

test('formatToolStrategy renders compact provider guidance', () => {
  const strategy = planToolStrategy({ prompt: '修改 cli/src/index.ts', recentTools: [], workspaceRoot: process.cwd() });
  const formatted = formatToolStrategy(strategy);

  assert.match(formatted, /Tool strategy:/);
  assert.match(formatted, /intent=code_edit/);
  assert.match(formatted, /recommended=ts_hover, ts_goto_definition, ts_exact_references, find_symbol, find_references, project_index, search_text, read_file, apply_patch, write_file/);
  assert.match(formatted, /avoid=run_command before inspection/);
  assert.match(formatted, /cacheHints=/);
});

test('tool system prompt keeps strategy in the dynamic tail after the stable prefix', () => {
  const projectContext = 'project-context-marker';
  const toolStrategy = 'Tool strategy:\nintent=code_edit\nrecommended=project_index, search_text, read_file';
  const parts = buildToolSystemPromptParts([], projectContext, toolStrategy);

  // Stable (cacheable) prefix keeps context and fallback shape; strategy is excluded.
  const stable = parts.stable;
  const projectContextIndex = stable.indexOf(projectContext);
  const toolCallShapeIndex = stable.indexOf('Text fallback tool call shape:');
  assert.notEqual(projectContextIndex, -1);
  assert.notEqual(toolCallShapeIndex, -1);
  assert.ok(projectContextIndex < toolCallShapeIndex);
  assert.doesNotMatch(stable, /intent=code_edit/);

  // Dynamic block carries the per-turn strategy.
  assert.match(parts.dynamic ?? '', /intent=code_edit/);
});

test('tool system prompt omits strategy guidance from one- and two-argument calls', () => {
  const oneArgumentPrompt = buildToolSystemPrompt([]);
  const twoArgumentPrompt = buildToolSystemPrompt([], 'project-context-marker');

  assert.doesNotMatch(oneArgumentPrompt, /Tool strategy:/);
  assert.doesNotMatch(twoArgumentPrompt, /Tool strategy:/);
  assert.match(twoArgumentPrompt, /project-context-marker/);
});

test('tool system prompt always states the agent self-identity', () => {
  const prompt = buildToolSystemPrompt([]);
  assert.match(prompt, /You are aicode, a local coding CLI agent/);
  assert.doesNotMatch(prompt, /running embedded as the backend/);
});

test('tool system prompt reports desktop-bridge embedding only when identity says so', () => {
  const bridged = buildToolSystemPrompt([], undefined, undefined, { desktopBridge: true });
  assert.match(bridged, /running embedded as the backend of the YOYcode Desktop IDE/);

  const notBridged = buildToolSystemPrompt([], undefined, undefined, { desktopBridge: false });
  assert.doesNotMatch(notBridged, /running embedded as the backend/);
});

test('tool system prompt includes workspace root only when identity provides it', () => {
  const withRoot = buildToolSystemPrompt([], undefined, undefined, { workspaceRoot: 'C:/workspace/demo' });
  assert.match(withRoot, /Workspace root: C:\/workspace\/demo\. All relative paths in tool calls resolve against this root\./);

  const withoutRoot = buildToolSystemPrompt([]);
  assert.doesNotMatch(withoutRoot, /Workspace root:/);
});

test('tool system prompt without identity argument matches prior no-identity output', () => {
  const implicit = buildToolSystemPrompt([], 'ctx-marker', 'strategy-marker');
  const explicitEmpty = buildToolSystemPrompt([], 'ctx-marker', 'strategy-marker', {});
  assert.equal(implicit, explicitEmpty);
});

test('OpenAI serializes tool strategy into the outbound system message', async () => {
  const originalFetch = globalThis.fetch;
  const toolStrategy = 'Tool strategy:\nprovider-marker=openai';
  let outboundBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response('data: {"choices":[{"delta":{"content":"done"}}]}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const provider = createOpenAIProvider({ apiKey: 'test-key', baseUrl: 'https://openai.test/v1', model: 'test-model' });
    await provider.complete({
      messages: [{ role: 'user', content: 'test', createdAt: '2026-07-10T00:00:00.000Z' }],
      tools: [],
      workspaceRoot: process.cwd(),
      toolStrategy,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(outboundBody);
  assert.ok(Array.isArray(outboundBody.messages));
  const messages = outboundBody.messages as Array<{ role?: unknown; content?: unknown }>;
  // Auto-prefix cache layout: the stable system prompt leads, the per-turn
  // tool strategy is appended as the LAST message so the byte prefix before
  // it (system + full history) stays identical across turns and cache-hits.
  const lastMessage = messages[messages.length - 1];
  assert.equal(lastMessage.role, 'system');
  assert.match(String(lastMessage.content), /provider-marker=openai/);
  assert.doesNotMatch(String(messages[0].content), /provider-marker=openai/);
});

test('Anthropic serializes tool strategy into the outbound system prompt', async () => {
  const originalFetch = globalThis.fetch;
  const toolStrategy = 'Tool strategy:\nprovider-marker=anthropic';
  let outboundBody: Record<string, unknown> | undefined;

  globalThis.fetch = async (_input, init) => {
    outboundBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const provider = createAnthropicProvider({ apiKey: 'test-key', baseUrl: 'https://anthropic.test/v1', model: 'test-model' });
    await provider.complete({
      messages: [{ role: 'user', content: 'test', createdAt: '2026-07-10T00:00:00.000Z' }],
      tools: [],
      workspaceRoot: process.cwd(),
      toolStrategy,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(outboundBody);
  // System carries ONLY the stable block. The strategy used to be a second
  // system block, which put it inside the range the sliding message breakpoint
  // covers — Anthropic evaluates tools → system → messages — so a per-turn
  // change invalidated the whole conversation history. It now rides on the last
  // message instead, outside the cached prefix. The property that matters is
  // unchanged and is asserted below: changing the strategy must not reset the
  // reusable prefix.
  assert.ok(Array.isArray(outboundBody.system));
  const blocks = outboundBody.system as Array<{ type: string; text: string; cache_control?: unknown }>;
  assert.equal(blocks.length, 1, 'only the stable block belongs in system');
  assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' });
  assert.doesNotMatch(String(blocks[0]!.text), /provider-marker=anthropic/);

  // The strategy still reaches the model — appended to the last message.
  const messages = outboundBody.messages as Array<{ content: unknown }>;
  const lastContent = messages.at(-1)!.content;
  assert.ok(Array.isArray(lastContent));
  const lastBlocks = lastContent as Array<{ type: string; text: string; cache_control?: unknown }>;
  const strategyBlock = lastBlocks.at(-1)!;
  assert.match(String(strategyBlock.text), /provider-marker=anthropic/);
  // And it is NOT inside the cached range.
  assert.equal(strategyBlock.cache_control, undefined);
  assert.deepEqual(lastBlocks[0]!.cache_control, { type: 'ephemeral' });
});

test('Anthropic keeps the stable cache prefix when strategy changes', async () => {
  const originalFetch = globalThis.fetch;
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response([
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    const provider = createAnthropicProvider({ apiKey: process.env.AICODE_TEST_API_KEY || `test-${Date.now()}`, baseUrl: 'https://anthropic.test/v1', model: 'test-model' });
    const request = {
      messages: [{ role: 'user' as const, content: 'test', createdAt: '2026-07-10T00:00:00.000Z' }],
      tools: [],
      workspaceRoot: process.cwd(),
    };
    await provider.complete({ ...request, toolStrategy: 'strategy-one' });
    await provider.complete({ ...request, toolStrategy: 'strategy-two' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(bodies.length, 2);
  const firstSystem = bodies[0].system as Array<Record<string, unknown>>;
  const secondSystem = bodies[1].system as Array<Record<string, unknown>>;
  assert.deepEqual(firstSystem[0], secondSystem[0]);
  assert.deepEqual(firstSystem[0].cache_control, { type: 'ephemeral' });
  assert.equal(firstSystem.length, 1, 'system is stable-only; the strategy is not here');

  // The strategy really did differ between the two turns, so the assertion
  // below is not vacuous.
  const strategyOf = (body: Record<string, unknown>) => {
    const messages = body.messages as Array<{ content: unknown }>;
    const blocks = messages.at(-1)!.content as Array<{ text?: string; cache_control?: unknown }>;
    return blocks.at(-1)!;
  };
  const first = strategyOf(bodies[0]);
  const second = strategyOf(bodies[1]);
  assert.notEqual(first.text, second.text);
  assert.equal(first.cache_control, undefined);
  assert.equal(second.cache_control, undefined);

  // The property the whole arrangement exists for: the CACHED range is
  // byte-identical across turns even though the strategy changed. Comparing
  // only `system` would no longer prove anything, because system is now
  // strategy-free by construction — the cached range also includes every prior
  // message and the marked block of the newest one.
  const cachedRange = (body: Record<string, unknown>) => {
    const messages = body.messages as Array<{ content: unknown }>;
    const lastBlocks = messages.at(-1)!.content as Array<Record<string, unknown>>;
    return JSON.stringify([
      body.tools ?? [],
      body.system,
      messages.slice(0, -1),
      lastBlocks.slice(0, -1),
    ]);
  };
  assert.equal(cachedRange(bodies[0]), cachedRange(bodies[1]));
});
test('recovery hints explain path and edit failures', () => {
  assert.match(recoveryHintForToolFailure('read_file', 'ENOENT: no such file or directory') ?? '', /locate the correct path/);
  assert.match(recoveryHintForToolFailure('apply_patch', 'old text not found') ?? '', /retry with exact surrounding text/);
  assert.match(recoveryHintForToolFailure('run_command', 'blocked: command is not allowed') ?? '', /dedicated read-only tool/);
  assert.equal(recoveryHintForToolFailure('run_command', 'cancelled by user'), undefined);
  // A path escape is recoverable: the model must be told to retry in-workspace
  // rather than have the turn ended for it.
  assert.match(recoveryHintForToolFailure('read_file', 'Path escapes workspace') ?? '', /retry with a workspace-relative path/);
  assert.match(recoveryHintForToolFailure('read_file', '路径越出工作区') ?? '', /retry with a workspace-relative path/);
});
test('a missing shell command is answered with the replacement, in both locales', () => {
  // The English shapes.
  const english = recoveryHintForToolFailure(
    'run_command',
    "'tail' is not recognized as an internal or external command,\noperable program or batch file.",
  ) ?? '';
  assert.match(english, /`tail` is not on cmd\.exe's PATH/);
  assert.match(english, /head_tail/);
  // This machine's cmd.exe answers in Chinese; a matcher that only knew "is not
  // recognized" never fired here, so the model got no correction at all.
  const chinese = recoveryHintForToolFailure(
    'run_command',
    "'grep' 不是内部或外部命令，也不是可运行的程序\n或批处理文件。",
  ) ?? '';
  assert.match(chinese, /`grep` is not on/);
  assert.match(chinese, /search_text/);
  // That same Chinese message with its GBK bytes decoded as UTF-8: the words are
  // gone, only U+FFFD runs are left, and the token is the one surviving signal.
  assert.match(
    recoveryHintForToolFailure('run_command', "'ForEach-Object' ����\n����") ?? '',
    /`foreach-object` is not on .*powershell -NoProfile|head_tail/,
  );
  // PowerShell cmdlets refused by cmd.exe, both locales.
  assert.match(
    recoveryHintForToolFailure('run_command', "The term 'Get-Content' is not recognized as the name of a cmdlet") ?? '',
    /read_file|head_tail/,
  );
  assert.match(
    recoveryHintForToolFailure('run_command', '无法将“ForEach-Object”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。') ?? '',
    /powershell -NoProfile|head_tail|take_lines/,
  );
  // A command nobody mapped still gets the shell named and the way out.
  assert.match(
    recoveryHintForToolFailure('run_command', "'frobnicate' is not recognized as an internal or external command") ?? '',
    /`frobnicate` is not on .*(dedicated tool|powershell)/,
  );
  // "grep: command not found" also contains "not found" - it must not be
  // answered with path advice, which is what the order of these branches decides.
  const posix = recoveryHintForToolFailure('run_command', 'grep: command not found') ?? '';
  assert.match(posix, /search_text/);
  assert.doesNotMatch(posix, /locate the correct path/);
});
test('run_command tells the model which shell it gets and what that shell lacks', () => {
  const description = runCommandTool.description;
  assert.match(description, /cmd\.exe|\/bin\/sh/);
  // The failure class that actually cost calls: POSIX filters and PowerShell
  // cmdlets under cmd.exe, answered by naming the dedicated tools instead.
  assert.match(description, /head_tail|read_lines|search_text|list_files/);
});
