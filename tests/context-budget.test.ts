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

test('the budget is derived from the model window, not a fixed number', () => {
  // The regression: 80_000 chars (~20k tokens) was the budget for EVERY model,
  // which is 1/14th of a 272k window. Real turns measured 100k–145k tokens, so
  // hard-pack dropped ~86% of the conversation on every step.
  const gpt5 = resolveContextBudgetChars({}, 'gpt-5.5');
  const deepseek = resolveContextBudgetChars({}, 'deepseek-v4.1-flash');
  assert.ok(gpt5 > deepseek, 'a larger window must yield a larger budget');
  // effective window (95%) × 4 bytes/token.
  assert.equal(gpt5, Math.floor(272_000 * 0.95) * 4);
  assert.equal(deepseek, Math.floor(128_000 * 0.95) * 4);
  assert.ok(gpt5 > 80_000, 'the old fixed default must no longer be the budget');
});

test('an explicit AICODE_CONTEXT_BUDGET_CHARS overrides the derived budget', () => {
  assert.equal(resolveContextBudgetChars({ AICODE_CONTEXT_BUDGET_CHARS: '12000' }, 'gpt-5.5'), 12_000);
  // Tiny values are still rejected in favour of the derived budget.
  assert.equal(
    resolveContextBudgetChars({ AICODE_CONTEXT_BUDGET_CHARS: '100' }, 'gpt-5.5'),
    Math.floor(272_000 * 0.95) * 4,
  );
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

test('compactMessagesForModel drops the oldest messages when the history cannot fit', () => {
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
  assert.equal(packed.messages.at(-1)?.role, 'assistant');
  assert.equal(packed.mode, 'hard-pack');
  // The kept messages are the NEWEST ones: dropping happens at the front, so the
  // retained suffix keeps its bytes and stays a cache hit.
  const keptTurnNumbers = packed.messages
    .map((message) => /turn (\d+)/.exec(message.content)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  assert.ok(keptTurnNumbers.length > 0);
  assert.ok(Math.min(...keptTurnNumbers) > 0, 'the oldest turns must be the ones dropped');
  assert.ok(
    !packed.messages.some((message) => message.content.startsWith('[compacted session history]')),
    'no synthesized summary: its live counts changed every step and broke the cached prefix',
  );
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
    keepRecent: 3,
    keepPrefix: 1,
  });
  assert.ok(packed.compactChars <= 12_000);
  assert.ok(packed.softTriggered || packed.mode !== 'passthrough');
  assert.equal(packed.messages.at(-1)?.content, 'fresh');
});

/*
 * Cache stability of the packed history.
 *
 * `compactMessagesForModel` runs on EVERY model step, so its output is the
 * prefix the provider caches. If packing a message depends on anything other
 * than that message, the prefix changes as the conversation grows and every
 * step re-pays for the whole history.
 *
 * It did. Two separate mechanisms, both found in real usage data (hit rate
 * pinned around 70% on an endpoint whose cache works):
 *
 *  1. Clip limits were chosen by distance from the END of the array. Every step
 *     appends messages, so a message drifted out of the "recent" window, got
 *     re-clipped tighter, and `truncateText` wrote a different omitted-count
 *     into its body — changing bytes in the MIDDLE of the history.
 *  2. Hard-pack injected a `[compacted session history]` summary near the front
 *     whose text was a live count of the messages being dropped ("tools=6" →
 *     "tools=7"). That message changed on every step.
 *
 * These tests assert the property directly, so a future change to the packing
 * strategy cannot quietly reintroduce either.
 */

/** One turn's worth of history, as a growing conversation produces it. */
function history(turns: number, bodyChars = 3_000): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push(msg('user', `user turn ${index} ${'u'.repeat(bodyChars)}`));
    messages.push(msg('tool', `tool turn ${index} ${'t'.repeat(bodyChars)}`, 'search_text'));
    messages.push(msg('assistant', `assistant turn ${index} ${'a'.repeat(bodyChars)}`));
  }
  return messages;
}

