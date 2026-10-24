import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerminalUI } from '../src/ui/terminal.js';

function captureStdout(run: () => void) {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString();
    if (typeof encoding === 'function') encoding();
    if (callback) callback();
    return true;
  }) as typeof process.stdout.write;
  try {
    run();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}

// Codex TUI layout: `› ` user prefix, `• ` assistant/exec bullets,
// `  └ ` output block, no emoji, no OpenCode section headers.

test('TerminalUI lays out task assistant and tool output with clean no-color spacing', () => {
  const ui = new TerminalUI({ noColor: true, verbose: true });
  const output = captureStdout(() => {
    ui.turnStart('帮我检查最近的大文件');
    ui.assistant('先看磁盘增长。');
    ui.toolStart('disk_growth', { path: '.', hours: 48 });
    ui.toolResult('disk_growth', { ok: true, output: 'sizeMB\tpath\n120.4\tout/cache.bin' });
  });

  assert.match(output, /\n› 帮我检查最近的大文件\n/);
  assert.match(output, /\n• 先看磁盘增长。\n/);
  assert.match(output, /\n  • Tool 1 disk_growth \.\n/, 'exec row: bullet + indexed title + primary arg');
  assert.match(output, /\n  result: ✓ ok \d+ms\n  output:\n    sizeMB\tpath\n    120\.4\tout\/cache\.bin\n/);
  assert.doesNotMatch(output, /waiting for tool result/);
  assert.doesNotMatch(output, /Task|You ran/);
});

test('TerminalUI request chrome uses the › user prefix not a box', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => ui.turnStart('哈哈哈哈'));
  assert.match(output, /\n› 哈哈哈哈\n/);
  assert.doesNotMatch(output, /┌|└/);
  assert.doesNotMatch(output, /\* Task|\* You/);
});

test('TerminalUI folds tool process into bullet rows by default', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => {
    ui.toolStart('disk_info', { drive: 'C' });
    ui.toolResult('disk_info', {
      ok: true,
      output: 'name\tpath\tusedGB\tfreeGB\ttotalGB\nC:\tC:/\t224.77\t188.01\t412.79',
      data: { disks: [{ name: 'C:', path: 'C:/', usedGb: 224.77, freeGb: 188.01, totalGb: 412.79 }] },
    });
  });
  assert.match(output, /  • Running disk_info\n/);
  assert.match(output, /  • Ran disk_info/);
  assert.match(output, /\n  └ name\tpath\tusedGB\tfreeGB\ttotalGB\n/);
  assert.doesNotMatch(output, /\n  input:/);
});

test('TerminalUI caps tool output with the transcript hint', () => {
  const ui = new TerminalUI({ noColor: true });
  const lines = Array.from({ length: 9 }, (_, index) => `row ${index}`).join('\n');
  const output = captureStdout(() => {
    ui.toolResult('list_dir', { ok: true, output: lines });
  });
  const outputRows = output.split('\n').filter((line) => line.startsWith('  └ row'));
  assert.equal(outputRows.length, 5, 'exec_cell TOOL_CALL_MAX_LINES');
  assert.match(output, /└ … \+4 lines \(ctrl \+ t to view transcript\)/);
});

test('TerminalUI omits empty tool output blocks (verbose keeps result line)', () => {
  const ui = new TerminalUI({ noColor: true, verbose: true });
  const output = captureStdout(() => {
    ui.toolStart('git_status', {});
    ui.toolResult('git_status', { ok: true, output: '' });
  });

  assert.match(output, /  • Tool 1 git_status\n/);
  assert.match(output, /  result: ✓ ok \d+ms\n/);
  assert.doesNotMatch(output, /\n  output:\n/);
});

