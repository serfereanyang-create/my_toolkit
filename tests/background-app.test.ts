import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createBackgroundAppTools, BACKGROUND_APP_TOOL_NAMES } from '../src/tools/backgroundApp.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createAgentRuntime } from '../src/runtime/createRuntime.js';
import { runAgentTurn } from '../src/agent/agent.js';
import { runSubAgent } from '../src/subagent/runner.js';
import { isReadOnlyTool } from '../src/tools/scope.js';
import type { AppConfig } from '../src/config/types.js';
import type { AgentAction, ProviderRequest } from '../src/providers/types.js';

const appId = '11111111-1111-4111-8111-111111111111';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE6kAAAAASUVORK5CYII=';

test('background app tool surface is bounded and launch executes under shell approval', () => {
  const tools = createBackgroundAppTools(async () => ({ ok: true, output: 'ok' }));
  assert.deepEqual(new Set(tools.map(tool => tool.name)), BACKGROUND_APP_TOOL_NAMES);
  const open = tools.find(tool => tool.name === 'background_app_open')!;
  assert.equal(open.risk, 'shell');
  for (const input of [{ path: '../outside' }, { path: 'C:\\app' }, { path: '/app' }, { path: '.', command: 'anything' }, { path: '.', width: 4097 }]) assert.throws(() => open.validate(input));
  assert.deepEqual(open.validate({ path: '.', width: 100 }), { path: '.', width: 100 });
  for (const tool of tools) assert.equal(tool.parallelSafe, false);
});

test('deny and rejected ask modes never invoke the desktop launcher', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yoy-bgapp-policy-'));
  let calls = 0;
  try {
    const registry = ToolRegistry.fromTools(createBackgroundAppTools(async () => { calls += 1; return { ok: true, output: 'started' }; }));
    for (const approval of ['deny', 'ask', 'plan'] as const) {
      const result = await registry.execute('background_app_open', { path: '.' }, { workspaceRoot: workspace, approval, confirm: async () => false });
      assert.equal(result.ok, false);
    }
    assert.equal(calls, 0);
    const approved = await registry.execute('background_app_open', { path: '.' }, { workspaceRoot: workspace, approval: 'ask', confirm: async () => true });
    assert.equal(approved.ok, true);
    assert.equal(calls, 1);
  } finally { await rm(workspace, { recursive: true, force: true }); }
});

test('visual input has a bounded coordinate/text contract and never mixes selector and point clicks', () => {
  const tools = createBackgroundAppTools(async () => ({ ok: true, output: 'ok' }));
  const click = tools.find(tool => tool.name === 'background_app_click')!;
  for (const input of [{ appId, x: 1 }, { appId, x: 1, y: 2, selector: '#input' }, { appId, x: -1, y: 2 }, { appId, x: '1', y: 2 }, { appId, selector: '#input', button: ['left'] }]) assert.throws(() => click.validate(input));
  assert.deepEqual(click.validate({ appId, x: 20, y: 30 }), { appId, x: 20, y: 30 });
  const typing = tools.find(tool => tool.name === 'background_app_type')!;
  assert.equal(typing.risk, 'write');
  assert.throws(() => typing.validate({ appId, text: '' }));
  const key = tools.find(tool => tool.name === 'background_app_key')!;
  for (const value of ['Control+Ctrl+A', '__proto__+A', 'constructor', 'Control+']) assert.throws(() => key.validate({ appId, key: value }));
});

test('screenshot refuses malformed images and outside-workspace image paths', async () => {
  const context = { workspaceRoot: process.cwd(), approval: 'auto' as const };
  for (const image of [{ mediaType: 'text/plain', data: png, path: '.aicode/screenshots/a.png' }, { mediaType: 'image/png', data: png, path: '../secret.png' }, { mediaType: 'image/png', data: 'bad', path: '.aicode/screenshots/a.png' }]) {
    const screenshot = createBackgroundAppTools(async () => ({ ok: true, output: 'captured', data: { computerImage: image } })).find(tool => tool.name === 'background_app_screenshot')!;
    await assert.rejects(screenshot.execute(screenshot.validate({ appId }), context));
  }
});

