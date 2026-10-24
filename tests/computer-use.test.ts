import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { handleSlashCommand } from '../src/cli/commands.js';
import type { AppConfig } from '../src/config/types.js';
import { createMockProvider } from '../src/providers/mock.js';
import { SessionStore } from '../src/session/store.js';
import { createDefaultToolRegistry } from '../src/tools/index.js';
import { computerUseShouldWake, COMPUTER_TOOL_NAMES } from '../src/tools/computer.js';
import { decideApproval } from '../src/safety/policy.js';
import { toToolAwareMessages, toAnthropicAwareMessages } from '../src/providers/protocol.js';
import { stripHistoricalImages } from '../src/agent/contextBudget.js';
import type { AgentMessage } from '../src/providers/types.js';

async function createFixture() {
  const workspace = await mkdtemp(join(tmpdir(), 'aicode-computer-'));
  const sessionDir = join(workspace, '.aicode', 'sessions');
  const config: AppConfig = {
    provider: 'mock',
    model: 'mock-code-agent-v1',
    approval: 'ask',
    workspaceRoot: workspace,
    sessionDir,
    prompt: '',
    maxSteps: 20,
    noBanner: true,
  };
  const provider = createMockProvider(config.model);
  const tools = createDefaultToolRegistry();
  const sessions = new SessionStore(sessionDir);
  const session = await sessions.create({ provider: provider.name, model: provider.model, workspaceRoot: workspace });
  return {
    workspace,
    config,
    provider,
    tools,
    sessions,
    session,
    run: (line: string) => handleSlashCommand({ line, config, provider, tools, sessions, session }),
    cleanup: () => rm(workspace, { recursive: true, force: true }),
  };
}

test('computerUseShouldWake: explicit arm works on any approval mode', () => {
  assert.equal(computerUseShouldWake({ platform: 'win32', approval: 'ask', sessionArmed: true }), true);
  assert.equal(computerUseShouldWake({ platform: 'win32', approval: 'deny', sessionArmed: true }), true);
});

test('computerUseShouldWake: full access + any-app auto-wakes', () => {
  assert.equal(computerUseShouldWake({ platform: 'win32', approval: 'auto', computerAnyApp: true }), true);
  assert.equal(computerUseShouldWake({ platform: 'win32', approval: 'auto', computerAnyApp: false }), false);
  assert.equal(computerUseShouldWake({ platform: 'win32', approval: 'ask', computerAnyApp: true }), false);
});

test('computerUseShouldWake: never on non-Windows', () => {
  assert.equal(computerUseShouldWake({ platform: 'darwin', approval: 'auto', computerAnyApp: true, sessionArmed: true }), false);
  assert.equal(computerUseShouldWake({ platform: 'linux', sessionArmed: true }), false);
});

test('/computer use arms the session and persists it', async () => {
  const fixture = await createFixture();
  try {
    const result = await fixture.run('/computer use 打开记事本');
    assert.match(result, /Computer use armed/);
    assert.match(result, /打开记事本/);
    assert.equal(fixture.session.computerUse, true);
    const reloaded = await fixture.sessions.load(fixture.session.id);
    assert.equal(reloaded.computerUse, true);
  } finally {
    await fixture.cleanup();
  }
});

test('/computer off disarms; /computer status reports state', async () => {
  const fixture = await createFixture();
  try {
    await fixture.run('/computer use');
    assert.equal(fixture.session.computerUse, true);
    const off = await fixture.run('/computer off');
    assert.match(off, /disarmed/);
    assert.equal(fixture.session.computerUse, false);
    const status = await fixture.run('/computer status');
    assert.match(status, /Computer use: off/);
    const bad = await fixture.run('/computer bogus');
    assert.match(bad, /Unknown \/computer subcommand/);
  } finally {
    await fixture.cleanup();
  }
});

test('decideApproval: computerUse shell action without command runs in auto, prompts in ask, denied in deny', () => {
  const base = { risk: 'shell' as const, workspaceRoot: 'C:/ws' };
  const auto = decideApproval({ ...base, mode: 'auto', computerUse: true });
  assert.equal(auto.allowed, true);
  assert.equal(auto.needsPrompt, false);
  const ask = decideApproval({ ...base, mode: 'ask', computerUse: true });
  assert.equal(ask.allowed, true);
  assert.equal(ask.needsPrompt, true);
  const deny = decideApproval({ ...base, mode: 'deny', computerUse: true });
  assert.equal(deny.allowed, false);
  // Without computerUse armed, an empty-command shell call in auto mode is still refused.
  const plain = decideApproval({ ...base, mode: 'auto' });
  assert.equal(plain.allowed, false);
});

