import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compactMessagesForModel,
  resolveContextBudgetChars,
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
  });

  assert.ok(packed.truncated || packed.droppedMessages > 0);
  assert.ok(packed.compactChars <= 10_000);
  assert.ok(packed.messages.length < messages.length);
  assert.match(packed.messages[0]?.content ?? '', /compacted session history|user turn|tool turn|assistant turn/i);
  assert.equal(packed.messages.at(-1)?.role, 'assistant');
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
  assert.equal(packed.truncated, false);
});
