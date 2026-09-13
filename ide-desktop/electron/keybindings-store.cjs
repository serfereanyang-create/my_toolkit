'use strict';
/**
 * User-defined keyboard shortcut overrides (iteration 19), persisted in
 * userData/keybindings.json as { actionId: "Ctrl+Shift+P" }. Validation lives
 * in the renderer (src/lib/keybindings.ts); this store only sanitises shapes
 * — object of string->string, keys matching ^[a-z0-9-]+$, values <= 32 chars.
 */
const fs = require('node:fs/promises');
const path = require('node:path');

const ID_RE = /^[a-z0-9-]{1,40}$/;

function sanitizeMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!ID_RE.test(key)) continue;
    if (typeof value !== 'string') continue;
    const v = value.trim().slice(0, 32);
    if (!v) continue;
    out[key] = v;
  }
  return out;
}

function createKeybindingsStore(userDataDir) {
  const file = path.join(userDataDir, 'keybindings.json');
  let chain = Promise.resolve();
  let cache = null; // Map-like plain object, loaded lazily

  async function loadLocked() {
    if (cache) return;
    cache = {};
    try {
      cache = sanitizeMap(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch { /* missing or corrupt file heals to empty */ }
  }

  async function saveLocked() {
    await fs.mkdir(userDataDir, { recursive: true });
    const tmp = file + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  function mutate(fn) {
    const run = chain.then(async () => {
      await loadLocked();
      const out = await fn();
      return out;
    });
    // Swallow errors on the chain itself; the caller sees the rejection.
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  async function getAll() {
    return mutate(async () => ({ ...cache }));
  }

  /** Set one override; empty/null removes it (falls back to default). */
  async function setOne(actionId, chord) {
    if (!ID_RE.test(String(actionId))) return { ok: false, error: '非法的快捷键 ID' };
    return mutate(async () => {
      const v = typeof chord === 'string' ? chord.trim().slice(0, 32) : '';
      if (!v) delete cache[actionId];
      else cache[actionId] = v;
      await saveLocked();
      return { ok: true, actionId, chord: v || null };
    });
  }

  async function replaceAll(rawMap) {
    return mutate(async () => {
      cache = sanitizeMap(rawMap);
      await saveLocked();
      return { ok: true, count: Object.keys(cache).length };
    });
  }

  return { getAll, setOne, replaceAll };
}

module.exports = { createKeybindingsStore, sanitizeMap };
