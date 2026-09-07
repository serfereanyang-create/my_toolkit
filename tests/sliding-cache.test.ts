import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toAnthropicAwareMessages } from '../src/providers/protocol.js';
import type { AgentMessage } from '../src/providers/types.js';

const msg = (role: AgentMessage['role'], content: string): AgentMessage => ({ role, content, createdAt: '2026-01-01T00:00:00.000Z' });

test('sliding breakpoint marks only the last message', () => {
  const result = toAnthropicAwareMessages(
    [msg('user', 'first'), msg('assistant', 'reply'), msg('user', 'latest')],
    { slidingCacheBreakpoint: true },
  );
  assert.equal(result.length, 3);
  for (const message of result.slice(0, -1)) {
    assert.equal(typeof message.content, 'string');
  }
  const last = result.at(-1)!;
  assert.ok(Array.isArray(last.content));
  const block = last.content.at(-1) as Record<string, unknown>;
  assert.deepEqual(block.cache_control, { type: 'ephemeral' });
});

test('sliding breakpoint advances with conversation (prefix grows, mark stays on tail)', () => {
  const base = [msg('user', 'q1'), msg('assistant', 'a1')];
  const turn2 = toAnthropicAwareMessages([...base, msg('user', 'q2')], { slidingCacheBreakpoint: true });
  const turn3 = toAnthropicAwareMessages([...base, msg('user', 'q2'), msg('assistant', 'a2'), msg('user', 'q3')], { slidingCacheBreakpoint: true });
  // Turn 2 marked q2 (last); turn 3's q2 reverted to plain text as cached prefix
  // and q3 now carries the mark — the breakpoint "slid" forward.
  const q2InTurn2 = turn2[2]!.content as Array<Record<string, unknown>>;
  assert.deepEqual(q2InTurn2.at(-1)!.cache_control, { type: 'ephemeral' });
  assert.equal(typeof turn3[2]!.content, 'string');
  const q3InTurn3 = turn3[4]!.content as Array<Record<string, unknown>>;
  assert.deepEqual(q3InTurn3.at(-1)!.cache_control, { type: 'ephemeral' });
});

test('without option, no message carries cache_control', () => {
  const result = toAnthropicAwareMessages([msg('user', 'hello'), msg('assistant', 'hi')]);
  result.forEach((message) => assert.equal(typeof message.content, 'string'));
});

test('image-bearing last message gets breakpoint on its final block', () => {
  const imageMessage: AgentMessage = {
    role: 'user',
    content: 'screenshot',
    createdAt: '2026-01-01T00:00:00.000Z',
    parts: [
      { type: 'text', text: 'what is this' },
      { type: 'image', mediaType: 'image/png', data: 'aGk=' },
    ],
  };
  const result = toAnthropicAwareMessages([msg('user', 'earlier'), imageMessage], { slidingCacheBreakpoint: true });
  const last = result.at(-1)!;
  assert.ok(Array.isArray(last.content));
  const lastBlock = last.content.at(-1) as Record<string, unknown>;
  assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' });
});
