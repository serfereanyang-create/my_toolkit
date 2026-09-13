const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { catalog, status, validateDefinition, PLUGIN_CATALOG } = require('../electron/plugin-registry.cjs');

test('catalog exposes every plugin with required fields', () => {
  const defs = catalog();
  assert.ok(defs.length >= 18);
  for (const def of defs) {
    assert.equal(typeof def.id, 'string');
    assert.equal(typeof def.name, 'string');
    assert.equal(typeof def.desc, 'string');
    assert.ok(['none', 'workspace', 'git', 'platform'].includes(def.requires));
    assert.equal(validateDefinition(def), null);
  }
});

test('catalog returns copies, not live references', () => {
  const a = catalog();
  a[0].name = 'mutated';
  assert.notEqual(catalog()[0].name, 'mutated');
});

test('status without workspace gates workspace/git plugins', () => {
  const s = status(null, 'win32');
  const byId = new Map(s.plugins.map((p) => [p.id, p]));
  assert.equal(byId.get('documents').available, true);
  assert.equal(byId.get('bookmarks').available, false);
  assert.match(byId.get('bookmarks').reason, /工作区/);
  assert.equal(byId.get('git').available, false);
});

test('status with plain workspace unlocks workspace plugins but not git', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-plug-'));
  try {
    const s = status(root, 'win32');
    const byId = new Map(s.plugins.map((p) => [p.id, p]));
    assert.equal(byId.get('census').available, true);
    assert.equal(byId.get('git').available, false);
    assert.equal(s.hasGit, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('status with .git unlocks git plugin', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'zcode-plug-'));
  try {
    await mkdir(path.join(root, '.git'));
    const s = status(root, 'win32');
    const byId = new Map(s.plugins.map((p) => [p.id, p]));
    assert.equal(byId.get('git').available, true);
    assert.equal(s.hasGit, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('platform gating honours the passed platform', () => {
  const win = status(null, 'win32');
  const mac = status(null, 'darwin');
  const winById = new Map(win.plugins.map((p) => [p.id, p]));
  const macById = new Map(mac.plugins.map((p) => [p.id, p]));
  assert.equal(winById.get('computer').available, true);
  assert.equal(macById.get('computer').available, false);
  assert.match(macById.get('computer').reason, /系统/);
});

test('validateDefinition rejects malformed entries', () => {
  assert.ok(validateDefinition(null));
  assert.ok(validateDefinition({ id: 'BAD ID', name: 'x', desc: 'y', requires: 'none' }));
  assert.ok(validateDefinition({ id: 'ok', name: '', desc: 'y', requires: 'none' }));
  assert.ok(validateDefinition({ id: 'ok', name: 'x', desc: 'y', requires: 'magic' }));
  assert.ok(validateDefinition({ id: 'ok', name: 'x', desc: 'y', requires: 'platform' }));
  assert.equal(validateDefinition({ id: 'ok', name: 'x', desc: 'y', requires: 'platform', platforms: ['win32'] }), null);
});

test('PLUGIN_CATALOG ids are unique', () => {
  const ids = PLUGIN_CATALOG.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
