const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSettingsStore } = require('../electron/settings-store.cjs');

async function withStore(check) {
  const dir = await mkdtemp(path.join(tmpdir(), 'yoy-settings-race-'));
  try {
    await check(createSettingsStore(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('concurrent preference patches preserve every change after reopening', async () => {
  await withStore(async (store, dir) => {
    await Promise.all(Array.from({ length: 20 }, (_, index) =>
      store.set({ preferences: { [`choice-${index}`]: index } })));
    const reopened = await createSettingsStore(dir).get();
    for (let index = 0; index < 20; index += 1) {
      assert.equal(reopened.preferences[`choice-${index}`], index);
    }
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
    assert.doesNotThrow(() => JSON.parse(require('node:fs').readFileSync(path.join(dir, 'settings.json'), 'utf8')));
  });
});

test('concurrent recent-workspace updates preserve all entries in call order', async () => {
  await withStore(async (store) => {
    await Promise.all(['first', 'second', 'third'].map((root) => store.addRecentWorkspace(root)));
    assert.deepEqual((await store.get()).recentWorkspaces, ['third', 'second', 'first']);
  });
});

test('clearing one preference replaces that key as a whole without clearing the others', async () => {
  await withStore(async (store, dir) => {
    await store.set({ preferences: { theme: 'dark', reasoningEffortByModel: { 'vendor/model': 'high' } } });
    // Per-key replacement, not a deep merge: the empty record must survive as
    // an empty record instead of keeping the model that was cleared.
    await store.set({ preferences: { reasoningEffortByModel: {} } });
    const stored = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    assert.deepEqual(stored.preferences.reasoningEffortByModel, {});
    assert.equal(stored.preferences.theme, 'dark');
  });
});

test('get waits for pending writes and set captures its argument at submission', async () => {
  await withStore(async (store) => {
    const next = { preferences: { theme: 'dark' } };
    const saving = store.set(next);
    next.preferences.theme = 'light';
    assert.equal((await store.get()).preferences.theme, 'dark');
    await saving;
  });
});

test('a failed write leaves the previous settings and does not poison subsequent writes', async () => {
  await withStore(async (store) => {
    await store.set({ preferences: { theme: 'dark' } });
    await assert.rejects(store.set({ invalid: 1n }), /BigInt/);
    assert.equal((await store.get()).preferences.theme, 'dark');
    await store.set({ approval: 'deny' });
    assert.equal((await store.get()).approval, 'deny');
  });
});

// settings.json is the only copy of the provider list, base URLs, custom prices
// and preferences. An unreadable one used to be replaced by defaults on the
// next save with nothing kept, and a wrong-shaped collection field made every
// later save reject — the app then ran on stale in-memory values and silently
// stopped persisting anything.
test('an unreadable settings file is preserved before a save replaces it', async () => {
  await withStore(async (store, dir) => {
    const file = path.join(dir, 'settings.json');
    const torn = '{\n  "activeProviderId": "myrelay",\n  "providers": [{"id": "myrel';
    await writeFile(file, torn, 'utf8');

    // Reads do not touch it: the app still starts on defaults.
    assert.equal((await store.get()).providers.some((p) => p.id === 'myrelay'), false);
    assert.equal(await readFile(file, 'utf8'), torn, 'a read never rewrites the file');

    await store.addRecentWorkspace('C:/work/two');

    const preserved = (await readdir(dir)).filter((name) => name.includes('settings.json.corrupt-'));
    assert.equal(preserved.length, 1, 'the unreadable copy is kept for recovery');
    assert.equal(await readFile(path.join(dir, preserved[0]), 'utf8'), torn);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.recentWorkspaces, ['C:/work/two']);
  });
});

test('a wrong-shaped collection field does not wedge every later save', async () => {
  await withStore(async (store, dir) => {
    const file = path.join(dir, 'settings.json');
    await writeFile(file, JSON.stringify({ preferences: { keep: 1 }, recentWorkspaces: null, providers: null }), 'utf8');

    await store.addRecentWorkspace('C:/work/three');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.recentWorkspaces, ['C:/work/three']);
    assert.equal(saved.preferences.keep, 1);
    assert.ok(Array.isArray(saved.providers) && saved.providers.length > 0, 'providers fall back to the defaults');
  });
});