test('TerminalUI does not column-reflow long assistant lines', () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 40;
  try {
    const ui = new TerminalUI({ noColor: true });
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789中文中文';
    const output = captureStdout(() => ui.assistant(long));
    // Assistant body keeps one logical line behind the dim bullet prefix.
    assert.match(output, new RegExp(`• ${long}\\n`));
    const bodyLines = output.split(/\r?\n/).filter((line) => line === `• ${long}`);
    assert.equal(bodyLines.length, 1);
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('TerminalUI assistant body has no indent padding on the first row', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => ui.assistant('先看磁盘增长。'));
  assert.match(output, /• 先看磁盘增长。\n/);
  assert.doesNotMatch(output, /\n  先看磁盘增长。/);
});

test('TerminalUI colored mode uses the dim bullet without painting the body', () => {
  const ui = new TerminalUI({ noColor: false });
  const output = captureStdout(() => {
    ui.assistant('hello body');
  });
  // messages.rs AgentMarkdownCell: dim `• ` prefix, body uncolored.
  assert.match(output, /\u001b\[2m• \u001b\[0mhello body/);
  assert.match(output, /hello body/);
});

test('TerminalUI welcome block lists starter commands with dim descriptions', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => ui.welcomeCommands());
  assert.match(output, /To get started, describe a task or try one of these commands:/);
  assert.match(output, /\n  \/init - create AGENTS\.md workspace instructions\n/);
  assert.match(output, /\n  \/help - floating command palette\n/);
});

test('TerminalUI json mode streams thinking deltas with open/close lifecycle', () => {
  const ui = new TerminalUI({ json: true });
  const output = captureStdout(() => {
    ui.modelStart();
    ui.thinkingDelta('第一段思考');
    ui.thinkingDelta('，继续思考');
    ui.assistantDelta('回答');
    ui.modelEnd();
  });
  const events = output.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  const types = events.map((event) => event.type);
  assert.deepEqual(types, ['model_start', 'thinking_start', 'thinking_delta', 'thinking_delta', 'assistant_delta', 'thinking_end', 'model_end']);
  assert.equal(events[2].text, '第一段思考');
  assert.equal(events[3].text, '，继续思考');
  assert.equal(typeof (events[5] as { durationMs?: unknown }).durationMs, 'number');
});

test('TerminalUI json mode emits no thinking lifecycle when nothing was streamed', () => {
  const ui = new TerminalUI({ json: true });
  const output = captureStdout(() => {
    ui.modelStart();
    ui.assistantDelta('直接回答');
    ui.modelEnd();
  });
  const types = output.trim().split('\n').map((line) => JSON.parse(line) as { type: string }).map((event) => event.type);
  assert.deepEqual(types, ['model_start', 'assistant_delta', 'model_end']);
});

test('TerminalUI non-json mode ignores thinking deltas entirely', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => {
    ui.thinkingDelta('思考');
    ui.modelEnd();
  });
  assert.equal(output, '');
});

test('TerminalUI json mode forwards the reply markdown as written, fences included', () => {
  const markdown = '## 结论\n\n**改了** 三处。\n\n```ts\nconst verdict = analyzeCommand(command);\n```\n';
  const ui = new TerminalUI({ json: true });
  const output = captureStdout(() => {
    ui.assistantDelta('## 结论\n\n');
    ui.assistant(markdown);
  });
  const events = output.trim().split('\n').map((line) => JSON.parse(line) as { type: string; content?: string });
  const final = events.find((event) => event.type === 'assistant');
  assert.ok(final, JSON.stringify(events));
  // The desktop transcript renders markdown itself: stripping here used to
  // flatten every streamed code block into prose once the turn finished.
  assert.equal(final.content, markdown);
  assert.match(final.content ?? '', /```ts/);
  assert.match(final.content ?? '', /^## 结论$/m);
});

test('TerminalUI still strips decorations from what it prints to an ANSI terminal', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => ui.assistant('## 结论\n\n**改了** 三处。\n\n```ts\nconst x = 1;\n```\n'));
  assert.doesNotMatch(output, /\*\*|##|```/);
  assert.match(output, /结论/);
  assert.match(output, /const x = 1;/);
});