/** How many leading packed messages are byte-identical between two packings. */
function sharedLeadingMessages(a: AgentMessage[], b: AgentMessage[]): number {
  let same = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index]!.content !== b[index]!.content) break;
    same += 1;
  }
  return same;
}

test('packing a message does not depend on how much history follows it', () => {
  // The property: clip(m) is a function of m alone. Appending newer messages
  // must not rewrite the bytes of older ones.
  const base = history(4);
  const grown = [...base, ...history(4).map((m) => ({ ...m, content: m.content.replace('turn', 'later turn') }))];
  const cfg = { budgetChars: 500_000 };

  const packedBase = compactMessagesForModel(base, cfg);
  const packedGrown = compactMessagesForModel(grown, cfg);
  // Same messages at the same positions => identical bytes.
  for (let index = 0; index < packedBase.messages.length; index += 1) {
    assert.equal(
      packedGrown.messages[index]!.content,
      packedBase.messages[index]!.content,
      `message ${index} changed when newer messages were appended`,
    );
  }
});

test('a growing conversation keeps its cached prefix as it crosses the soft threshold', () => {
  // The regression: crossing the threshold used to rewrite the whole history at
  // once, because the clip limits switched tier — so the turn that crossed it
  // paid full price, and so did every turn after, since the boundary kept
  // sliding.
  //
  // With clip limits fixed by role, a message's packed bytes no longer depend on
  // position. The drop point still has to move to respect the budget (see the
  // note on hardPack: quantizing it was tried and broke the budget invariant),
  // so this asserts the achievable property — while the mode stays soft-clip,
  // nothing is dropped and the prefix must be fully byte-stable.
  const cfg = { budgetChars: 40_000, softRatio: 0.5 };

  let messages = history(2);
  let previous = compactMessagesForModel(messages, cfg);
  for (let turn = 3; turn <= 12; turn += 1) {
    messages = [...messages, ...history(1).map((m) => ({ ...m, content: m.content.replace('turn 0', `turn ${turn}`) }))];
    const current = compactMessagesForModel(messages, cfg);
    if (current.mode === 'soft-clip') {
      const shared = sharedLeadingMessages(previous.messages, current.messages);
      assert.equal(
        shared,
        Math.min(previous.messages.length, current.messages.length),
        `turn ${turn}: soft-clip must keep every message byte-stable, not just the first ${shared}`,
      );
    }
    previous = current;
  }
});

test('hard-pack never exceeds the budget', () => {
  // The invariant this function exists for. A version that quantized the drop
  // point to a block boundary (to improve cache reuse) left the result OVER
  // budget on 19 of 30 steps, which is worse than a cache miss: it risks the
  // request being rejected for context length.
  const cfg = { budgetChars: 20_000 };
  let messages: AgentMessage[] = [];
  for (let turn = 0; turn < 30; turn += 1) {
    messages = [...messages, ...history(1, 2_000).map((m) => ({ ...m, content: m.content.replace('turn 0', `turn ${turn}`) }))];
    const packed = compactMessagesForModel(messages, cfg);
    assert.ok(
      packed.compactChars <= cfg.budgetChars,
      `turn ${turn}: packed ${packed.compactChars} chars exceeds the ${cfg.budgetChars} budget (mode ${packed.mode})`,
    );
  }
});

test('hard-pack keeps a suffix of the newest messages, not a rewritten middle', () => {
  // Dropping from the front means the retained messages keep their bytes; the
  // old implementation kept a 2-message prefix AND a summary whose counts
  // changed, so almost nothing survived.
  const cfg = { budgetChars: 12_000 };
  const packed = compactMessagesForModel(history(20), cfg);
  assert.equal(packed.mode, 'hard-pack');
  assert.ok(packed.messages.length > 0);
  // Every kept message is an original message, unmodified apart from clipping.
  for (const message of packed.messages) {
    assert.ok(!message.content.startsWith('[compacted session history]'));
  }
  // And they are the newest ones.
  const numbers = packed.messages
    .map((message) => /turn (\d+)/.exec(message.content)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  assert.ok(numbers.length > 0);
  assert.ok(Math.min(...numbers) >= 10, `expected the newest turns, got ${JSON.stringify(numbers)}`);
});
