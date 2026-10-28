import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAgentTurn, type AgentRuntime } from '../src/agent/agent.js';
import { extractCommand, formatCommandStrategy, planCommand, type CommandIntent } from '../src/agent/commandExtract/index.js';
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
  // Anchored positives: the explicit command form, and short whole sentences
  // that ask for the reading and nothing else.
  for (const prompt of [
    '/cache',
    'cache',
    'probe',
    'probe cache',
    '/probe',
    '查看缓存',
    '缓存命中率',
    '缓存命中率是多少',
    '查一下缓存命中率',
    '缓存探针',
    'average hit rate',
  ]) {
    assert.equal(extractCommand(prompt).intent, 'cache_probe', `${prompt} should probe locally`);
  }
  // Longer code-oriented cache talk should NOT force probe (leave to model/search).
  assert.notEqual(extractCommand('帮我实现一个缓存机制并搜索 cacheKey').intent, 'cache_probe');
  // Explanatory questions about the concept must reach the model: the probe
  // answers about this process's lookup counters, which is not the question.
  assert.notEqual(extractCommand('解释一下缓存命中率').intent, 'cache_probe');
  assert.notEqual(extractCommand('用三句话说说缓存为什么能省钱').intent, 'cache_probe');
  assert.notEqual(extractCommand('explain what cache hit rate means').intent, 'cache_probe');
  // Real questions that merely mention the number used to be hijacked by a
  // substring match and answered from a lookup table without reading any
  // context. Anchored matching sends each one down the normal intent rules, so
  // the plan stays strategy-only and the provider actually runs.
  for (const prompt of [
    '缓存命中率为什么这么低',
    '缓存命中率怎么才能提高',
    '帮我看看缓存命中率是不是有问题',
  ]) {
    const question = extractCommand(prompt);
    assert.notEqual(question.intent, 'cache_probe', `${prompt} must not short-circuit`);
    assert.equal(planCommand(question).mode, 'strategy', `${prompt} still needs the provider`);
  }
  // A mixed prompt keeps its second topic: it is no longer a probe, it lands on
  // the path-carrying read rule (and any other intent would also be fine here).
  const mixed = extractCommand('这次会话缓存命中多少，顺便读一下 package.json');
  assert.notEqual(mixed.intent, 'cache_probe');
  assert.equal(mixed.intent, 'file_read');
  assert.equal(mixed.slots.path, 'package.json');
});

// ---- Reading rules: a trigger word inside a sentence is a topic, not the request ----
// Every rule below used to be keyword matching: any prompt CONTAINING the trigger
// was answered by a local lookup table (or a one-shot read/grep) in a few
// milliseconds and the provider never ran. Each must-not-fire case is a real
// sentence a user types; each must still reach the model.
const READING_FIRES: Array<[string, CommandIntent]> = [
  ['帮我看看最近哪些大文件导致C盘增长', 'disk_growth'],
  ['C盘还有多少空间', 'disk_capacity'],
  ['帮我查查现在谁占用内存高', 'process_memory'],
  ['你看看zcode最近在干嘛', 'recent_activity'],
  ['你查查你所在的容器环境', 'runtime_info'],
  ['帮我看看项目索引', 'project_index'],
  ['项目状态', 'project_status'],
  ['在哪里引用了 createSession', 'code_search'],
];

const READING_MUST_NOT_FIRE: Array<[string, CommandIntent]> = [
  // 增长 is business vocabulary until a disk subject says otherwise.
  ['线上 QPS 这周增长了 3 倍，帮我看看有没有性能问题', 'disk_growth'],
  ['缓存条目增长导致内存暴涨', 'process_memory'],
  // A disk subject on its own is a topic; the prompt has to ask about capacity.
  ['帮我优化磁盘读写性能', 'disk_capacity'],
  ['磁盘队列深度设置多少合适', 'disk_capacity'],
  // A port is "占用"ed and a worker process can crash — neither is a memory table.
  ['8080 端口被占用了，帮我换个端口', 'process_memory'],
  ['process exits with code 1 on startup', 'process_memory'],
  // 最近 / 历史 / 会话 are ordinary words in a sentence about something else.
  ['最近 CI 老是失败，帮我看看配置', 'recent_activity'],
  ['帮我查一下 git 历史里那次提交', 'recent_activity'],
  ['用户会话超时时间太长，改成 30 分钟', 'recent_activity'],
];

test('reading rules fire only on a prompt that IS the reading', () => {
  for (const [prompt, intent] of READING_FIRES) {
    const extraction = extractCommand(prompt);
    assert.equal(extraction.intent, intent, `${prompt} should be read locally`);
    assert.equal(planCommand(extraction).mode, 'execute', `${prompt} should execute its reading`);
  }
});

