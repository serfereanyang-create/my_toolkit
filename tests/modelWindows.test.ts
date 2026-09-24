import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTO_COMPACT_WINDOW_FRACTION,
  EFFECTIVE_CONTEXT_WINDOW_PERCENT,
  FALLBACK_CONTEXT_WINDOW_TOKENS,
  autoCompactTokenLimit,
  effectiveContextWindow,
  resolveModelContextWindow,
} from '../src/agent/modelWindows.js';

test('an explicit AICODE_CONTEXT_WINDOW wins over the table', () => {
  assert.equal(resolveModelContextWindow('gpt-5.5', { AICODE_CONTEXT_WINDOW: '64000' }), 64_000);
  assert.equal(resolveModelContextWindow('claude-sonnet-4', { AICODE_CONTEXT_WINDOW: '900000' }), 900_000);
});

test('an unusable override falls through to the table instead of disabling compaction', () => {
  // The old behavior treated "no window" as "never compact". A junk override
  // must not be able to reintroduce that.
  assert.equal(resolveModelContextWindow('gpt-5.5', { AICODE_CONTEXT_WINDOW: 'nope' }), 272_000);
  assert.equal(resolveModelContextWindow('gpt-5.5', { AICODE_CONTEXT_WINDOW: '-1' }), 272_000);
  assert.equal(resolveModelContextWindow('gpt-5.5', { AICODE_CONTEXT_WINDOW: '' }), 272_000);
});

test('known models resolve to their vendor window', () => {
  assert.equal(resolveModelContextWindow('gpt-5.6-luna'), 272_000);
  assert.equal(resolveModelContextWindow('claude-3-5-sonnet-latest'), 200_000);
  assert.equal(resolveModelContextWindow('glm-5.3'), 200_000);
  assert.equal(resolveModelContextWindow('glm-4.6'), 200_000);
  assert.equal(resolveModelContextWindow('deepseek-v4.1-flash'), 128_000);
  assert.equal(resolveModelContextWindow('kimi-k2-thinking'), 256_000);
  assert.equal(resolveModelContextWindow('grok-4.6'), 256_000);
  assert.equal(resolveModelContextWindow('grok-3-mini'), 131_072);
});

test('an unknown model gets the smallest defensible window, never zero', () => {
  // The regression this table exists to prevent: unknown → no window → no
  // auto-compaction, ever. No model in the desktop settings carried a
  // contextWindow, so compaction never ran once in real use.
  const window = resolveModelContextWindow('some-brand-new-model-9000');
  assert.equal(window, FALLBACK_CONTEXT_WINDOW_TOKENS);
  assert.ok(window > 0, 'an unknown model must still produce a usable window');
  assert.equal(resolveModelContextWindow(undefined), FALLBACK_CONTEXT_WINDOW_TOKENS);
});

test('table order decides overlapping patterns (narrower first)', () => {
  // glm-4.5 must not match the glm-5/6 rule, and gpt-4.1 must not match gpt-4o.
  assert.equal(resolveModelContextWindow('glm-4.5-air'), 128_000);
  assert.equal(resolveModelContextWindow('gpt-4.1'), 1_000_000);
  assert.equal(resolveModelContextWindow('gpt-4o'), 128_000);
});

test('the derived limits match the codex formulas', () => {
  // codex: auto_compact_token_limit = window * 9/10;
  //        usable_context_window    = window * effective_context_window_percent/100
  assert.equal(AUTO_COMPACT_WINDOW_FRACTION, 0.9);
  assert.equal(EFFECTIVE_CONTEXT_WINDOW_PERCENT, 95);
  assert.equal(autoCompactTokenLimit(200_000), 180_000);
  assert.equal(effectiveContextWindow(200_000), 190_000);
  // Compacting at 90% must leave the summary request room to run.
  assert.ok(autoCompactTokenLimit(200_000) < effectiveContextWindow(200_000));
});
