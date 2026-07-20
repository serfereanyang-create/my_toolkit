import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn } from '../src/agent/agent.js';
import type { AppConfig } from '../src/config/types.js';
import { createMockProvider } from '../src/providers/mock.js';
import { parseToolActions } from '../src/providers/protocol.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';

test('mock provider completes a multi-tool smoke chain', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-smoke-'));
  const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir,
    prompt: 'smoke multi-tool task',
    maxSteps: 20,
    noBanner: true,
  };
  const provider = createMockProvider(config.model);
  const tools = createDefaultToolRegistry();
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  const ui = new TerminalUI(true);

  await runAgentTurn({ config, provider, tools, sessions, session, ui }, 'smoke multi-tool task');

  const toolNames = new Set(session.toolCalls.map((call) => call.tool));
  assert.ok(toolNames.size >= 5, `expected at least five tools, saw ${Array.from(toolNames).join(', ')}`);
  assert.ok(toolNames.has('project_status'));
  assert.ok(toolNames.has('write_file'));
  assert.ok(toolNames.has('read_file'));
  assert.ok(toolNames.has('search_text'));
  assert.ok(toolNames.has('run_command'));
  assert.ok(session.toolCalls.every((call) => call.ok), 'all smoke tool calls should pass');

  const artifact = await readFile(join(workspace, '.smoke', 'multi-tool-result.md'), 'utf8');
  assert.match(artifact, /AICODE_SMOKE_MULTI_TOOL/);

  const stored = JSON.parse(await readFile(sessions.filePath(session.id), 'utf8')) as typeof session;
  assert.equal(stored.toolCalls.length, session.toolCalls.length);
  assert.ok(stored.messages.some((message) => message.role === 'tool'));

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider plans natural-language tool chains', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-nl-'));
  const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'auto',
    workspaceRoot: workspace,
    sessionDir,
    prompt: '请帮我写 .smoke/nl.md，读取它，搜索 AICODE_NL_MARKER，然后运行 node --version',
    maxSteps: 20,
    noBanner: true,
  };
  const provider = createMockProvider(config.model);
  const tools = createDefaultToolRegistry();
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  const ui = new TerminalUI(true);

  await runAgentTurn({ config, provider, tools, sessions, session, ui }, config.prompt ?? '');

  const toolNames = session.toolCalls.map((call) => call.tool);
  assert.deepEqual(toolNames, ['write_file', 'read_file', 'search_text', 'run_command']);
  assert.ok(session.toolCalls.every((call) => call.ok), 'natural-language tool calls should pass');

  const artifact = await readFile(join(workspace, '.smoke', 'nl.md'), 'utf8');
  assert.match(artifact, /AICODE_NL_MARKER/);
  assert.match(session.finalAnswers.at(-1) ?? '', /natural-language request/);

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider plans code edit prompts with inspect-first tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-code-edit-'));

  try {
    await writeFile(join(workspace, 'package.json'), '{"name":"fixture"}\n');
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
    const tools = createDefaultToolRegistry();
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
    const ui = new TerminalUI(true);

    await runAgentTurn({ config, provider, tools, sessions, session, ui }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      { tool: 'project_index', input: { path: '.', maxFiles: 1000 }, ok: true },
      { tool: 'search_text', input: { query: '登录按钮点击没有反应', path: '.', maxMatches: 20 }, ok: true },
      { tool: 'read_file', input: { path: 'package.json', maxBytes: 20000 }, ok: true },
    ]);
    assert.match(session.finalAnswers.at(-1) ?? '', /3 tool call/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider uses a deterministic search fallback for subjectless code edits', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-subjectless-edit-'));

  try {
    await writeFile(join(workspace, 'package.json'), '{"name":"fixture","note":"TODO"}\n');
    const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
    const config: AppConfig = {
      provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace,
      sessionDir, prompt: '修复问题', maxSteps: 10, noBanner: true,
    };
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      { tool: 'project_index', input: { path: '.', maxFiles: 1000 }, ok: true },
      { tool: 'search_text', input: { query: 'TODO', path: '.', maxMatches: 20 }, ok: true },
      { tool: 'read_file', input: { path: 'package.json', maxBytes: 20000 }, ok: true },
    ]);
    assert.match(session.finalAnswers.at(-1) ?? '', /3 tool call/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider plans code search prompts with search before listing', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-code-search-'));

  try {
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
    const tools = createDefaultToolRegistry();
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
    const ui = new TerminalUI(true);

    await runAgentTurn({ config, provider, tools, sessions, session, ui }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      { tool: 'search_text', input: { query: '认证逻辑', path: '.', maxMatches: 20 }, ok: true },
      { tool: 'project_index', input: { path: '.', maxFiles: 1000 }, ok: true },
    ]);
    assert.match(session.finalAnswers.at(-1) ?? '', /2 tool call/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider reads an explicit disk-named source path for code edits', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-disk-source-'));

  try {
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'src', 'disk.ts'), 'export const label = "disk";\n');
    const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
    const config: AppConfig = {
      provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace,
      sessionDir, prompt: '修复 src/disk.ts 的显示问题', maxSteps: 10, noBanner: true,
    };
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      { tool: 'project_index', input: { path: '.', maxFiles: 1000 }, ok: true },
      { tool: 'search_text', input: { query: 'src/disk.ts 的显示', path: '.', maxMatches: 20 }, ok: true },
      { tool: 'read_file', input: { path: 'src/disk.ts', maxBytes: 20000 }, ok: true },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider preserves explicit write and read actions for disk-named files', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-disk-chain-'));

  try {
    const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
    const config: AppConfig = {
      provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace,
      sessionDir, prompt: '请创建 .smoke/disk.md，读取它', maxSteps: 10, noBanner: true,
    };
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      {
        tool: 'write_file',
        input: {
          path: '.smoke/disk.md',
          content: '# Natural language tool result\n\nmarker: AICODE_NL_DRIVE\n\nThis file was created from a natural-language request.\n',
        },
        ok: true,
      },
      { tool: 'read_file', input: { path: '.smoke/disk.md', maxBytes: 20000 }, ok: true },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider prioritizes a standalone explicit read of a disk-named file', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-disk-read-'));

  try {
    await writeFile(join(workspace, 'disk.md'), '# Disk fixture\n');
    const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
    const config: AppConfig = {
      provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace,
      sessionDir, prompt: '读取 disk.md', maxSteps: 10, noBanner: true,
    };
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      { tool: 'read_file', input: { path: 'disk.md', maxBytes: 20000 }, ok: true },
    ]);
    assert.equal(session.toolCalls.some(({ tool }) => tool === 'disk_info'), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider uses project index only when search has no subject', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-empty-search-'));

  try {
    const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
    const config: AppConfig = {
      provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace,
      sessionDir, prompt: '搜索一下', maxSteps: 10, noBanner: true,
    };
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      { tool: 'project_index', input: { path: '.', maxFiles: 1000 }, ok: true },
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider removes English directive words from search queries', async () => {
  const response = await createMockProvider().complete({
    messages: [{ role: 'user', content: 'Please search for authentication handler', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: 'C:/workspace',
  });

  assert.deepEqual(response.actions[0], {
    type: 'tool',
    tool: 'search_text',
    input: { query: 'authentication handler', path: '.', maxMatches: 20 },
  });
});

test('mock provider searches standalone disk-named source files instead of disk_info', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-disk-search-'));

  try {
    await writeFile(join(workspace, 'disk.ts'), 'export const quota = 1;\n');
    const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
    const config: AppConfig = {
      provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace,
      sessionDir, prompt: 'search disk.ts for quota', maxSteps: 10, noBanner: true,
    };
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool, input, ok }) => ({ tool, input, ok })), [
      { tool: 'search_text', input: { query: 'disk.ts for quota', path: '.', maxMatches: 20 }, ok: true },
      { tool: 'project_index', input: { path: '.', maxFiles: 1000 }, ok: true },
    ]);
    assert.equal(session.toolCalls.some(({ tool }) => tool === 'disk_info'), false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider does not treat English substrings as explicit write or read actions', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-substring-edit-'));

  try {
    await writeFile(join(workspace, 'package.json'), '{"name":"fixture"}\n');
    const sessionDir = join(workspace, '.aicode-smoke', 'sessions');
    const config: AppConfig = {
      provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace,
      sessionDir, prompt: 'fix the rewrite handler in the openapi thread', maxSteps: 10, noBanner: true,
    };
    const provider = createMockProvider(config.model);
    const sessions = new SessionStore(sessionDir);
    const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });

    await runAgentTurn({ config, provider, tools: createDefaultToolRegistry(), sessions, session, ui: new TerminalUI(true) }, config.prompt ?? '');

    assert.deepEqual(session.toolCalls.map(({ tool }) => tool), ['project_index', 'search_text', 'read_file']);
    assert.equal(session.toolCalls.some(({ tool }) => tool === 'write_file'), false);
    assert.match(session.finalAnswers.at(-1) ?? '', /3 tool call/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('mock provider explicit-action detection uses English word boundaries', async () => {
  const provider = createMockProvider();
  const createdAt = new Date().toISOString();

  const falsePositive = await provider.complete({
    messages: [{ role: 'user', content: 'rewrite the openapi thread notes', createdAt }],
    tools: [],
    workspaceRoot: 'C:/workspace',
  });
  const falsePositiveTools = falsePositive.actions
    .filter((action): action is { type: 'tool'; tool: string; input: Record<string, unknown> } => action.type === 'tool')
    .map((action) => action.tool);
  assert.equal(falsePositiveTools.includes('write_file'), false);
  assert.equal(falsePositiveTools.includes('read_file'), false);

  const write = await provider.complete({
    messages: [{ role: 'user', content: 'write .smoke/word-boundary.md with marker BOUNDARY_WRITE', createdAt }],
    tools: [],
    workspaceRoot: 'C:/workspace',
  });
  assert.equal(write.actions[0]?.type, 'tool');
  if (write.actions[0]?.type === 'tool') {
    assert.equal(write.actions[0].tool, 'write_file');
  }

  const read = await provider.complete({
    messages: [{ role: 'user', content: 'read package.json', createdAt }],
    tools: [],
    workspaceRoot: 'C:/workspace',
  });
  assert.equal(read.actions[0]?.type, 'tool');
  if (read.actions[0]?.type === 'tool') {
    assert.equal(read.actions[0].tool, 'read_file');
  }

  const open = await provider.complete({
    messages: [{ role: 'user', content: 'open package.json', createdAt }],
    tools: [],
    workspaceRoot: 'C:/workspace',
  });
  assert.equal(open.actions[0]?.type, 'tool');
  if (open.actions[0]?.type === 'tool') {
    assert.equal(open.actions[0].tool, 'read_file');
  }
});

test('mock provider plans project index requests', async () => {
  const provider = createMockProvider();
  const response = await provider.complete({
    messages: [{ role: 'user', content: '帮我看看项目索引', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });

  assert.equal(response.actions[0]?.type, 'tool');
  if (response.actions[0]?.type === 'tool') {
    assert.equal(response.actions[0].tool, 'project_index');
    assert.deepEqual(response.actions[0].input, { path: '.', maxFiles: 1000 });
  }
});


test('mock provider answers Chinese small-talk in Chinese', async () => {
  const provider = createMockProvider();
  const hello = await provider.complete({
    messages: [{ role: 'user', content: '你好', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });
  const what = await provider.complete({
    messages: [{ role: 'user', content: '是啥', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });

  assert.equal(hello.actions[0]?.type, 'message');
  assert.equal(what.actions[0]?.type, 'message');
  assert.match(hello.actions[0]?.type === 'message' ? hello.actions[0].content : '', /你好/);
  assert.match(what.actions[0]?.type === 'message' ? what.actions[0].content : '', /本地 CLI 编程助手 MVP/);
  assert.doesNotMatch(what.actions[0]?.type === 'message' ? what.actions[0].content : '', /I can understand/);
});

test('provider protocol parses natural-language tool JSON formats', () => {
  assert.deepEqual(parseToolActions('{"tool":"read_file","input":{"path":"package.json"}}'), [{ type: 'tool', tool: 'read_file', input: { path: 'package.json' } }]);
  assert.deepEqual(parseToolActions('```json\n{"tool":"run_command","input":{"command":"node --version"}}\n```'), [{ type: 'tool', tool: 'run_command', input: { command: 'node --version' } }]);
  assert.deepEqual(parseToolActions('[{"tool":"project_status","input":{}}]'), [{ type: 'tool', tool: 'project_status', input: {} }]);
  assert.deepEqual(parseToolActions('{"tool":"list_files","input":{"path":"cli/src/providers"}}{"tool":"run_command","input":{"command":"node --version"}}已完成'), [
    { type: 'tool', tool: 'list_files', input: { path: 'cli/src/providers' } },
    { type: 'tool', tool: 'run_command', input: { command: 'node --version' } },
  ]);
});
