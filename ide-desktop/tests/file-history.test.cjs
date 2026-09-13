const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createFileHistoryStore, keyFor, MAX_SNAPSHOTS_PER_FILE } = require('../electron/file-history.cjs');

async function freshStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'zcode-hist-'));
  return { dir, store: createFileHistoryStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const FILE = '/proj/src/app.ts';

test('list is empty for untracked files', async () => {
  const fx = await freshStore();
  try {
    assert.deepEqual(await fx.store.list(FILE), []);
    assert.deepEqual(await fx.store.listTracked(), []);
  } finally { await fx.cleanup(); }
});

test('recordSave snapshots previous content and read returns it', async () => {
  const fx = await freshStore();
  try {
    const ok = await fx.store.recordSave(FILE, 'v1 content', 'v2 content');
    assert.equal(ok, true);
    const entries = await fx.store.list(FILE);
    assert.equal(entries.length, 1);
    const content = await fx.store.read(FILE, entries[0].id);
    assert.equal(content, 'v1 content');
  } finally { await fx.cleanup(); }
});

test('skips unchanged saves and missing previous content', async () => {
  const fx = await freshStore();
  try {
    assert.equal(await fx.store.recordSave(FILE, 'same', 'same'), false);
    assert.equal(await fx.store.recordSave(FILE, undefined, 'x'), false);
    assert.equal((await fx.store.list(FILE)).length, 0);
  } finally { await fx.cleanup(); }
});

test('consecutive saves with identical previous bytes dedupe', async () => {
  const fx = await freshStore();
  try {
    // Disk holds v1. Save A writes v2 (snapshot v1). Save B also has v1 on
    // disk? Not realistic, but the guard must still collapse equal newest
    // snapshots: record twice with same previousContent.
    assert.equal(await fx.store.recordSave(FILE, 'v1', 'v2'), true);
    assert.equal(await fx.store.recordSave(FILE, 'v1', 'v3'), false); // newest snapshot equals prev
    assert.equal((await fx.store.list(FILE)).length, 1);
  } finally { await fx.cleanup(); }
});

test('timeline is newest-first and capped with old files pruned', async () => {
  const fx = await freshStore();
  try {
    const n = MAX_SNAPSHOTS_PER_FILE + 3;
    for (let i = 0; i < n; i += 1) {
      await fx.store.recordSave(FILE, `state-${i}`, `state-${i + 1}`);
      // Ensure ts differs across iterations (Date.now has ms resolution).
      await new Promise((r) => setTimeout(r, 2));
    }
    const entries = await fx.store.list(FILE);
    assert.equal(entries.length, MAX_SNAPSHOTS_PER_FILE);
    assert.ok(entries[0].ts >= entries[entries.length - 1].ts);
    // Snapshot i holds `state-i`; prune drops the 3 oldest (state-0..2), so
    // the oldest kept is state-3.
    assert.equal(await fx.store.read(FILE, entries[entries.length - 1].id), `state-${n - MAX_SNAPSHOTS_PER_FILE}`);
    const keyDir = path.join(fx.dir, 'file-history', keyFor(FILE));
    const files = await (await import('node:fs/promises')).readdir(keyDir);
    assert.equal(files.filter((f) => f.endsWith('.txt')).length, MAX_SNAPSHOTS_PER_FILE);
  } finally { await fx.cleanup(); }
});

test('oversized previous content is skipped', async () => {
  const fx = await freshStore();
  try {
    const big = 'x'.repeat(1024 * 1024 + 10);
    assert.equal(await fx.store.recordSave(FILE, big, 'small'), false);
    assert.equal((await fx.store.list(FILE)).length, 0);
  } finally { await fx.cleanup(); }
});

test('remove deletes a snapshot and its file; list shrinks', async () => {
  const fx = await freshStore();
  try {
    await fx.store.recordSave(FILE, 'a', 'b');
    await new Promise((r) => setTimeout(r, 2));
    await fx.store.recordSave(FILE, 'b', 'c');
    const before = await fx.store.list(FILE);
    assert.equal(before.length, 2);
    await fx.store.remove(FILE, before[1].id); // oldest
    const after = await fx.store.list(FILE);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before[0].id);
    assert.equal(await fx.store.read(FILE, before[1].id), null);
  } finally { await fx.cleanup(); }
});

test('clear wipes a file timeline and frees the index entry', async () => {
  const fx = await freshStore();
  try {
    await fx.store.recordSave(FILE, 'x', 'y');
    const res = await fx.store.clear(FILE);
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(await fx.store.list(FILE), []);
    assert.deepEqual(await fx.store.listTracked(), []);
  } finally { await fx.cleanup(); }
});

test('listTracked aggregates files by last save', async () => {
  const fx = await freshStore();
  try {
    await fx.store.recordSave('/a.ts', '1', '2');
    await new Promise((r) => setTimeout(r, 3));
    await fx.store.recordSave('/b.ts', '1', '2');
    await fx.store.recordSave('/a.ts', '2', '3');
    const tracked = await fx.store.listTracked();
    assert.deepEqual(tracked.map((t) => t.path), ['/a.ts', '/b.ts']); // a saved most recently
    assert.equal(tracked[0].count, 2);
    assert.ok(tracked[0].totalBytes > 0);
  } finally { await fx.cleanup(); }
});

test('path keys are case/separator-insensitive on Windows-style paths', () => {
  assert.equal(keyFor('C:\\Proj\\A.ts'), keyFor('c:/proj/a.ts'));
  assert.notEqual(keyFor('/a/x.ts'), keyFor('/a/y.ts'));
});

test('corrupt index heals on next write', async () => {
  const fx = await freshStore();
  try {
    await mkdir(path.join(fx.dir, 'file-history'), { recursive: true });
    await writeFile(path.join(fx.dir, 'file-history', 'index.json'), 'garbage{', 'utf8');
    assert.deepEqual(await fx.store.list(FILE), []);
    await fx.store.recordSave(FILE, 'ok', 'next');
    assert.equal((await fx.store.list(FILE)).length, 1);
    // index.json is now valid JSON again
    JSON.parse(await readFile(path.join(fx.dir, 'file-history', 'index.json'), 'utf8'));
  } finally { await fx.cleanup(); }
});

test('concurrent records across two files interleave safely', async () => {
  const fx = await freshStore();
  try {
    const jobs = [];
    for (let i = 0; i < 5; i += 1) {
      jobs.push(fx.store.recordSave('/one.ts', `one-${i}`, `one-${i + 1}`));
      jobs.push(fx.store.recordSave('/two.ts', `two-${i}`, `two-${i + 1}`));
      // distinct ts
      await new Promise((r) => setTimeout(r, 1));
    }
    const results = await Promise.all(jobs);
    assert.ok(results.every(Boolean));
    assert.equal((await fx.store.list('/one.ts')).length, 5);
    assert.equal((await fx.store.list('/two.ts')).length, 5);
  } finally { await fx.cleanup(); }
});