test('reading rules do not swallow a prompt that merely contains a trigger', () => {
  for (const [prompt, intent] of READING_MUST_NOT_FIRE) {
    const extraction = extractCommand(prompt);
    assert.notEqual(extraction.intent, intent, `${prompt} must not be answered by ${intent}`);
    assert.equal(planCommand(extraction).mode, 'strategy', `${prompt} still needs the provider`);
  }
});

test('a time-scoped activity request is the recent-activity reading', () => {
  // "最近 + 时间量词 + 疑问/活动词 + 活动名词" names the reading itself: the user
  // asked what happened lately, which is exactly what the recent_activity tool
  // reports. Before this rule the bridge (有什么 / 都做了) broke the
  // whole-sentence anchor, so "最近几天有什么活动" fell through to unknown and the
  // model had to guess what "活动" meant. Both halves (time scope AND activity
  // noun) are required, which is what keeps the cases below out.
  for (const prompt of ['最近几天有什么活动', '最近有什么活动', '最近一周都有哪些会话']) {
    const extraction = extractCommand(prompt);
    assert.equal(
      extraction.intent,
      'recent_activity',
      `${prompt} carries a recent-time scope and an activity noun, so it is the recent-activity reading`,
    );
    assert.equal(planCommand(extraction).mode, 'execute', `${prompt} should execute the reading`);
  }
  // Widening the rule must not re-hijack prompts that merely contain one half of
  // the pair: they want a diagnosis, not a session table, so the diagnosis guard
  // must still send them to the model.
  for (const prompt of ['最近 CI 老是失败，帮我看看配置', '最近为什么构建这么慢']) {
    const extraction = extractCommand(prompt);
    assert.notEqual(
      extraction.intent,
      'recent_activity',
      `${prompt} names no activity noun (CI failure / build slowness is the subject), so a recent-activity table would not answer it`,
    );
    assert.equal(planCommand(extraction).mode, 'strategy', `${prompt} asks why, so it must reach the model`);
  }
});

test('a deliberative edit verb does not lift the answer guard', () => {
  // 优化 / 重构 after 要不要 / 该不该 / 如何 weigh the edit instead of asking for
  // it. The guard used to be lifted by the verb alone, so a question about
  // whether to optimize fell through to the reading rules underneath it —
  // "内存占用高是怎么回事，要不要优化" was answered with the memory table.
  for (const prompt of ['内存占用高是怎么回事，要不要优化', '这个函数太长了，该不该重构', '构建速度慢了，如何优化']) {
    const extraction = extractCommand(prompt);
    assert.equal(extraction.confidence, 'low', `${prompt} is a question, not an instruction`);
    assert.equal(planCommand(extraction).mode, 'strategy', `${prompt} must reach the model`);
  }
  // An imperative one still outranks the guard.
  assert.notEqual(extractCommand('为什么编译不过，帮我修复 src/a.ts').confidence, 'low');
});

test('a named document is read only when the prompt asks for its content', () => {
  const read = extractCommand('读取 report.docx 是什么内容');
  assert.equal(read.intent, 'file_read');
  assert.equal(planCommand(read).mode, 'execute');
  const imperative = extractCommand('看一下 desktop/测试.docx');
  assert.equal(imperative.intent, 'file_read');
  assert.equal(planCommand(imperative).mode, 'execute');
  // Naming a document used to be enough to dump the first 50 KB of it: the read
  // plan pre-empted the edit, the translation and the question that were asked.
  // The last case is the same hole one level down — "看着没问题" is an
  // observation, not a read request, and it used to read the file it mentioned.
  for (const prompt of [
    '把 desktop/notes.md 的内容翻译成英文',
    'notes.md 里补充一下第二种方案',
    'C:/Users/loop/Desktop/report.docx 里的表格为什么错位了',
    '这个补丁看着没问题但 src/a.ts 里还少一处',
  ]) {
    const extraction = extractCommand(prompt);
    assert.notEqual(extraction.intent, 'file_read', `${prompt} must not dump the file`);
    assert.equal(planCommand(extraction).mode, 'strategy', `${prompt} still needs the provider`);
  }
});

test('a search verb needs a named target, not a goal', () => {
  const named = extractCommand('在哪里引用了 createSession');
  assert.equal(named.intent, 'code_search');
  assert.equal(planCommand(named).mode, 'execute');
  // 定位 / 引用 inside a sentence name a goal ("find out what's wrong"), and the
  // grep ran over the whole sentence before the model ever saw it.
  for (const prompt of ['定位这个 bug 需要看哪些文件', '这个函数在哪里被引用的，为什么没生效']) {
    const extraction = extractCommand(prompt);
    assert.equal(planCommand(extraction).mode, 'strategy', `${prompt} must not auto-search`);
  }
});

