const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createKeybindingsStore, sanitizeMap } = require('../electron/keybindings-store.cjs');

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-kb-'));
  const store = createKeybindingsStore(dir);
  return { dir, store, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('sanitizeMap keeps only string entries with valid ids', () => {
  const out = sanitizeMap({
    'quick-open': 'Ctrl+O',
    'BAD ID!': 'Ctrl+X',
    'UPPER-CASE': 'Ctrl+Y',
    ok2: 42,
    ok3: '   ',
    ok4: 'Ctrl+Shift+Z',
  });
  assert.deepEqual(out, { 'quick-open': 'Ctrl+O', ok4: 'Ctrl+Shift+Z' });
});

test('sanitizeMap survives non-object input', () => {
  assert.deepEqual(sanitizeMap(null), {});
  assert.deepEqual(sanitizeMap([]), {});
  assert.deepEqual(sanitizeMap('x'), {});
});

test('setOne persists and getAll returns the map', async () => {
  const fx = await fixture();
  try {
    const r = await fx.store.setOne('palette', 'Ctrl+Shift+Space');
    assert.equal(r.ok, true);
    assert.deepEqual(await fx.store.getAll(), { palette: 'Ctrl+Shift+Space' });
    const raw = JSON.parse(await readFile(path.join(fx.dir, 'keybindings.json'), 'utf8'));
    assert.equal(raw.palette, 'Ctrl+Shift+Space');
  } finally { await fx.cleanup(); }
});

test('setOne with empty chord removes the override', async () => {
  const fx = await fixture();
  try {
    await fx.store.setOne('palette', 'Ctrl+K');
    await fx.store.setOne('palette', '');
    assert.deepEqual(await fx.store.getAll(), {});
  } finally { await fx.cleanup(); }
});

test('setOne rejects illegal ids', async () => {
  const fx = await fixture();
  try {
    const r = await fx.store.setOne('../evil', 'Ctrl+K');
    assert.equal(r.ok, false);
    assert.deepEqual(await fx.store.getAll(), {});
  } finally { await fx.cleanup(); }
});

test('corrupt file heals to empty and remains writable', async () => {
  const fx = await fixture();
  try {
    await writeFile(path.join(fx.dir, 'keybindings.json'), 'not json{', 'utf8');
    assert.deepEqual(await fx.store.getAll(), {});
    const r = await fx.store.setOne('settings', 'Ctrl+Shift+Comma');
    assert.equal(r.ok, true);
    assert.deepEqual(await fx.store.getAll(), { settings: 'Ctrl+Shift+Comma' });
  } finally { await fx.cleanup(); }
});

test('missing file heals to empty', async () => {
  const fx = await fixture();
  try {
    assert.deepEqual(await fx.store.getAll(), {});
  } finally { await fx.cleanup(); }
});

test('replaceAll swaps the whole map and caps values', async () => {
  const fx = await fixture();
  try {
    await fx.store.setOne('palette', 'Ctrl+K');
    const r = await fx.store.replaceAll({ 'new-chat': 'Ctrl+Shift+N'.padEnd(40, '!'), 'BAD ID!': 'x', 'a-b': 'A+B' });
    assert.equal(r.ok, true);
    assert.equal(r.count, 2); // BAD ID! rejected
    const all = await fx.store.getAll();
    assert.equal(all['new-chat'].length, 32); // capped
    assert.ok(all['a-b']);
    assert.equal(all.palette, undefined);
  } finally { await fx.cleanup(); }
});

test('reload from disk in a fresh store instance', async () => {
  const fx = await fixture();
  try {
    await fx.store.setOne('browser', 'Ctrl+Alt+B');
    const again = createKeybindingsStore(fx.dir);
    assert.deepEqual(await again.getAll(), { browser: 'Ctrl+Alt+B' });
  } finally { await fx.cleanup(); }
});
