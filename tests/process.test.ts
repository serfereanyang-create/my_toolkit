import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockProvider } from '../src/providers/mock.js';
import { buildToolSystemPrompt } from '../src/providers/protocol.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('process_memory tool reports memory ranked processes', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-process-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('process_memory', { limit: 5 }, { workspaceRoot: workspace, approval: 'auto' });

  assert.equal(result.ok, true);
  assert.match(result.output, /name\tpid\tmemoryMB/);
  assert.ok((result.data as { processes?: unknown[] }).processes?.length);

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider uses process_memory for memory questions', async () => {
  const response = await createMockProvider().complete({
    messages: [{ role: 'user', content: '帮我查查现在谁占用内存高', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });

  assert.equal(response.actions[0]?.type, 'tool');
  if (response.actions[0]?.type === 'tool') assert.equal(response.actions[0].tool, 'process_memory');
});

test('tool system prompt tells models to prefer process_memory on this platform', () => {
  const prompt = buildToolSystemPrompt([{ name: 'process_memory', description: 'memory', inputHint: '{}', risk: 'read' }]);

  assert.match(prompt, /Runtime platform:/);
  assert.match(prompt, /use process_memory/);
});
