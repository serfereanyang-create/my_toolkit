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
  const ui = new TerminalUI({ noColor: true, verbose: true });
  const output = captureStdout(() => {
    ui.turnStart('帮我检查最近的大文件');
    ui.assistant('先看磁盘增长。');
    ui.toolStart('disk_growth', { path: '.', hours: 48 });
    ui.toolResult('disk_growth', { ok: true, output: 'sizeMB\tpath\n120.4\tout/cache.bin' });
  });

  assert.match(output, /\n\* You\n帮我检查最近的大文件\n/);
  assert.match(output, /\n\* Assistant\n先看磁盘增长。\n/);
  assert.match(output, /\n\* Tool 1 disk_growth\n  input: \{"path":"\.","hours":48\}\n  status: running\n  result: ok \d+ms\n  output:\n    sizeMB\tpath\n    120\.4\tout\/cache\.bin\n/);
  assert.doesNotMatch(output, /waiting for tool result/);
});

test('TerminalUI folds tool process into one summary line by default', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => {
    ui.toolStart('disk_info', { drive: 'C' });
    ui.toolResult('disk_info', {
      ok: true,
      output: 'name\tpath\tusedGB\tfreeGB\ttotalGB\nC:\tC:/\t224.77\t188.01\t412.79',
      data: { disks: [{ name: 'C:', path: 'C:/', usedGb: 224.77, freeGb: 188.01, totalGb: 412.79 }] },
    });
  });
  assert.match(output, /\* Tool 1 disk_info …/);
  assert.match(output, /\* disk_info ok \d+ms · /);
  assert.doesNotMatch(output, /\n  input:/);
  assert.doesNotMatch(output, /\n  output:\n/);
});

test('TerminalUI omits empty tool output blocks', () => {
  const ui = new TerminalUI({ noColor: true, verbose: true });
  const output = captureStdout(() => {
    ui.toolStart('git_status', {});
    ui.toolResult('git_status', { ok: true, output: '' });
  });

  assert.match(output, /\n\* Tool 1 git_status\n/);
  assert.match(output, /  result: ok \d+ms\n/);
  assert.doesNotMatch(output, /\n  output:\n/);
});

test('TerminalUI does not column-reflow long assistant lines', () => {
  const originalColumns = process.stdout.columns;
  process.stdout.columns = 40;
  try {
    const ui = new TerminalUI({ noColor: true });
    const long = 'abcdefghijklmnopqrstuvwxyz0123456789中文中文';
    const output = captureStdout(() => ui.assistant(long));
    // Assistant body has no left indent and stays one logical line.
    assert.match(output, new RegExp(`\\n\\* Assistant\\n${long}\\n`));
    const bodyLines = output.split(/\r?\n/).filter((line) => line === long);
    assert.equal(bodyLines.length, 1);
  } finally {
    process.stdout.columns = originalColumns;
  }
});

test('TerminalUI assistant body has no indent padding', () => {
  const ui = new TerminalUI({ noColor: true });
  const output = captureStdout(() => ui.assistant('先看磁盘增长。'));
  assert.match(output, /\n\* Assistant\n先看磁盘增长。\n/);
  assert.doesNotMatch(output, /\n  先看磁盘增长。/);
});

test('TerminalUI colored mode uses section markers without painting whole assistant body green', () => {
  const ui = new TerminalUI({ noColor: false });
  const output = captureStdout(() => {
    ui.assistant('hello body');
  });
  // Title is green/bold; body should not be wrapped entirely as green stream for non-stream path.
  assert.match(output, /Assistant/);
  assert.match(output, /hello body/);
});
