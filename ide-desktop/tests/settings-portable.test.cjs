'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  exportSettingsBundle,
  importSettingsBundle,
  redactProvider,
  BUNDLE_VERSION,
} = require('../electron/settings-portable.cjs');

test('export never includes API key material', () => {
  const bundle = exportSettingsBundle({
    preferences: { theme: 'dark', uiFontSize: 15 },
    providers: [
      { id: 'p1', name: 'Main', model: 'glm-5.3', apiKey: 'sk-secret-value' },
      { id: 'p2', name: 'Backup', model: 'deepseek-v4.1' },
    ],
  });
  assert.equal(bundle.bundleVersion, BUNDLE_VERSION);
  assert.equal(bundle.providers[0].hasApiKey, true);
  assert.equal(bundle.providers[1].hasApiKey, false);
  assert.equal(JSON.stringify(bundle).includes('sk-secret-value'), false);
  assert.ok(!('apiKey' in bundle.providers[0]));
});

test('redactProvider keeps other fields intact', () => {
  const redacted = redactProvider({ id: 'x', name: 'X', apiKey: 'k', baseUrl: 'https://api.example.com' });
  assert.deepEqual(redacted, { id: 'x', name: 'X', baseUrl: 'https://api.example.com', hasApiKey: true });
});

test('import merges preferences and preserves local API keys', () => {
  const current = {
    preferences: { theme: 'light', uiFontSize: 14 },
    providers: [
      { id: 'p1', name: 'Main', model: 'old-model', apiKey: 'local-key' },
    ],
  };
  const bundle = {
    bundleVersion: 1,
    exportedAt: '2026-09-25T00:00:00.000Z',
    preferences: { theme: 'dark', newPref: true },
    providers: [
      { id: 'p1', name: 'Main', model: 'glm-5.3', hasApiKey: true },
      { id: 'p2', name: 'New', model: 'kimi-k2.5', hasApiKey: false },
    ],
  };
  const { settings, report } = importSettingsBundle(bundle, current);
  assert.equal(settings.preferences.theme, 'dark');
  assert.equal(settings.preferences.newPref, true);
  assert.equal(settings.preferences.uiFontSize, 14, 'local-only prefs survive');
  const p1 = settings.providers.find((p) => p.id === 'p1');
  assert.equal(p1.model, 'glm-5.3', 'bundle fields update the provider');
  assert.equal(p1.apiKey, 'local-key', 'local key never replaced');
  assert.equal(settings.providers.find((p) => p.id === 'p2').apiKey, undefined);
  assert.deepEqual(report, { providersAdded: 1, providersUpdated: 1, skipped: 0 });
});

test('import rejects malformed bundles instead of corrupting settings', () => {
  const current = { preferences: {}, providers: [] };
  assert.throws(() => importSettingsBundle(null, current), /Unsupported settings bundle/);
  assert.throws(() => importSettingsBundle({ bundleVersion: 99 }, current), /Unsupported settings bundle/);
  assert.throws(() => importSettingsBundle({ bundleVersion: 1, preferences: 'nope' }, current), /preferences must be an object/);
  assert.throws(() => importSettingsBundle({ bundleVersion: 1, providers: 'nope' }, current), /providers must be an array/);
});

test('import skips provider entries without a usable id', () => {
  const bundle = { bundleVersion: 1, preferences: {}, providers: [{ name: 'no id' }, null, { id: 'ok' }] };
  const { settings, report } = importSettingsBundle(bundle, { preferences: {}, providers: [] });
  assert.equal(settings.providers.length, 1);
  assert.equal(settings.providers[0].id, 'ok');
  assert.equal(report.skipped, 2);
});
