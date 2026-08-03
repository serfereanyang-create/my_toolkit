const fs = require('node:fs/promises');
const path = require('node:path');

function createSecretStore({ userDataDir, safeStorage }) {
  const file = path.join(userDataDir, 'secrets.json');

  async function readAll() {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      throw error;
    }
  }

  async function writeAll(value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
  }

  function assertEncryption() {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage encryption is not available');
  }

  async function setApiKey(providerId, apiKey) {
    assertEncryption();
    const all = await readAll();
    all[providerId] = safeStorage.encryptString(apiKey).toString('base64');
    await writeAll(all);
    return { configured: true, hint: redactKey(apiKey) };
  }

  async function getApiKey(providerId) {
    assertEncryption();
    const all = await readAll();
    const stored = all[providerId];
    if (!stored) return '';
    return safeStorage.decryptString(Buffer.from(stored, 'base64'));
  }

  async function hasApiKey(providerId) {
    const key = await getApiKey(providerId);
    return { configured: Boolean(key), hint: redactKey(key) };
  }

  return { setApiKey, getApiKey, hasApiKey };
}

function redactKey(value) {
  if (!value) return 'missing';
  return `configured:${value.slice(-4)}`;
}

module.exports = { createSecretStore, redactKey };
