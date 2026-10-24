'use strict';
/*
 * The shared JSON sidecar store: atomic replace, corrupt-file quarantine, and
 * serialized read-modify-write. Every desktop store built on it inherits these,
 * so they are tested here once instead of per store.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createJsonStore } = require('../electron/json-store.cjs');

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-jsonstore-'));
  return { dir, file: path.join(dir, 'state.json'), cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

test('a corrupt file is moved aside, not silently erased by the next write', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(fx.file, '{"keep":["me"', 'utf8');
    const store = createJsonStore({ file: () => fx.file });

    assert.deepEqual(await store.read(), {}, 'an unreadable file reads as empty');
    const kept = (await fs.readdir(fx.dir)).filter((name) => name.includes('.corrupt-'));
    assert.equal(kept.length, 1, 'the original bytes still exist on disk');
    assert.match(await fs.readFile(path.join(fx.dir, kept[0]), 'utf8'), /keep/);

    await store.mutate((data) => { data.fresh = true; return true; });
    assert.deepEqual(JSON.parse(await fs.readFile(fx.file, 'utf8')), { fresh: true });
  } finally {
    await fx.cleanup();
  }
});

test('an empty file is not quarantined: there is nothing to recover', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(fx.file, '', 'utf8');
    const store = createJsonStore({ file: () => fx.file });
    await store.mutate((data) => { data.ok = 1; return true; });
    const names = await fs.readdir(fx.dir);
    assert.equal(names.filter((name) => name.includes('.corrupt-')).length, 0);
  } finally {
    await fx.cleanup();
  }
});

test('concurrent mutations on one file all land', async () => {
  const fx = await fixture();
  try {
    const store = createJsonStore({ file: () => fx.file, empty: () => ({ keys: [] }) });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.mutate((data) => {
        data.keys.push(i);
        return i;
      })),
    );
    const saved = JSON.parse(await fs.readFile(fx.file, 'utf8'));
    assert.equal(saved.keys.length, 20, 'no read-modify-write pair interleaves');
    assert.deepEqual([...saved.keys].sort((a, b) => a - b), [...Array(20).keys()]);
    const names = await fs.readdir(fx.dir);
    assert.equal(names.filter((name) => name.endsWith('.tmp')).length, 0, 'no temp file is left behind');
  } finally {
    await fx.cleanup();
  }
});

test('a read waits for a pending write instead of returning stale data', async () => {
  const fx = await fixture();
  try {
    const store = createJsonStore({ file: () => fx.file, empty: () => ({ n: 0 }) });
    const write = store.mutate((data) => { data.n = 7; return true; });
    const read = store.inspect((data) => data.n);
    assert.equal(await read, 7);
    await write;
  } finally {
    await fx.cleanup();
  }
});

test('no workspace open: reads are empty, mutations reject', async () => {
  const fx = await fixture();
  try {
    const store = createJsonStore({
      file: () => { throw new Error('No workspace open'); },
      empty: () => ({ items: [] }),
    });
    assert.deepEqual(await store.read(), { items: [] });
    assert.equal(await store.inspect((data) => data.items.length), 0);
    await assert.rejects(() => store.mutate((data) => { data.items.push(1); return true; }), /No workspace open/);
  } finally {
    await fx.cleanup();
  }
});

test('normalize runs on every read, so a hand-edited file cannot leak junk', async () => {
  const fx = await fixture();
  try {
    await fs.writeFile(fx.file, JSON.stringify({ good: 1, bad: 'x' }), 'utf8');
    const store = createJsonStore({
      file: () => fx.file,
      normalize: (parsed) => (parsed && typeof parsed.good === 'number' ? { good: parsed.good } : {}),
    });
    assert.deepEqual(await store.read(), { good: 1 });
  } finally {
    await fx.cleanup();
  }
});
