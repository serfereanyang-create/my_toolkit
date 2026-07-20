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

test('TerminalUI lays out task assistant and tool output with clean no-color spacing', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => {
    ui.turnStart('帮我检查最近的大文件');
    ui.assistant('先看磁盘增长。');
    ui.toolStart('disk_growth', { path: '.', hours: 48 });
    ui.toolResult('disk_growth', { ok: true, output: 'sizeMB\tpath\n120.4\tout/cache.bin' });
  });

  assert.match(output, /\nTask\n  帮我检查最近的大文件\n/);
  assert.match(output, /\nAssistant\n  先看磁盘增长。\n/);
  assert.match(output, /\nTool 1 disk_growth\n  input: \{"path":"\.","hours":48\}\n  status: running\n  result: ok \d+ms\n  output:\n    sizeMB\tpath\n    120\.4\tout\/cache\.bin\n/);
  assert.doesNotMatch(output, /[▶●⏳✓✗│]/);
  assert.doesNotMatch(output, /waiting for tool result/);
});

test('TerminalUI omits empty tool output blocks', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => {
    ui.toolStart('git_status', {});
    ui.toolResult('git_status', { ok: true, output: '' });
  });

  assert.match(output, /\nTool 1 git_status\n/);
  assert.match(output, /  result: ok \d+ms\n/);
  assert.doesNotMatch(output, /\n  output:\n/);
});

test('TerminalUI wraps long lines instead of emitting one oversized row', () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 40;
  try {
    const ui = new TerminalUI({ noColor: true });
    const output = captureStdout(() => ui.assistant('abcdefghijklmnopqrstuvwxyz0123456789中文中文'));
    const assistantLines = output.split(/\r?\n/).filter((line) => line.startsWith('  '));

    assert.ok(assistantLines.length > 1);
    assert.ok(assistantLines.every((line) => line.length <= 42));
  } finally {
    process.stdout.columns = originalColumns;
  }
});
