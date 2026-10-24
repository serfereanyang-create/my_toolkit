const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
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

// secrets.json holds every provider key at once, so the old read-modify-write
// with an in-place writeFile had three ways to destroy them: a torn document
// made every later save throw (permanently), the torn copy was not preserved,
// and two concurrent saves kept only the last key.
test('a torn secrets file is set aside so saving works again and the blobs survive', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-secrets-'));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
  const store = createSecretStore({ userDataDir: dir, safeStorage: fakeSafeStorage });
  const file = path.join(dir, 'secrets.json');
  const torn = '{\n  "openai": "ZW5j';
  await writeFile(file, torn, 'utf8');

  await store.setApiKey('anthropic', 'sk-new-value');
  assert.equal(await store.getApiKey('anthropic'), 'sk-new-value');

  const entries = await readdir(dir);
  const preserved = entries.filter((name) => name.includes('secrets.json.corrupt-'));
  assert.equal(preserved.length, 1, 'the recoverable copy is kept');
  assert.equal(await readFile(path.join(dir, preserved[0]), 'utf8'), torn);

  await rm(dir, { recursive: true, force: true });
});

test('concurrent key saves keep every provider', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-secrets-'));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => buffer.toString('utf8').replace(/^enc:/, ''),
  };
  const store = createSecretStore({ userDataDir: dir, safeStorage: fakeSafeStorage });

  await Promise.all([
    store.setApiKey('provider-x', 'sk-x'),
    store.setApiKey('provider-y', 'sk-y'),
    store.setApiKey('provider-z', 'sk-z'),
  ]);

  const parsed = JSON.parse(await readFile(path.join(dir, 'secrets.json'), 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['provider-x', 'provider-y', 'provider-z']);
  assert.equal(await store.getApiKey('provider-y'), 'sk-y');

  await rm(dir, { recursive: true, force: true });
});

test('a key the OS can no longer decrypt reads as not configured instead of throwing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-secrets-'));
  const fakeSafeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (buffer) => {
      if (buffer.toString('utf8').startsWith('enc:')) return buffer.toString('utf8').replace(/^enc:/, '');
      throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
    },
  };
  await writeFile(path.join(dir, 'secrets.json'), `${JSON.stringify({ openai: Buffer.from('rotated-blob').toString('base64') })}\n`, 'utf8');
  const store = createSecretStore({ userDataDir: dir, safeStorage: fakeSafeStorage });

  assert.equal(await store.getApiKey('openai'), '');
  assert.deepEqual(await store.hasApiKey('openai'), { configured: false, hint: 'missing' });

  await rm(dir, { recursive: true, force: true });
});
