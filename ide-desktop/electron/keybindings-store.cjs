'use strict';
/**
 * User-defined keyboard shortcut overrides (iteration 19), persisted in
 * userData/keybindings.json as { actionId: "Ctrl+Shift+P" }. Validation lives
 * in the renderer (src/lib/keybindings.ts); this store only sanitises shapes
 * — object of string->string, keys matching ^[a-z0-9-]+$, values <= 32 chars.
 */
const path = require('node:path');
const { createJsonStore } = require('./json-store.cjs');

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
  // Durable plumbing lives in json-store.cjs: atomic replace, rename retry,
  // corrupt-file quarantine, serialized mutations.
  const store = createJsonStore({ file: () => file, normalize: sanitizeMap });
  async function getAll() {
    return store.inspect((current) => ({ ...current }));
  }

  /** Set one override; empty/null removes it (falls back to default). */
  async function setOne(actionId, chord) {
    if (!ID_RE.test(String(actionId))) return { ok: false, error: '非法的快捷键 ID' };
    return store.mutate((current) => {
      const v = typeof chord === 'string' ? chord.trim().slice(0, 32) : '';
      if (!v) delete current[actionId];
      else current[actionId] = v;
      return { ok: true, actionId, chord: v || null };
    });
  }

  async function replaceAll(rawMap) {
    return store.mutate((current) => {
      const next = sanitizeMap(rawMap);
      for (const key of Object.keys(current)) delete current[key];
      Object.assign(current, next);
      return { ok: true, count: Object.keys(next).length };
    });
  }

  return { getAll, setOne, replaceAll };
}

module.exports = { createKeybindingsStore, sanitizeMap };
