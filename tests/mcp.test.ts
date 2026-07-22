import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { mcpToolName, riskForTool } from '../src/mcp/bridge.js';
import { isMcpDisabled, normalizeMcpConfig, readMcpConfig } from '../src/mcp/config.js';
import { encodeMcpMessage, McpFrameReader } from '../src/mcp/framing.js';
import { formatMcpStatus, loadMcpManager } from '../src/mcp/manager.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';

const fixtureServer = await resolveFixtureServer();

async function resolveFixtureServer() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'fixtures', 'mcp-echo-server.mjs'),
    join(here, '..', 'tests', 'fixtures', 'mcp-echo-server.mjs'),
    join(here, '..', '..', 'tests', 'fixtures', 'mcp-echo-server.mjs'),
    resolve(process.cwd(), 'tests', 'fixtures', 'mcp-echo-server.mjs'),
  ];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) return candidate;
  }
  throw new Error(`mcp-echo-server fixture not found; tried ${candidates.join(', ')}`);
}

test('MCP Content-Length framing round-trips messages', () => {
  const message = { jsonrpc: '2.0' as const, id: 1, result: { ok: true } };
  const encoded = encodeMcpMessage(message);
  const reader = new McpFrameReader();
  const first = reader.push(encoded.subarray(0, 12));
  assert.equal(first.length, 0);
  const second = reader.push(encoded.subarray(12));
  assert.deepEqual(second, [message]);
});

test('MCP config normalizes server map and rejects bad names', async () => {
  const normalized = normalizeMcpConfig({
    servers: {
      demo: { command: 'node', args: ['a.mjs'], env: { X: '1' } },
      off: { command: 'node', enabled: false },
    },
  });
  assert.equal(normalized.servers.length, 2);
  assert.equal(normalized.servers[0]?.name, 'demo');
  assert.equal(normalized.servers[0]?.enabled, true);
  assert.equal(normalized.servers[1]?.enabled, false);

  assert.throws(() => normalizeMcpConfig({ servers: { 'bad name': { command: 'node' } } }), /invalid MCP server name/);
  assert.equal(isMcpDisabled({ AICODE_MCP: '0' }), true);
  assert.equal(isMcpDisabled({}), false);

  const workspace = await mkdtemp(join(tmpdir(), 'aicode-mcp-cfg-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  await writeFile(join(workspace, '.aicode', 'mcp.json'), JSON.stringify({
    servers: { echo: { command: 'node', args: [fixtureServer] } },
  }));
  const loaded = await readMcpConfig(workspace);
  assert.equal(loaded.servers[0]?.name, 'echo');
  await rm(workspace, { recursive: true, force: true });
});

test('MCP tool name and risk mapping', () => {
  assert.equal(mcpToolName('demo', 'echo-text'), 'mcp_demo_echo_text');
  assert.equal(riskForTool({ name: 'a', annotations: { readOnlyHint: true } }), 'read');
  assert.equal(riskForTool({ name: 'b', annotations: { destructiveHint: true } }), 'write');
  assert.equal(riskForTool({ name: 'c' }), 'shell');
});

test('MCP manager connects stdio echo server and executes bridged tools', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-mcp-run-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  await writeFile(join(workspace, '.aicode', 'mcp.json'), JSON.stringify({
    servers: {
      echo: {
        command: process.execPath,
        args: [fixtureServer],
      },
    },
  }));

  const manager = await loadMcpManager({ workspaceRoot: workspace });
  try {
    assert.equal(manager.statuses[0]?.connected, true);
    assert.ok(manager.tools.some((tool) => tool.name === 'mcp_echo_echo'));
    assert.ok(manager.tools.some((tool) => tool.name === 'mcp_echo_fail'));

    const registry = createDefaultToolRegistry();
    for (const tool of manager.tools) registry.register(tool);

    const ok = await registry.execute('mcp_echo_echo', { text: 'hi' }, { workspaceRoot: workspace, approval: 'auto' });
    assert.equal(ok.ok, true);
    assert.match(ok.output, /echo:hi/);
    assert.equal(registry.get('mcp_echo_echo')?.risk, 'read');
    assert.equal(registry.get('mcp_echo_fail')?.risk, 'write');

    // Destructive MCP tools stay gated under approval policy; use ask+confirm for a real call.
    const fail = await registry.execute('mcp_echo_fail', {}, {
      workspaceRoot: workspace,
      approval: 'ask',
      confirm: async () => true,
    });
    assert.equal(fail.ok, false);
    assert.match(fail.output, /intentional failure/);

    const denied = await registry.execute('mcp_echo_fail', {}, { workspaceRoot: workspace, approval: 'deny' });
    assert.equal(denied.ok, false);
    assert.match(denied.output, /blocked/i);

    const autoBlocked = await registry.execute('mcp_echo_fail', {}, { workspaceRoot: workspace, approval: 'auto' });
    assert.equal(autoBlocked.ok, false);
    assert.match(autoBlocked.output, /blocked/i);

    assert.match(formatMcpStatus(manager.statuses), /echo: connected/);
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});

test('MCP manager respects AICODE_MCP=0 and missing config', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-mcp-off-'));
  const disabled = await loadMcpManager({ workspaceRoot: workspace, env: { ...process.env, AICODE_MCP: '0' } });
  assert.equal(disabled.tools.length, 0);
  assert.equal(disabled.statuses.length, 0);

  const empty = await loadMcpManager({ workspaceRoot: workspace, env: { ...process.env, AICODE_MCP: '1' } });
  assert.equal(empty.tools.length, 0);
  assert.match(formatMcpStatus(empty.statuses), /no servers configured/);
  await rm(workspace, { recursive: true, force: true });
});

test('MCP manager isolates a failing server without aborting others', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-mcp-partial-'));
  await mkdir(join(workspace, '.aicode'), { recursive: true });
  await writeFile(join(workspace, '.aicode', 'mcp.json'), JSON.stringify({
    servers: {
      broken: { command: process.execPath, args: ['-e', 'process.exit(1)'] },
      echo: { command: process.execPath, args: [fixtureServer] },
    },
  }));

  const manager = await loadMcpManager({ workspaceRoot: workspace });
  try {
    const byName = new Map(manager.statuses.map((status) => [status.name, status]));
    assert.equal(byName.get('echo')?.connected, true);
    assert.equal(byName.get('broken')?.connected, false);
    assert.ok(manager.tools.some((tool) => tool.name.startsWith('mcp_echo_')));
  } finally {
    await manager.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