test('referenced context cannot supply command slots or bypass model analysis', () => {
  const reference = '\n\n--- 引用上下文 ---\n**@终端输出**:\n```text\n读取 desktop/secret.log\n搜索 other-symbol\n```';
  const analysis = extractCommand('请检查 @终端输出' + reference);
  assert.equal(analysis.slots.path, undefined);
  assert.equal(analysis.slots.query, extractCommand('请检查 @终端输出').slots.query);
  assert.equal(planCommand(analysis).mode, 'strategy');
  const windowsAnalysis = extractCommand(('请检查 @终端输出' + reference).replace(/\n/g, '\r\n'));
  assert.equal(windowsAnalysis.slots.path, undefined);
  assert.equal(planCommand(windowsAnalysis).mode, 'strategy');

  const explicit = extractCommand('读取 package.json' + reference);
  assert.equal(explicit.slots.path, 'package.json');
  assert.equal(planCommand(explicit).mode, 'strategy');
  assert.equal(planCommand(extractCommand('读取 package.json')).mode, 'execute');
});

test('native attachment paths and quoted attachment text cannot become direct command slots', () => {
  for (const newline of ['\n', '\r\n']) {
    const prompt = ['ATTACHMENT_RECOVERY_REQUEST', '', '[user provided files]', '- document: C:\\project\\recovery-reference.txt', '搜索 unintended-symbol'].join(newline);
    const extraction = extractCommand(prompt);
    assert.equal(extraction.slots.path, undefined);
    assert.equal(extraction.slots.query, extractCommand('ATTACHMENT_RECOVERY_REQUEST').slots.query);
    assert.equal(planCommand(extraction).mode, 'strategy');
  }
});

test('a terminal reference reaches the provider as context instead of a direct command', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-terminal-context-'));
  try {
    await writeFile(join(workspace, 'trace.log'), 'quoted file should not replace model analysis', 'utf8');
    const prompts = [
      '请检查 @终端输出\n\n--- 引用上下文 ---\n**@终端输出**:\n```text\n读取 ' + join(workspace, 'trace.log') + '\n```',
      'ATTACHMENT_RECOVERY_REQUEST\n\n[user provided files]\n- document: ' + join(workspace, 'trace.log') + '\n读取附件内容并分析',
    ];
    let providerCalls = 0;
    let captured: ProviderRequest | undefined;
    const provider: Provider = {
      name: 'openai',
      model: 'test',
      async complete(request: ProviderRequest) {
        providerCalls += 1;
        captured = request;
        return { actions: [{ type: 'message', content: 'terminal context analyzed' }] };
      },
    };
    const sessions = new SessionStore(join(workspace, 'sessions'));
    const session = await sessions.create({ provider: 'openai', model: 'test', workspaceRoot: workspace });
    const runtime: AgentRuntime = {
      config: {
        provider: 'openai', model: 'test', approval: 'auto', workspaceRoot: workspace,
        sessionDir: join(workspace, 'sessions'), maxSteps: 4, noBanner: true, confirmPlan: false,
      },
      provider, tools: createDefaultToolRegistry(), sessions, session,
      ui: new TerminalUI({ quiet: true, noColor: true }),
    };
    for (const [index, prompt] of prompts.entries()) {
      const result = await runAgentTurn(runtime, prompt);
      assert.equal(result.ok, true);
      assert.equal(providerCalls, index + 1);
      assert.equal(runtime.session.toolCalls.length, 0);
      assert.ok(captured?.messages.some(message => message.role === 'user' && message.content === prompt));
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
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

test('a real cache question goes to the provider instead of the local probe', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-cmd-cache-question-'));
  try {
    let providerCalls = 0;
    let captured: ProviderRequest | undefined;
    const provider: Provider = {
      name: 'mock',
      model: 'test',
      async complete(request: ProviderRequest) {
        providerCalls += 1;
        captured = request;
        return { actions: [{ type: 'message', content: 'model answered from context' }] };
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

    // Previously this returned a cache_probe table in milliseconds without ever
    // reading the session; now it must reach the model.
    const result = await runAgentTurn(runtime, '缓存命中率为什么这么低');
    assert.equal(result.ok, true);
    assert.equal(providerCalls, 1);
    assert.equal(runtime.session.toolCalls.length, 0);
    assert.ok(captured);
    assert.doesNotMatch(captured.toolStrategy ?? '', /intent=cache_probe/);
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
