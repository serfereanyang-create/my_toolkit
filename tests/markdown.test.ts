import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MarkdownStreamCleaner, stripMarkdownDecorations } from '../src/ui/markdown.js';
import { TerminalUI } from '../src/ui/terminal.js';

test('stripMarkdownDecorations removes bold and headings', () => {
  assert.equal(stripMarkdownDecorations('**粗体** 和 ## 标题'), '粗体 和 标题');
  assert.equal(stripMarkdownDecorations('## Hello\n**world**'), 'Hello\nworld');
  assert.equal(stripMarkdownDecorations('no markdown'), 'no markdown');
  assert.doesNotMatch(stripMarkdownDecorations('### 小节 **x**'), /\*\*|##/);
  const sample = [
    '## 一句话',
    '**现在是“能跑的 MVP”**',
    '### A. 测试覆盖层',
    '| 目标 | 完成度 |',
    '|---|---:|',
    '| demo | **70–80%** |',
  ].join('\n');
  const cleaned = stripMarkdownDecorations(sample);
  assert.doesNotMatch(cleaned, /\*\*/);
  assert.doesNotMatch(cleaned, /##/);
  assert.match(cleaned, /一句话/);
  assert.match(cleaned, /70–80%/);
});

test('MarkdownStreamCleaner strips across chunk boundaries', () => {
  const cleaner = new MarkdownStreamCleaner();
  const a = cleaner.push('这是 **重');
  const b = cleaner.push('点** 内容');
  const c = cleaner.flush();
  const joined = `${a}${b}${c}`;
  assert.match(joined, /这是 重点 内容/);
  assert.doesNotMatch(joined, /\*\*/);
});

test('TerminalUI assistant output drops markdown decorations', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const ui = new TerminalUI({ noColor: true });
    ui.assistant('## 结果\n**完成**了');
    assert.match(output, /结果/);
    assert.match(output, /完成了/);
    assert.doesNotMatch(output, /\*\*/);
    assert.doesNotMatch(output, /##/);
  } finally {
    process.stdout.write = originalWrite;
  }
});
