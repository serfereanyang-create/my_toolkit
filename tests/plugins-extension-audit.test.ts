import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadPluginTools } from '../src/plugins/loader.js';
import { readPluginManifest } from '../src/plugins/manifest.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

async function workspaceWith(manifest: unknown) {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-plugin-audit-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  await writeFile(join(workspace, '.aicode', 'plugins.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  return workspace;
}

test('a plugin manifest cannot declare a read-risk command tool', async () => {
  const workspace = await workspaceWith({
    tools: [{ name: 'plugin_err_read', description: 'claims read', command: 'echo hi', risk: 'read' }],
  });
  try {
    const [tool] = await loadPluginTools(workspace);
    assert.equal(tool?.risk, 'shell', 'a command tool must never be registered as read');
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a plugin claiming read cannot write during deny mode', async () => {
  const marker = `deny-proof-${process.pid}.txt`;
  const workspace = await workspaceWith({
    tools: [{
      name: 'plugin_sneaky_write',
      description: 'writes while claiming read',
      command: `node -e "require('fs').writeFileSync('${marker}','x')"`,
      risk: 'read',
    }],
  });
  try {
    const registry = createDefaultToolRegistry();
    for (const tool of await loadPluginTools(workspace)) registry.register(tool);
    const result = await registry.execute('plugin_sneaky_write', {}, { workspaceRoot: workspace, approval: 'deny' });
    assert.equal(result.ok, false);
    assert.match(result.output, /blocked/i);
    await assert.rejects(readFile(join(workspace, marker)));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('duplicate plugin names no longer abort runtime startup', async () => {
  const workspace = await workspaceWith({
    tools: [
      { name: 'plugin_dup', description: 'first', command: 'echo first' },
      { name: 'plugin_dup', description: 'second', command: 'echo second' },
    ],
  });
  try {
    const manifest = await readPluginManifest(workspace);
    assert.equal(manifest.tools?.length, 1);
    assert.equal(manifest.tools?.[0]?.description, 'first', 'first declaration wins deterministically');
    const registry = createDefaultToolRegistry();
    // This is exactly what createAgentRuntime does; it used to throw and take
    // the whole CLI down with it.
    for (const tool of await loadPluginTools(workspace)) registry.register(tool);
    assert.match(registry.get('plugin_dup')?.description ?? '', /first/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('randomized manifest table: only sane declarations survive normalization', async () => {
  const seed = 0x51ee7;
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const risks = ['read', 'write', 'shell', undefined, 'network', 7];
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-plugin-fuzz-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  try {
    for (let index = 0; index < 120; index += 1) {
      const risk = risks[Math.floor(rand() * risks.length)];
      const name = rand() > 0.15 ? `plugin_case_${index}` : `bad name ${index}`;
      const entry: Record<string, unknown> = { name, description: `d${index}`, command: 'echo x' };
      if (risk !== undefined) entry.risk = risk;
      const manifest = { tools: [entry, { name: `plugin_case_${index}`, description: 'duplicate', command: 'echo y' }, 'garbage', null] };
      await writeFile(join(workspace, '.aicode', 'plugins.json'), JSON.stringify(manifest));
      try {
        const tools = await loadPluginTools(workspace);
        const names = tools.map((tool) => tool.name);
        assert.equal(new Set(names).size, names.length, `seed=${seed} case=${index}: duplicate names leaked through`);
        for (const tool of tools) {
                assert.match(tool.name, /^plugin_[a-z0-9_]+$/i, `seed=${seed} case=${index}`);
          assert.notEqual(tool.risk, 'read', `seed=${seed} case=${index}: risk=${String(risk)}`);
          assert.ok(tool.risk === 'write' || tool.risk === 'shell', `seed=${seed} case=${index}: risk=${String(tool.risk)}`);
        }
      } catch (error) {
        console.error(`seed=${seed} case=${index} risk=${String(risk)} name=${name}`);
        throw error;
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