test('tool messages with image parts render for OpenAI and Anthropic', () => {
  const messages: AgentMessage[] = [
    { role: 'tool', name: 'computer_screenshot', content: 'Screenshot saved', createdAt: 'now',
      parts: [
        { type: 'text', text: '[screenshot /tmp/x.png]' },
        { type: 'image', mediaType: 'image/png', data: 'AAAA', path: '/tmp/x.png' },
      ] },
  ];
  const openai = toToolAwareMessages(messages) as Array<{ role: string; content: unknown }>;
  assert.equal(openai[0]!.role, 'user');
  const openaiContent = openai[0]!.content as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(openaiContent));
  assert.equal(openaiContent[0]!.type, 'text');
  const openaiImage = openaiContent.find((block) => block.type === 'image_url') as { image_url: { url: string } } | undefined;
  assert.equal(openaiImage?.image_url.url, 'data:image/png;base64,AAAA');

  const anthropic = toAnthropicAwareMessages(messages) as Array<{ role: string; content: unknown }>;
  assert.equal(anthropic[0]!.role, 'user');
  const blocks = anthropic[0]!.content as Array<Record<string, unknown>>;
  assert.equal(blocks[0]!.type, 'text');
  const anthropicImage = blocks.find((block) => block.type === 'image') as { source: { data: string } } | undefined;
  assert.equal(anthropicImage?.source.data, 'AAAA');
});

test('stripHistoricalImages keeps only the newest image (tool messages included)', () => {
  const withImage = (tag: string): AgentMessage => ({
    role: 'tool', name: 'computer_screenshot', content: tag, createdAt: 'now',
    parts: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
  });
  const { messages, imagesStripped } = stripHistoricalImages([withImage('old'), withImage('new')]);
  assert.equal(imagesStripped, 1);
  assert.equal(messages[0]!.parts?.[0]?.type, 'text');
  assert.equal(messages[1]!.parts?.[0]?.type, 'image');
});

test('appendToolCall persists image parts on the message but not the record, and downgrades older images', async () => {
  const fixture = await createFixture();
  try {
    const imagePart = [{ type: 'text' as const, text: '[shot]' }, { type: 'image' as const, mediaType: 'image/png', data: 'AAAA' }];
    await fixture.sessions.appendToolCall(fixture.session, { tool: 'computer_screenshot', input: {}, ok: true, output: 'first' }, { parts: imagePart });
    await fixture.sessions.appendToolCall(fixture.session, { tool: 'computer_screenshot', input: {}, ok: true, output: 'second' }, { parts: imagePart });
    const toolMessages = fixture.session.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMessages.length, 2);
    // Only the newest keeps a real image; the older one is text-only.
    assert.ok(toolMessages[0]!.parts?.every((p) => p.type === 'text'));
    assert.ok(toolMessages[1]!.parts?.some((p) => p.type === 'image'));
    // Records never carry base64.
    for (const record of fixture.session.toolCalls) {
      assert.equal('parts' in record, false);
    }
  } finally {
    await fixture.cleanup();
  }
});

test('computer tools validate inputs strictly', async () => {
  const fixture = await createFixture();
  try {
    // Not registered by default — only via wake injection. Register manually for validation checks.
    assert.equal(fixture.tools.get('computer_click'), undefined);
    const { createComputerTools } = await import('../src/tools/computer.js');
    for (const tool of createComputerTools()) fixture.tools.register(tool, { replace: true });
    assert.ok(fixture.tools.get('computer_screenshot'));
    assert.equal([...COMPUTER_TOOL_NAMES].every((name) => fixture.tools.get(name) !== undefined), true);
    assert.throws(() => fixture.tools.get('computer_click')!.validate({ x: 10 }), /y must be/);
    assert.throws(() => fixture.tools.get('computer_click')!.validate({ x: -5, y: 10 }), /between 0 and/);
    assert.throws(() => fixture.tools.get('computer_type')!.validate({ text: '' }), /required/);
    assert.throws(() => fixture.tools.get('computer_key')!.validate({ keys: 'a'.repeat(200) }), /too long/);
    assert.deepEqual(fixture.tools.get('computer_click')!.validate({ x: 10.4, y: 20, button: 'right', double: true }), { x: 10, y: 20, button: 'right', double: true });
    assert.equal(fixture.tools.get('computer_click')?.risk, 'shell');
    assert.equal(fixture.tools.get('computer_screenshot')?.risk, 'read');
    // Accessibility channel: computer_elements is a read-only snapshot tool;
    // computer_press is a shell action (confirm per press) with strict input
    // checks and an index bound matching the 200-line display cap.
    assert.ok(fixture.tools.get('computer_elements'));
    assert.equal(fixture.tools.get('computer_elements')?.risk, 'read');
    assert.ok(fixture.tools.get('computer_press'));
    assert.equal(fixture.tools.get('computer_press')?.risk, 'shell');
    assert.throws(() => fixture.tools.get('computer_elements')!.validate({}), /window is required/);
    assert.throws(() => fixture.tools.get('computer_press')!.validate({ window: '12' }), /index must be a number/);
    assert.throws(() => fixture.tools.get('computer_press')!.validate({ window: '12', index: 500 }), /between 0 and 199/);
    assert.deepEqual(fixture.tools.get('computer_press')!.validate({ window: '12', index: 3, expected: 'x'.repeat(300) }), { window: '12', index: 3, expected: 'x'.repeat(200), double: false });
    assert.deepEqual(fixture.tools.get('computer_press')!.validate({ window: '记事本', index: 0 }), { window: '记事本', index: 0, expected: undefined, double: false });
    // Wake injection registers the full set: the background single-window
    // capture plus drag, which is the only way to operate a canvas.
    assert.equal(COMPUTER_TOOL_NAMES.size, 11);
  } finally {
    await fixture.cleanup();
  }
});
