import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockProvider } from '../src/providers/mock.js';
import { buildToolSystemPrompt } from '../src/providers/protocol.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('disk_growth reports recent large files in a bounded path', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-growth-'));
  // Deliberately not `out/`: build-output names are skipped by the shared
  // walker policy (`src/workspace/ignored.ts`), and this test is about finding a
  // large file, not about which directories are searched.
  await mkdir(join(workspace, 'data'), { recursive: true });
  await writeFile(join(workspace, 'data', 'large.bin'), Buffer.alloc(2 * 1024 * 1024));

  const result = await createDefaultToolRegistry().execute('disk_growth', { path: '.', hours: 48, minMb: 1, maxFiles: 10 }, { workspaceRoot: workspace, approval: 'auto' });

  assert.equal(result.ok, true);
  assert.match(result.output, /sizeMB\tmodifiedAt\tpath/);
  assert.match(result.output, /large\.bin/);

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider uses disk_growth for recent large file questions', async () => {
  const response = await createMockProvider().complete({
    messages: [{ role: 'user', content: '帮我看看最近哪些大文件导致C盘增长', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });

  assert.deepEqual(response.actions[0], {
    type: 'tool',
    tool: 'disk_growth',
    input: { path: '.', hours: 48, minMb: 16, maxFiles: 30 },
  });
  assert.equal(response.actions.filter((action) => action.type === 'tool').length, 1);
});

test('tool system prompt tells models to use disk_growth for disk growth questions', () => {
  const prompt = buildToolSystemPrompt([{ name: 'disk_growth', description: 'growth', inputHint: '{}', risk: 'read' }]);

  assert.match(prompt, /disk_growth/);
  assert.match(prompt, /disk growth\/recent large files/);
});
