import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockProvider } from '../src/providers/mock.js';
import { buildToolSystemPrompt } from '../src/providers/protocol.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('disk_info reports disk capacity', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-disk-'));
  const result = await createDefaultToolRegistry().execute('disk_info', { drive: process.platform === 'win32' ? 'C' : '/' }, { workspaceRoot: workspace, approval: 'auto' });

  assert.equal(result.ok, true);
  assert.match(result.output, /name\tpath\tusedGB\tfreeGB\ttotalGB/);
  assert.ok((result.data as { disks?: unknown[] }).disks?.length);

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider uses disk_info for disk capacity questions', async () => {
  const response = await createMockProvider().complete({
    messages: [{ role: 'user', content: '你帮我看看C盘现在多大', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });

  assert.deepEqual(response.actions[0], { type: 'tool', tool: 'disk_info', input: { drive: 'C' } });
});

test('tool system prompt tells models to use disk_info for disk questions', () => {
  const prompt = buildToolSystemPrompt([{ name: 'disk_info', description: 'disk', inputHint: '{}', risk: 'read' }]);

  assert.match(prompt, /disk_info/);
  assert.match(prompt, /disk capacity\/free-space/);
});
