const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSecretStore, redactKey } = require('../electron/secret-store.cjs');

test('redactKey never returns the full key', () => {
  assert.equal(redactKey('sk-1234567890'), 'configured:7890');
  assert.equal(redactKey(''), 'missing');
});

test('secret store persists encrypted strings through injected safe storage', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-secrets-'));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
  const store = createSecretStore({ userDataDir: dir, safeStorage: fakeSafeStorage });
  await store.setApiKey('openai', 'sk-test-value');

  assert.deepEqual(await store.hasApiKey('openai'), { configured: true, hint: 'configured:alue' });
  assert.equal(await store.getApiKey('openai'), 'sk-test-value');

  await rm(dir, { recursive: true, force: true });
});
