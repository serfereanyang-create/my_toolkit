import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMockProvider } from '../src/providers/mock.js';
import { buildToolSystemPrompt } from '../src/providers/protocol.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('environment_info tool reports runtime facts', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-env-'));
  const registry = createDefaultToolRegistry();
  const result = await registry.execute('environment_info', { includeVersions: true }, { workspaceRoot: workspace, approval: 'auto' });

  assert.equal(result.ok, true);
  assert.match(result.output, /platform:/);
  assert.match(result.output, /workspaceRoot:/);
  assert.match(result.output, /node:/);

  await rm(workspace, { recursive: true, force: true });
});

test('mock provider uses environment_info for environment questions', async () => {
  const response = await createMockProvider().complete({
    messages: [{ role: 'user', content: '你查查你所在的容器环境', createdAt: new Date().toISOString() }],
    tools: [],
    workspaceRoot: process.cwd(),
  });

  assert.equal(response.actions[0]?.type, 'tool');
  if (response.actions[0]?.type === 'tool') assert.equal(response.actions[0].tool, 'environment_info');
});

test('tool system prompt tells models to use environment_info for runtime questions', () => {
  const prompt = buildToolSystemPrompt([{ name: 'environment_info', description: 'environment', inputHint: '{}', risk: 'read' }]);

  assert.match(prompt, /environment_info/);
  assert.match(prompt, /environment\/container\/system identity/);
});
