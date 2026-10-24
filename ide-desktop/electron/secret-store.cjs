const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteText } = require('./atomic-file.cjs');
const { quarantine, serialize } = require('./json-store.cjs');

function createSecretStore({ userDataDir, safeStorage }) {
  const file = path.join(userDataDir, 'secrets.json');

  /**
   * Every encrypted key the app holds lives in this one file, so all three of
   * its old behaviours were fatal rather than annoying:
   *
   *   - it was written in place, so a crash between truncate and write left a
   *     half document — and then `readAll` rethrew the parse error, which made
   *     every later save fail forever with a SyntaxError the user cannot act on;
   *   - the torn document was never preserved, so the still-decryptable keys
   *     inside it were gone;
   *   - read-modify-write without a queue meant two providers saved in the same
   *     tick kept only the last one.
   *
   * Now: writes are atomic, a file that exists but cannot be READ still throws
   * (writing over it would destroy keys we simply failed to load), a file that
   * exists but cannot be PARSED is moved aside so the blobs can be recovered,
   * and mutations run one at a time per file.
   */
  async function readAll() {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return {};
      throw error;
    }
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      await quarantine(file);
      return {};
    }
  }

  async function writeAll(value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Read, edit, write — serialized per file so a save cannot drop another. */
  function update(edit) {
    return serialize(file, async () => {
      const all = await readAll();
      const result = await edit(all);
      await writeAll(all);
      return result;
    });
  }

  function assertEncryption() {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) throw new Error('Electron safeStorage encryption is not available');
  }

  async function setApiKey(providerId, apiKey) {
    assertEncryption();
    const encrypted = safeStorage.encryptString(apiKey).toString('base64');
    return await update((all) => {
      all[providerId] = encrypted;
      return { configured: true, hint: redactKey(apiKey) };
    });
  }

  async function getApiKey(providerId) {
    assertEncryption();
    const all = await readAll();
    const stored = all[providerId];
    if (!stored) return '';
    try {
      return safeStorage.decryptString(Buffer.from(stored, 'base64'));
    } catch {
      // A blob the OS can no longer decrypt (a profile change resets the DPAPI
      // key) must read as "not configured": throwing here took the whole
      // provider list down instead of letting the user paste a new key.
      return '';
    }
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
