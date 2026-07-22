import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveLiveSmokePlan, runLiveSmoke } from '../src/cli/liveSmoke.js';

test('resolveLiveSmokePlan skips when no credentials', () => {
  const plan = resolveLiveSmokePlan({});
  assert.equal(plan.mode, 'skip');
  assert.match(plan.reason, /skipping live smoke/i);
});

test('resolveLiveSmokePlan prefers openai when key present', () => {
  const plan = resolveLiveSmokePlan({ OPENAI_API_KEY: 'sk-test' });
  assert.equal(plan.mode, 'run');
  assert.equal(plan.provider, 'openai');
});

test('resolveLiveSmokePlan can be force-disabled', () => {
  const plan = resolveLiveSmokePlan({ OPENAI_API_KEY: 'sk-test', AICODE_LIVE_SMOKE: '0' });
  assert.equal(plan.mode, 'skip');
});

test('resolveLiveSmokePlan fails closed when forced without key', () => {
  const plan = resolveLiveSmokePlan({ AICODE_LIVE_SMOKE: '1', AICODE_PROVIDER: 'openai' });
  assert.equal(plan.mode, 'run');
  assert.equal(plan.provider, 'openai');
  assert.match(plan.reason, /required but missing/i);
});

test('runLiveSmoke skips without network when no key', async () => {
  const result = await runLiveSmoke({ AICODE_LIVE_SMOKE: 'skip' });
  assert.equal(result.status, 'skipped');
});
