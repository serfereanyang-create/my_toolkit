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

/*
 * The per-turn tool strategy must sit OUTSIDE the cached prefix.
 *
 * Anthropic evaluates the prefix in the order tools → system → messages, so a
 * strategy placed in `system` is inside the range the sliding breakpoint covers.
 * The strategy is regenerated every turn from the prompt and recent tool
 * results, so putting it there meant the conversation history could never be
 * cached: only tools + the stable system block were reusable, and every turn
 * re-paid for the whole transcript. That is the ~70% plateau measured in the
 * usage ledger, where turns that call tools read ~66% from cache and turns that
 * answer directly — a single step, with no later step to re-read the prefix —
 * read ~1.5%.
 */

test('trailing strategy rides on the last message, not in system', () => {
  const result = toAnthropicAwareMessages(
    [msg('user', 'first'), msg('assistant', 'reply'), msg('user', 'latest')],
    { slidingCacheBreakpoint: true, trailingStrategy: 'intent=code_edit' },
  );
  const last = result.at(-1)!;
  assert.ok(Array.isArray(last.content));
  const blocks = last.content as Array<Record<string, unknown>>;
  // Two blocks: the message's own text, then the strategy.
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0]!.text, 'latest');
  assert.match(String(blocks[1]!.text), /intent=code_edit/);
  // Earlier messages are untouched.
  for (const message of result.slice(0, -1)) assert.equal(typeof message.content, 'string');
});

test('the cache breakpoint sits BEFORE the trailing strategy', () => {
  // If the mark landed on the strategy block, the changing strategy would be
  // inside the cached range and invalidate it every turn.
  const result = toAnthropicAwareMessages(
    [msg('user', 'q1'), msg('user', 'q2')],
    { slidingCacheBreakpoint: true, trailingStrategy: 'intent=code_search' },
  );
  const blocks = result.at(-1)!.content as Array<Record<string, unknown>>;
  assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' }, 'the message content is cached');
  assert.equal(blocks[1]!.cache_control, undefined, 'the strategy is NOT cached');
});

test('a changing strategy does not change the cached portion', () => {
  // The property that makes the cache usable across turns: everything the
  // breakpoint covers is byte-identical even though the strategy differs.
  const history = [msg('user', 'q1'), msg('assistant', 'a1'), msg('user', 'q2')];
  const turnA = toAnthropicAwareMessages(history, { slidingCacheBreakpoint: true, trailingStrategy: 'intent=code_edit\nreason=turn A' });
  const turnB = toAnthropicAwareMessages(history, { slidingCacheBreakpoint: true, trailingStrategy: 'intent=code_search\nreason=turn B' });

  const cachedPortion = (messages: typeof turnA) => JSON.stringify([
    messages.slice(0, -1),
    (messages.at(-1)!.content as Array<Record<string, unknown>>)[0],
  ]);
  assert.equal(cachedPortion(turnA), cachedPortion(turnB));
  // And the strategies really are different, or the assertion above is vacuous.
  const strategyOf = (messages: typeof turnA) => (messages.at(-1)!.content as Array<Record<string, unknown>>)[1]!.text;
  assert.notEqual(strategyOf(turnA), strategyOf(turnB));
});

test('no trailing strategy leaves the breakpoint on the last block', () => {
  const result = toAnthropicAwareMessages(
    [msg('user', 'q1'), msg('user', 'q2')],
    { slidingCacheBreakpoint: true },
  );
  const blocks = result.at(-1)!.content as Array<Record<string, unknown>>;
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0]!.cache_control, { type: 'ephemeral' });
});

test('a trailing strategy is appended to an image message without dropping it', () => {
  // Computer-use screenshots arrive as image blocks; the strategy must not
  // replace them.
  const withImage: AgentMessage = {
    role: 'user',
    content: 'look at this',
    createdAt: '2026-01-01T00:00:00.000Z',
    parts: [{ type: 'image', mediaType: 'image/png', data: 'AAA' }],
  };
  const result = toAnthropicAwareMessages([msg('user', 'q1'), withImage], {
    slidingCacheBreakpoint: true,
    trailingStrategy: 'intent=runtime_info',
  });
  const blocks = result.at(-1)!.content as Array<Record<string, unknown>>;
  assert.ok(blocks.some((block) => block.type === 'image'), 'the image block survives');
  assert.match(String(blocks.at(-1)!.text), /intent=runtime_info/);
  // The mark is on the image block (the last non-strategy block).
  const marked = blocks.filter((block) => block.cache_control !== undefined);
  assert.equal(marked.length, 1);
  assert.equal(marked[0]!.type, 'image');
});
