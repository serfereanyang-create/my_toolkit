import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compactMessagesForModel,
  resolveContextBudgetChars,
  resolveContextBudgetConfig,
  stripHistoricalImages,
} from '../src/agent/contextBudget.js';
import type { AgentMessage } from '../src/providers/types.js';

function msg(role: AgentMessage['role'], content: string, name?: string): AgentMessage {
  return { role, content, name, createdAt: new Date().toISOString() };
}

test('resolveContextBudgetChars reads env and rejects tiny values', () => {
  assert.equal(resolveContextBudgetChars({}), 80_000);
  assert.equal(resolveContextBudgetChars({ AICODE_CONTEXT_BUDGET_CHARS: '12000' }), 12_000);
  assert.equal(resolveContextBudgetChars({ AICODE_CONTEXT_BUDGET_CHARS: '100' }), 80_000);
});

test('resolveContextBudgetConfig reads soft ratio and keep windows', () => {
  const cfg = resolveContextBudgetConfig({
    AICODE_CONTEXT_BUDGET_CHARS: '20000',
    AICODE_CONTEXT_SOFT_RATIO: '0.6',
    AICODE_CONTEXT_KEEP_RECENT: '6',
    AICODE_CONTEXT_KEEP_PREFIX: '3',
  });
  assert.equal(cfg.budgetChars, 20_000);
  assert.equal(cfg.softRatio, 0.6);
  assert.equal(cfg.keepRecent, 6);
  assert.equal(cfg.keepPrefix, 3);
});

test('compactMessagesForModel keeps recent messages and truncates huge tool output', () => {
  const huge = 'x'.repeat(20_000);
  const messages = [
    msg('user', 'old request'),
    msg('tool', huge, 'search_text'),
    msg('assistant', 'old answer'),
    msg('user', 'latest request'),
    msg('tool', 'latest tool output ok', 'read_file'),
  ];

  const packed = compactMessagesForModel(messages, {
    budgetChars: 12_000,
    maxToolChars: 4_000,
    softRatio: 0.5,
  });

  assert.equal(packed.messages.at(-1)?.content, 'latest tool output ok');
  assert.equal(packed.messages.some((message) => message.content.includes('latest request')), true);
  const tool = packed.messages.find((message) => message.role === 'tool' && message.name === 'search_text');
  if (tool) {
    assert.ok(tool.content.length < 20_000);
    assert.match(tool.content, /truncated/i);
  }
  assert.ok(packed.compactChars <= 12_000);
});

test('compactMessagesForModel inserts summary when older history cannot fit', () => {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < 40; index += 1) {
    messages.push(msg('user', `user turn ${index} ${'u'.repeat(500)}`));
    messages.push(msg('tool', `tool turn ${index} ${'t'.repeat(800)}`, 'search_text'));
    messages.push(msg('assistant', `assistant turn ${index} ${'a'.repeat(400)}`));
  }

  const packed = compactMessagesForModel(messages, {
    budgetChars: 10_000,
    maxToolChars: 300,
    maxAssistantChars: 300,
    maxUserChars: 300,
    softRatio: 0.5,
    keepRecent: 6,
    keepPrefix: 2,
  });

  assert.ok(packed.truncated || packed.droppedMessages > 0);
  assert.ok(packed.compactChars <= 10_000);
  assert.ok(packed.messages.length < messages.length);
  assert.ok(
    packed.messages.some((message) => message.content.startsWith('[compacted session history]'))
    || packed.messages[0]?.content.includes('user turn')
    || packed.messages.at(-1)?.role === 'assistant',
  );
  assert.equal(packed.messages.at(-1)?.role, 'assistant');
  assert.equal(packed.mode, 'hard-pack');
});

test('compactMessagesForModel preserves full history when under budget', () => {
  const messages = [
    msg('user', 'hello'),
    msg('assistant', 'hi'),
    msg('tool', 'ok', 'project_status'),
  ];
  const packed = compactMessagesForModel(messages, { budgetChars: 50_000 });
  assert.equal(packed.messages.length, 3);
  assert.equal(packed.droppedMessages, 0);
  assert.equal(packed.mode, 'passthrough');
});

test('stripHistoricalImages keeps only latest user image parts', () => {
  const messages: AgentMessage[] = [
    {
      role: 'user',
      content: 'first',
      createdAt: new Date().toISOString(),
      parts: [
        { type: 'text', text: 'first' },
        { type: 'image', mediaType: 'image/png', data: 'AAA' },
      ],
    },
    msg('assistant', 'ok'),
    {
      role: 'user',
      content: 'second',
      createdAt: new Date().toISOString(),
      parts: [
        { type: 'text', text: 'second' },
        { type: 'image', mediaType: 'image/png', data: 'BBB' },
      ],
    },
  ];
  const { messages: next, imagesStripped } = stripHistoricalImages(messages);
  assert.equal(imagesStripped, 1);
  assert.equal(next[0]?.parts?.some((part) => part.type === 'image'), false);
  assert.equal(next[2]?.parts?.some((part) => part.type === 'image'), true);

  const packed = compactMessagesForModel(messages, { budgetChars: 50_000 });
  assert.ok(packed.imagesStripped >= 1);
});

test('soft threshold clips before hard drop when moderately over soft ratio', () => {
  const messages = [
    msg('user', `start ${'s'.repeat(2_000)}`),
    msg('tool', 't'.repeat(8_000), 'search_text'),
    msg('assistant', 'a'.repeat(3_000)),
    msg('user', 'latest'),
    msg('tool', 'fresh', 'read_file'),
  ];
  const packed = compactMessagesForModel(messages, {
    budgetChars: 12_000,
    softRatio: 0.5,
    maxToolChars: 4_000,
    maxToolCharsSoft: 1_500,
    keepRecent: 3,
    keepPrefix: 1,
  });
  assert.ok(packed.compactChars <= 12_000);
  assert.ok(packed.softTriggered || packed.mode !== 'passthrough');
  assert.equal(packed.messages.at(-1)?.content, 'fresh');
});
