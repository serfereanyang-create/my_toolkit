'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { atomicWriteText, atomicWriteJson, renameWithRetry, isRetryableRenameError } = require('../electron/atomic-file.cjs');

test('isRetryableRenameError matches only transient lock errors', () => {
  assert.equal(isRetryableRenameError({ code: 'EPERM' }), true);
  assert.equal(isRetryableRenameError({ code: 'EBUSY' }), true);
  assert.equal(isRetryableRenameError({ code: 'EACCES' }), true);
  assert.equal(isRetryableRenameError({ code: 'ENOENT' }), false);
  assert.equal(isRetryableRenameError(new Error('no code')), false);
});

test('atomicWriteText replaces the target and leaves no temp files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-'));
  try {
    const target = join(dir, 'data.json');
    await writeFile(target, 'old', 'utf-8');
    await atomicWriteText(target, 'new content');
    assert.equal(await readFile(target, 'utf-8'), 'new content');
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent writers to the same target always leave a complete file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-race-'));
  try {
    const target = join(dir, 'race.json');
    // 30 concurrent 2KB writes: a torn write would end in a JSON parse error
    // or a truncated last line, which the final read would catch.
    await Promise.all(Array.from({ length: 30 }, (_, i) =>
      atomicWriteJson(target, { writer: i, payload: 'x'.repeat(2048) })));
    const final = JSON.parse(await readFile(target, 'utf-8'));
    assert.ok(Number.isInteger(final.writer));
    assert.equal(final.payload.length, 2048);
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stale temp files from crashed runs are cleaned up', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-stale-'));
  try {
    const target = join(dir, 'data.txt');
    const stalePath = join(dir, 'data.txt.999.1.tmp');
    await writeFile(stalePath, 'stale', 'utf-8');
    // Backdate the mtime beyond the staleness threshold.
    const old = new Date(Date.now() - 120_000);
    await require('node:fs/promises').utimes(stalePath, old, old);

    await atomicWriteText(target, 'fresh', { tempFileStaleMs: 60_000 });
    const entries = await readdir(dir);
    assert.ok(!entries.includes('data.txt.999.1.tmp'), 'stale temp removed');
    assert.equal(await readFile(target, 'utf-8'), 'fresh');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('renameWithRetry surfaces non-retryable failures immediately', async () => {
  const bogusTemp = join(tmpdir(), 'no-such-dir-xyz', 'a.tmp');
  await assert.rejects(() => renameWithRetry(bogusTemp, join(tmpdir(), 'b.tmp'), [1]), /ENOENT|EPERM/);
});