test('real agent turn offers background tools and sends screenshot pixels to the next model call', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yoy-bgapp-vision-'));
  const sessionDir = join(workspace, 'sessions');
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir, backgroundBrowser: true, backgroundBrowserOnly: true, toolScope: 'compact', noBanner: true, json: true, maxSteps: 4 };
  const created = await createAgentRuntime(config);
  const requests: ProviderRequest[] = [];
  try {
    created.runtime.hostToolInvoke = async (tool) => {
      assert.equal(tool, 'background_app_screenshot');
      return { ok: true, output: 'hidden app screenshot', data: { computerImage: { mediaType: 'image/png', data: png, path: '.aicode/screenshots/app.png' } } };
    };
    created.runtime.provider = { name: 'mock', model: 'mock-code-agent-v1', async complete(request) {
      requests.push(structuredClone({ ...request, onTextDelta: undefined, onThinkingDelta: undefined }));
      const actions: AgentAction[] = requests.length === 1 ? [{ type: 'tool', tool: 'background_app_screenshot', input: { appId } }] : [{ type: 'message', content: 'verified' }];
      return { actions };
    } };
    await runAgentTurn(created.runtime, 'inspect the hidden Electron app screenshot');
    assert.equal(requests.length, 2);
    for (const name of BACKGROUND_APP_TOOL_NAMES) assert.ok(requests[0].tools.some(tool => tool.name === name), name);
    assert.equal(requests[0].tools.some(tool => tool.name.startsWith('computer_')), false);
    assert.ok(requests[1].messages.some(message => message.parts?.some(part => part.type === 'image' && part.data === png)), 'model must receive actual image data');
    const files = await readdir(sessionDir);
    const saved = JSON.parse(await readFile(join(sessionDir, `${created.runtime.session.id}.json`), 'utf8'));
    assert.ok(files.includes(`${created.runtime.session.id}.json`));
    assert.ok(saved.toolCalls.length > 0);
    assert.equal(JSON.stringify(saved.toolCalls).includes(png), false);
  } finally { await created.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('a readonly sub-agent keeps its role boundary after background and delegation injection', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'yoy-bgapp-readonly-'));
  const config: AppConfig = { provider: 'mock', model: 'mock-code-agent-v1', approval: 'auto', workspaceRoot: workspace, sessionDir: join(workspace, 'sessions'), backgroundBrowser: true, backgroundBrowserOnly: true, noBanner: true, json: true, maxSteps: 2 };
  const created = await createAgentRuntime(config);
  const offers: ProviderRequest[] = [];
  let invoked = 0;
  try {
    created.runtime.hostToolInvoke = async () => { invoked += 1; return { ok: true, output: 'must not start' }; };
    created.runtime.provider = { name: 'mock', model: 'mock-code-agent-v1', async complete(request) {
      offers.push(request);
      return { actions: offers.length === 1 ? [{ type: 'tool', tool: 'background_app_open', input: { path: '.' } }] : [{ type: 'message', content: 'read-only analysis complete' }] };
    } };
    const result = await runSubAgent({ id: 'readonly-proof', expert: 'code_search', goal: 'Read the local Electron interface without changes', maxSteps: 2 }, created.runtime, new Map());
    assert.ok(offers.length > 0, result.answer);
    assert.ok(offers[0].tools.length > 0);
    assert.ok(offers[0].tools.every(isReadOnlyTool));
    assert.equal(offers[0].tools.some(tool => tool.name === 'background_app_open' || tool.name === 'spawn_subagent'), false);
    assert.equal(invoked, 0, 'an unoffered write tool must also be unexecutable');
  } finally { await created.close(); await rm(workspace, { recursive: true, force: true }); }
});
