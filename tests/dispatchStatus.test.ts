import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatDispatchStatus } from '../src/dispatch/dispatchLedger.js';
import { DISPATCH_TIER_LABELS } from '../src/dispatch/tierRouter.js';

test('formatDispatchStatus names all three tiers distinctly', () => {
  assert.equal(formatDispatchStatus('plan', 'expensive', 'p', 'm'), '[plan] 贵档 · p/m');
  assert.equal(formatDispatchStatus('plan', 'standard', 'p', 'm'), '[plan] 中档 · p/m');
  assert.equal(formatDispatchStatus('plan', 'cheap', 'p', 'm'), '[plan] 便宜档 · p/m');
  // The exact regression: standard used to render as 便宜档.
  assert.notEqual(DISPATCH_TIER_LABELS.standard, DISPATCH_TIER_LABELS.cheap);
});
