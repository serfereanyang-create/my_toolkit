import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { extractCommand, formatCommandStrategy, planCommand } from '../src/agent/commandExtract/index.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { TerminalUI } from '../src/ui/terminal.js';
import type { Provider, ProviderRequest } from '../src/providers/types.js';

test('extracts high-confidence readonly intents and slots', () => {
  const disk = extractCommand('C盘还有多少空间');
  assert.equal(disk.intent, 'disk_capacity');
  assert.equal(disk.slots.drive, 'C');
  assert.equal(disk.confidence, 'high');

  const search = extractCommand('搜索 apply_patch');
  assert.equal(search.intent, 'code_search');
  assert.equal(search.slots.query, 'apply_patch');
  assert.equal(search.confidence, 'high');

  const read = extractCommand('读取 package.json');
  assert.equal(read.intent, 'file_read');
  assert.equal(read.slots.path, 'package.json');
  assert.equal(read.confidence, 'high');

  const cache = extractCommand('缓存命中');
  assert.equal(cache.intent, 'cache_probe');
  assert.equal(cache.confidence, 'high');
  const cachePlan = planCommand(cache);
  assert.equal(cachePlan.mode, 'execute');
  assert.deepEqual(cachePlan.steps.map((step) => step.tool), ['cache_probe']);
  assert.equal(extractCommand('查看缓存').intent, 'cache_probe');
  assert.equal(extractCommand('average hit rate').intent, 'cache_probe');
  // Longer code-oriented cache talk should NOT force probe (leave to model/search).
  assert.notEqual(extractCommand('帮我实现一个缓存机制并搜索 cacheKey').intent, 'cache_probe');
});

test('extracts desktop and absolute docx paths for one-shot read', () => {
  const glued = extractCommand('C:\\Users\\34516\\Desktop\\测试.docx看');
  assert.equal(glued.intent, 'file_read');
  assert.equal(glued.confidence, 'high');
  assert.ok(glued.slots.path?.toLowerCase().includes('desktop'));
  assert.ok(glued.slots.path?.toLowerCase().endsWith('.docx'));
  assert.ok(!glued.slots.path?.includes('看'));

  const desktop = extractCommand('desktop/测试.docx');
  assert.equal(desktop.intent, 'file_read');
  assert.equal(desktop.slots.path?.replace(/\\/g, '/'), 'desktop/测试.docx');

  const plan = planCommand(glued);
  assert.equal(plan.mode, 'execute');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]?.tool, 'read_file');
});

test('plans direct execution only for high-confidence readonly tools', () => {
  const searchPlan = planCommand(extractCommand('搜索 apply_patch'));
  assert.equal(searchPlan.mode, 'execute');
  assert.ok(['find_symbol', 'search_text'].includes(searchPlan.steps[0]?.tool ?? ''));
  assert.ok(searchPlan.steps.some((step) => step.tool === 'search_text' || step.tool === 'find_symbol'));

  const editPlan = planCommand(extractCommand('帮我改登录按钮样式'));
  assert.equal(editPlan.mode, 'strategy');
  assert.deepEqual(editPlan.steps, []);
  assert.ok(editPlan.recommendedTools.includes('read_file'));

  const shellPlan = planCommand(extractCommand('运行 npm test'));
  assert.equal(shellPlan.mode, 'strategy');
  assert.deepEqual(shellPlan.steps, []);
});

test('formatCommandStrategy includes intent confidence and slots', () => {
  const extraction = extractCommand('读取 package.json');
  const plan = planCommand(extraction);
  const text = formatCommandStrategy(plan, extraction);
  assert.match(text, /intent=file_read/);
  assert.match(text, /confidence=high/);
  assert.match(text, /path:package\.json/);
});

test('high-confidence readonly prompt executes tools without calling provider', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cmd-extract-'));
  try {
    let providerCalls = 0;
    const provider: Provider = {
      name: 'openai',
      model: 'test',
      async complete(_request: ProviderRequest) {
        providerCalls += 1;
        return { actions: [{ type: 'message', content: 'provider should not run' }] };
      },
    };
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'test', workspaceRoot: workspace });
    const runtime: AgentRuntime = {
      config: {
        provider: 'openai',
        model: 'test',
        approval: 'auto',
        workspaceRoot: workspace,
        sessionDir: join(workspace, 'sessions'),
        maxSteps: 4,
        noBanner: true,
        confirmPlan: false,
      },
      provider,
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI({ quiet: true, noColor: true }),
    };

    await writeFile(join(workspace, 'package.json'), '{"name":"demo"}\n', 'utf8');
    const result = await runAgentTurn(runtime, '读取 package.json');
    assert.equal(result.ok, true);
    assert.equal(providerCalls, 0);
    assert.ok(runtime.session.toolCalls.some((call) => call.tool === 'read_file' && call.ok));
    // Single-step reads surface tool output; multi-step chains keep the meta summary.
    assert.match(result.finalAnswer ?? '', /high-confidence command chain|demo/i);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('strategy-only edit prompt still calls provider with strategy text', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cmd-strategy-'));
  try {
    let captured: ProviderRequest | undefined;
    const provider: Provider = {
      name: 'mock',
      model: 'test',
      async complete(request: ProviderRequest) {
        captured = request;
        return { actions: [{ type: 'message', content: 'model handled edit strategy' }] };
      },
    };
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'mock', model: 'test', workspaceRoot: workspace });
    const runtime: AgentRuntime = {
      config: {
        provider: 'mock',
        model: 'test',
        approval: 'auto',
        workspaceRoot: workspace,
        sessionDir: join(workspace, 'sessions'),
        maxSteps: 4,
        noBanner: true,
        confirmPlan: false,
      },
      provider,
      tools: createDefaultToolRegistry(),
      sessions,
      session,
      ui: new TerminalUI({ quiet: true, noColor: true }),
    };

    const result = await runAgentTurn(runtime, '帮我改登录按钮样式');
    assert.equal(result.ok, true);
    assert.ok(captured);
    assert.match(captured.toolStrategy ?? '', /intent=code_edit/);
    assert.match(captured.toolStrategy ?? '', /recommended=repo_map, ts_hover, ts_goto_definition, ts_exact_references, find_symbol, find_references, project_index, search_text, read_file/);
    assert.equal(runtime.session.toolCalls.length, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
