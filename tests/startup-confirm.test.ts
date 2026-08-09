import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmProviderStart } from '../src/cli/startupConfirm.js';
import type { AppConfig } from '../src/config/types.js';
import type { Provider } from '../src/providers/types.js';

const baseConfig: AppConfig = {
  provider: 'openai',
  model: 'grok-4.5',
  baseUrl: 'https://yunqiaoai.dpdns.org/v1',
  approval: 'ask',
  workspaceRoot: 'C:\\test',
  sessionDir: 'C:\\test\\.aicode\\sessions',
  maxSteps: 24,
  noBanner: false,
};

const provider: Provider = {
  name: 'openai',
  model: 'grok-4.5',
  complete: async () => ({ actions: [] }),
};

// Helper: create a config variant.
function cfg(overrides: Partial<AppConfig>): AppConfig {
  return { ...baseConfig, ...overrides };
}

test('confirmProviderStart skips when --prompt is set', async () => {
  // Should return true immediately without blocking on stdin.
  const result = await confirmProviderStart(cfg({ prompt: 'hello' }), provider);
  assert.equal(result, true);
});

test('confirmProviderStart skips when --ci is set', async () => {
  const result = await confirmProviderStart(cfg({ ci: true }), provider);
  assert.equal(result, true);
});

test('confirmProviderStart skips when --json is set', async () => {
  const result = await confirmProviderStart(cfg({ json: true }), provider);
  assert.equal(result, true);
});

test('confirmProviderStart skips when --quiet is set', async () => {
  const result = await confirmProviderStart(cfg({ quiet: true }), provider);
  assert.equal(result, true);
});

test('confirmProviderStart skips when noBanner is set', async () => {
  const result = await confirmProviderStart(cfg({ noBanner: true }), provider);
  assert.equal(result, true);
});

test('confirmProviderStart skips when --desktop-bridge is set', async () => {
  const result = await confirmProviderStart(cfg({ desktopBridge: true }), provider);
  assert.equal(result, true);
});

test('confirmProviderStart skips when stdout is not a TTY (CI / piped)', async () => {
  // In the test runner stdout.isTTY is typically falsy — this verifies the guard.
  // If somehow isTTY is true in a local run, the test would block, so we patch it.
  const origIsTTY = process.stdout.isTTY;
  (process.stdout as { isTTY: boolean | undefined }).isTTY = false;
  try {
    const result = await confirmProviderStart(baseConfig, provider);
    assert.equal(result, true);
  } finally {
    (process.stdout as { isTTY: boolean | undefined }).isTTY = origIsTTY;
  }
});
