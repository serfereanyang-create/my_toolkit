const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSettingsStore } = require('../electron/settings-store.cjs');

test('custom providers with apiFormat + models round-trip through the settings store', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-modelset-'));
  const store = createSettingsStore(dir);

  const base = await store.get();
  const custom = {
    id: 'custom_yunqiao',
    type: 'custom',
    label: '云桥',
    model: 'claude-opus-4-7',
    baseUrl: 'https://yunqiaoai.dpdns.org',
    apiFormat: 'anthropic',
    models: [
      { id: 'gpt-5.6-sol', contextWindow: 660000 },
      { id: 'claude-opus-4-7', contextWindow: 550000 },
    ],
  };

  await store.set({ providers: [...base.providers, custom], activeProviderId: 'custom_yunqiao' });

  // Fresh store instance (simulates app restart) reads the same file.
  const reopened = createSettingsStore(dir);
  const persisted = await reopened.get();

  assert.equal(persisted.activeProviderId, 'custom_yunqiao');
  const found = persisted.providers.find((p) => p.id === 'custom_yunqiao');
  assert.ok(found, 'custom provider persisted');
  assert.equal(found.type, 'custom');
  assert.equal(found.label, '云桥');
  assert.equal(found.apiFormat, 'anthropic');
  assert.equal(found.baseUrl, 'https://yunqiaoai.dpdns.org');
  assert.equal(found.models.length, 2);
  assert.equal(found.models[0].id, 'gpt-5.6-sol');
  assert.equal(found.models[0].contextWindow, 660000);

  await rm(dir, { recursive: true, force: true });
});

test('removing a custom provider and reassigning active persists', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-modelset-'));
  const store = createSettingsStore(dir);
  const base = await store.get();

  const a = { id: 'custom_a', type: 'custom', label: 'A', model: 'm', baseUrl: 'https://a', apiFormat: 'openai', models: [{ id: 'm' }] };
  const b = { id: 'custom_b', type: 'custom', label: 'B', model: 'n', baseUrl: 'https://b', apiFormat: 'openai', models: [{ id: 'n' }] };
  await store.set({ providers: [...base.providers, a, b], activeProviderId: 'custom_a' });

  // Remove custom_a and reassign active to custom_b.
  const cur = await store.get();
  const remaining = cur.providers.filter((p) => p.id !== 'custom_a');
  await store.set({ providers: remaining, activeProviderId: 'custom_b' });

  const persisted = await createSettingsStore(dir).get();
  assert.equal(persisted.providers.some((p) => p.id === 'custom_a'), false);
  assert.equal(persisted.activeProviderId, 'custom_b');

  await rm(dir, { recursive: true, force: true });
});
