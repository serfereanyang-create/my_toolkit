import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bridgeMcpTools, governanceForTool, mcpToolName, MCP_TOOL_NAME_MAX, validateMcpInput } from '../src/mcp/bridge.js';
import type { McpClient } from '../src/mcp/client.js';
import { loadMcpManager } from '../src/mcp/manager.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import type { McpToolDescriptor } from '../src/mcp/types.js';

// The fixture is a .mjs file and is not emitted next to the compiled tests;
// resolve it from the source tree the same way tests/mcp.test.ts does.
const fixtureServer = [
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'mcp-echo-server.mjs'),
  join(process.cwd(), 'tests', 'fixtures', 'mcp-echo-server.mjs'),
].find((candidate) => existsSync(candidate));
if (!fixtureServer) throw new Error('mcp-echo-server fixture not found');

/** mulberry32: deterministic PRNG so a failure can be replayed from its seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fakeClient(tools: McpToolDescriptor[], calls: Array<{ name: string; args: Record<string, unknown> }>): McpClient {
  return {
    name: 'fake',
    getTools: () => tools,
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `ran ${name}` }] };
    },
  } as unknown as McpClient;
}

test('external MCP annotations can never grant read-risk approval', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const tools: McpToolDescriptor[] = [
    { name: 'writes_files', annotations: { readOnlyHint: true } },
    { name: 'destroys_everything', annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: 'unannotated' },
  ];
  const registry = createDefaultToolRegistry();
  for (const tool of bridgeMcpTools(fakeClient(tools, calls))) registry.register(tool);

  const workspace = await mkdtemp(join(tmpdir(), 'aicode-mcp-risk-'));
  try {
    for (const name of ['mcp_fake_writes_files', 'mcp_fake_destroys_everything', 'mcp_fake_unannotated']) {
      const def = registry.get(name);
      assert.ok(def, `${name} should be registered`);
      assert.notEqual(def.risk, 'read', `${name} must never be registered as read`);
      assert.equal((await registry.execute(name, {}, { workspaceRoot: workspace, approval: 'deny' })).ok, false, `${name} must be refused in deny mode`);
      assert.equal((await registry.execute(name, {}, { workspaceRoot: workspace, approval: 'ask' })).ok, false, `${name} must prompt (and refuse without a handler) in ask mode`);
      assert.equal((await registry.execute(name, {}, { workspaceRoot: workspace, approval: 'auto' })).ok, false, `${name} must not run silently in auto mode`);
    }
    assert.equal(calls.length, 0, 'no denied call may reach the server');

    // A real approval is what lets the read-only-hinted tool run.
    const asked = await registry.execute('mcp_fake_writes_files', {}, { workspaceRoot: workspace, approval: 'ask', confirm: async () => true });
    assert.equal(asked.ok, true);
    assert.equal(calls.length, 1);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('MCP governance table: hint combinations map to the documented tier', () => {
  type Case = { label: string; tool: McpToolDescriptor; risk: string; autoApprove?: true; alwaysPrompt?: true };
  const cases: Case[] = [
    { label: 'no annotations', tool: { name: 'a' }, risk: 'shell' },
    { label: 'readOnly only', tool: { name: 'b', annotations: { readOnlyHint: true } }, risk: 'write' },
    { label: 'destructive only', tool: { name: 'c', annotations: { destructiveHint: true } }, risk: 'write', alwaysPrompt: true },
    { label: 'both hints', tool: { name: 'd', annotations: { readOnlyHint: true, destructiveHint: true } }, risk: 'write', alwaysPrompt: true },
    { label: 'readOnly false', tool: { name: 'e', annotations: { readOnlyHint: false } }, risk: 'shell' },
    { label: 'destructive false', tool: { name: 'f', annotations: { destructiveHint: false } }, risk: 'shell' },
    { label: 'empty annotations', tool: { name: 'g', annotations: {} }, risk: 'shell' },
  ];
  for (const item of cases) {
    const actual = governanceForTool(item.tool);
    assert.equal(actual.risk, item.risk, item.label);
    assert.equal(actual.autoApprove, item.autoApprove, `${item.label}: autoApprove`);
    assert.equal(actual.alwaysPrompt, item.alwaysPrompt, `${item.label}: alwaysPrompt`);
  }
});

test('MCP tool names stay within the provider limit and stay stable', () => {
  assert.equal(mcpToolName('demo', 'echo-text'), 'mcp_demo_echo_text');
  const longTool = 'x'.repeat(140);
  const longServer = 's'.repeat(64);
  for (const name of [mcpToolName(longServer, longTool), mcpToolName('demo', 'x'.repeat(200))]) {
    assert.ok(name.length <= MCP_TOOL_NAME_MAX, `${name} is ${name.length} chars`);
    assert.match(name, /^[a-zA-Z0-9_]+$/);
  }
  // Deterministic: same input, same name; distinct inputs, distinct names.
  assert.equal(mcpToolName(longServer, longTool), mcpToolName(longServer, longTool));
  assert.notEqual(mcpToolName('demo', 'x'.repeat(120)), mcpToolName('demo', 'y'.repeat(120)), 'the digest keeps distinct long names distinct');
});

test('MCP argument validation rejects dirty input instead of forwarding it', () => {
  const tool: McpToolDescriptor = {
    name: 'strict',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, count: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'] }, flag: { type: 'boolean' }, tags: { type: 'array' } },
      required: ['text'],
    },
  };
  assert.deepEqual(validateMcpInput(tool, { text: 'ok' }), { text: 'ok' });
  for (const bad of [
    {},
    null,
    { text: 42 },
    { text: 'ok', count: 1.5 },
    { text: 'ok', count: '2' },
    { text: 'ok', mode: 'c' },
    { text: 'ok', flag: 'yes' },
    { text: 'ok', tags: 'nope' },
  ]) {
    assert.throws(() => validateMcpInput(tool, bad), /missing required argument|must be of type|must be one of/, JSON.stringify(bad));
  }
  assert.throws(() => validateMcpInput(tool, [1, 2]), /expected an object/);
  // A permissive schema keeps permissive behaviour; nested values are the
  // server's business.
  assert.deepEqual(validateMcpInput({ name: 'loose' }, { anything: { nested: true } }), { anything: { nested: true } });
});

test('MCP argument validation passes a seeded random table without corrupting valid input', () => {
  const seed = 0x5eed1234;
  const rand = mulberry32(seed);
  const types = ['string', 'number', 'integer', 'boolean', 'array', 'object'] as const;
  for (let index = 0; index < 200; index += 1) {
    const type = types[Math.floor(rand() * types.length)]!;
    const schema: Record<string, unknown> = { type: 'object', properties: { value: { type } }, required: ['value'] };
    const valid = randomValue(rand, type);
    const invalid = randomInvalid(rand, type);
    const tool: McpToolDescriptor = { name: `t${index}`, inputSchema: schema };
    try {
      assert.deepEqual(validateMcpInput(tool, { value: valid }), { value: valid }, `case ${index} type=${type} valid=${JSON.stringify(valid)}`);
      if (invalid !== undefined) {
        assert.throws(() => validateMcpInput(tool, { value: invalid }), /must be of type/, `case ${index} type=${type} invalid=${JSON.stringify(invalid)} seed=${seed}`);
      }
    } catch (error) {
      console.error(`seed=${seed} case=${index} type=${type} schema=${JSON.stringify(schema)}`);
      throw error;
    }
  }
});

function randomValue(rand: () => number, type: string): unknown {
  switch (type) {
    case 'string': return `s${Math.floor(rand() * 100)}`;
    case 'number': return rand() * 1000 - 500;
    case 'integer': return Math.floor(rand() * 1000 - 500);
    case 'boolean': return rand() > 0.5;
    case 'array': return [Math.floor(rand() * 10)];
    default: return { k: Math.floor(rand() * 10) };
  }
}

function randomInvalid(rand: () => number, type: string): unknown {
  const pool: unknown[] = ['str', 1.5, 3, true, [1], { k: 1 }, null];
  const pick = pool.filter((candidate) => !matchesForTest(candidate, type));
  if (pick.length === 0) return undefined;
  return pick[Math.floor(rand() * pick.length)];
}

function matchesForTest(value: unknown, type: string): boolean {
  switch (type) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
    default: return false;
  }
}

test('a bad MCP config can be reloaded instead of crashing on a TDZ reference', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-mcp-tdz-'));
  try {
    await mkdir(join(workspace, '.aicode'), { recursive: true });
    await writeFile(join(workspace, '.aicode', 'mcp.json'), '{ not json');
    const manager = await loadMcpManager({ workspaceRoot: workspace });
    assert.equal(manager.statuses[0]?.connected, false);
    const reloaded = await manager.reload();
    assert.equal(reloaded.statuses[0]?.connected, false);
    await reloaded.close();
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test('a colliding MCP tool name is skipped and reported instead of silently dropped', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-mcp-collide-'));
  try {
    await mkdir(join(workspace, '.aicode'), { recursive: true });
    await writeFile(join(workspace, '.aicode', 'mcp.json'), JSON.stringify({
      servers: { echo: { command: process.execPath, args: [fixtureServer] } },
    }));
    const manager = await loadMcpManager({ workspaceRoot: workspace, existingNames: new Set(['mcp_echo_echo']) });
    try {
      const status = manager.statuses.find((item) => item.name === 'echo');
      assert.equal(status?.toolCount, 1, 'the colliding tool must not be counted');
      assert.match(status?.warning ?? '', /skipped 1 colliding tool name\(s\): mcp_echo_echo/);
      assert.equal(manager.tools.some((tool) => tool.name === 'mcp_echo_echo'), false);
    } finally {
      await manager.close();
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
