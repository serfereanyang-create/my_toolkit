const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createSettingsStore } = require('../electron/settings-store.cjs');

/*
 * 沙箱模式 was retired into 审批模式, because the two were separate knobs that
 * could contradict each other: approval reached the CLI while the sandbox mode
 * lived only in the main process. A stored `gen.sandboxMode` would now be
 * silently ignored, so it is migrated onto the approval mode instead — a user
 * who had picked 严格 must not quietly lose the protection it gave.
 */

async function withStore(settings, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-settings-'));
  const file = path.join(dir, 'settings.json');
  if (settings) await writeFile(file, JSON.stringify(settings), 'utf8');
  try {
    await fn(createSettingsStore(dir), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a stored 严格 sandbox mode migrates to the read-only approval mode', async () => {
  await withStore({ approval: 'ask', preferences: { 'gen.sandboxMode': 'strict' } }, async (store) => {
    const settings = await store.get();
    assert.equal(settings.approval, 'deny');
    assert.equal('gen.sandboxMode' in settings.preferences, false, 'the retired key is dropped');
  });
});

test('a stored 工作区 sandbox mode migrates to ask', async () => {
  await withStore({ approval: 'ask', preferences: { 'gen.sandboxMode': 'workspace' } }, async (store) => {
    const settings = await store.get();
    assert.equal(settings.approval, 'ask');
    assert.equal('gen.sandboxMode' in settings.preferences, false);
  });
});

test('sandbox mode off leaves the approval mode alone', async () => {
  await withStore({ approval: 'auto', preferences: { 'gen.sandboxMode': 'off' } }, async (store) => {
    const settings = await store.get();
    assert.equal(settings.approval, 'auto');
    assert.equal('gen.sandboxMode' in settings.preferences, false);
  });
});

test('an explicit approval choice outranks the legacy sandbox mode', async () => {
  // Someone who deliberately picked 完全访问 after the change must not be pushed
  // back to 只读 by a preference they set before it.
  await withStore({ approval: 'auto', preferences: { 'gen.sandboxMode': 'strict' } }, async (store) => {
    const settings = await store.get();
    assert.equal(settings.approval, 'auto');
    assert.equal('gen.sandboxMode' in settings.preferences, false);
  });
});

test('settings without the legacy key are untouched', async () => {
  await withStore({ approval: 'plan', preferences: { theme: 'dark' } }, async (store) => {
    const settings = await store.get();
    assert.equal(settings.approval, 'plan');
    assert.equal(settings.preferences.theme, 'dark');
  });
});

test('a missing settings file still yields defaults', async () => {
  await withStore(null, async (store) => {
    const settings = await store.get();
    assert.equal(settings.approval, 'ask');
  });
});
