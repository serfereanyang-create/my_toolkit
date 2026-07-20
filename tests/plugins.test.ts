import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNoopHooks } from '../src/hooks/hooks.js';
import { loadPluginTools } from '../src/plugins/loader.js';
import { readPluginManifest } from '../src/plugins/manifest.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

test('plugin manifest loads read-only declared command tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-plugin-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  await writeFile(join(workspace, '.aicode', 'plugins.json'), JSON.stringify({ tools: [{ name: 'plugin_node_version', description: 'Show Node version', command: 'node --version' }] }));

  const manifest = await readPluginManifest(workspace);
  const tools = await loadPluginTools(workspace);

  assert.equal(manifest.tools?.[0]?.name, 'plugin_node_version');
  assert.equal(tools[0]?.name, 'plugin_node_version');
  assert.equal(tools[0]?.risk, 'shell');

  await rm(workspace, { recursive: true, force: true });
});

test('plugin tools execute through the registry and approval policy', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-plugin-run-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  await writeFile(join(workspace, '.aicode', 'plugins.json'), JSON.stringify({ tools: [{ name: 'plugin_node_version', description: 'Show Node version', command: 'node --version' }] }));
  const registry = createDefaultToolRegistry();
  for (const tool of await loadPluginTools(workspace)) registry.register(tool);

  const result = await registry.execute('plugin_node_version', {}, { workspaceRoot: workspace, approval: 'auto' });

  assert.equal(result.ok, true);
  assert.match(result.output, /^v\d+/);

  await rm(workspace, { recursive: true, force: true });
});

test('hook lifecycle receives before and after tool events', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-hooks-'));
  const registry = createDefaultToolRegistry();
  const events: string[] = [];
  const hooks = {
    ...createNoopHooks(),
    async beforeTool() {
      events.push('before');
    },
    async afterTool() {
      events.push('after');
    },
  };

  const result = await registry.execute('project_status', {}, { workspaceRoot: workspace, approval: 'auto', hooks });

  assert.equal(result.ok, true);
  assert.deepEqual(events, ['before', 'after']);

  await rm(workspace, { recursive: true, force: true });
});
