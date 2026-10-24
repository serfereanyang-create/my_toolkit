'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const {
  formatSessionMarkdown,
  exportSessionToFile,
  defaultExportPath,
  fenced,
} = require('../electron/export-session.cjs');

test('fenced doubles the fence when content contains ```', () => {
  assert.equal(fenced('plain'), '```\nplain\n```');
  assert.ok(fenced('has ``` inside').startsWith('````\n'));
});

test('fenced outgrows the longest backtick run in the payload', () => {
  // A run of four (or more) used to close the block early even though the
  // document opened with four, so the rest of the payload became live markdown.
  assert.ok(fenced('````').startsWith('`````\n'));
  assert.ok(fenced('a `````` b').startsWith('```````\n'));
  assert.ok(fenced('x ` y').startsWith('```\n'));

  const payload = 'docs say use ```` for nesting\n````\n<img src=x onerror=alert(1)>\n````';
  const block = fenced(payload);
  const opening = block.split('\n')[0];
  // No line of the payload may be usable as the closing fence.
  const fenceLike = payload.match(/^`{3,}\s*$/gm) ?? [];
  assert.deepEqual(fenceLike.filter((line) => line.trim().length >= opening.length), []);
  assert.ok(block.endsWith(`\n${opening}`));
  assert.ok(block.slice(opening.length + 1, -(opening.length + 1)) === payload);

  const markdown = formatSessionMarkdown({
    id: 's',
    messages: [{ role: 'tool', name: 'read_file', content: payload }],
  }).markdown;
  assert.ok(markdown.includes(block), 'the exported document keeps the payload in one block');
});

test('formatSessionMarkdown renders roles and records unsupported kinds', () => {
  const record = {
    id: 'sess_x',
    provider: 'p1',
    model: 'm1',
    createdAt: Date.UTC(2026, 8, 24),
    messages: [
      { role: 'user', content: '帮我看看这个文件' },
      { role: 'assistant', content: '好的' },
      { role: 'tool', name: 'read_file', content: 'file body' },
      { role: 'system', content: 'should be recorded' },
      null,
    ],
  };
  const result = formatSessionMarkdown(record);
  assert.ok(result.markdown.startsWith('# Conversation: sess_x'));
  assert.ok(result.markdown.includes('## User\n\n帮我看看这个文件'));
  assert.ok(result.markdown.includes('## Assistant\n\n好的'));
  assert.ok(result.markdown.includes('## Tool: read_file'));
  assert.ok(result.markdown.includes('- Provider: p1'));
  assert.deepEqual(result.unsupportedKinds, ['system', 'unknown']);
  assert.equal(result.messageCount, 4);
  assert.match(result.markdownSha256, /^[0-9a-f]{64}$/);
  // Deterministic: same input → same hash.
  assert.equal(formatSessionMarkdown(record).markdownSha256, result.markdownSha256);
});

test('tool output containing triple backticks gets a taller fence', () => {
  const result = formatSessionMarkdown({
    id: 's',
    messages: [{ role: 'tool', name: 't', content: 'code:\n```js\nx()\n```' }],
  });
  assert.ok(result.markdown.includes('````\ncode:'));
});

test('exportSessionToFile writes the document atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'export-'));
  try {
    const out = join(dir, 'sub', 'sess_x.md');
    const result = await exportSessionToFile(
      { id: 'sess_x', messages: [{ role: 'user', content: 'hi' }] },
      out,
    );
    const written = await readFile(out, 'utf-8');
    assert.equal(written, result.markdown);
    assert.ok(written.includes('## User\n\nhi'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultExportPath prefers the workspace and falls back to tmp', () => {
  assert.match(defaultExportPath('C:\\w', 'sess_1'), /C:\\w\\\.aicode\\exports\\sess_1\.md$/);
  assert.match(defaultExportPath(null, 'sess_1'), /yoycode-exports\\sess_1\.md$/);
});
