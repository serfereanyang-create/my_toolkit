'use strict';
/*
 * Durability of two files the app writes outside the JSON sidecar stores:
 * the checkpoint manifest (the handle /undo needs) and the quality-gateway
 * history (what the quality panels and the `quality_history` tool read).
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fsp = require('node:fs/promises');
const { mkdtemp, readFile, rename, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const nodePath = require('node:path');
const { createCheckpointStore } = require('../electron/checkpoints.cjs');
const { persistQualityRecord } = require('../electron/quality-gateway.cjs');

function manifestFor(workspacePath) {
  return {
    checkpointId: 'cp_20260101000000_aaaaaaaa',
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: '',
    createdAt: 1_767_225_600_000,
    refName: 'refs/yoycode/checkpoints/x/cp_20260101000000_aaaaaaaa',
    commitOid: 'a'.repeat(40),
    scope: 'workspace',
  };
}

// A checkpoint manifest is written to a temp file and renamed into place. On
// Windows a virus scanner or indexer holding the target makes that rename fail
// with EPERM; without a retry the checkpoint silently never exists, which is
// exactly the safety net /undo depends on.
test('a checkpoint manifest survives a transient rename failure', async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'zcode-cp-store-'));
  try {
    let attempts = 0;
    const flakyRename = async (from, to) => {
      attempts += 1;
      if (attempts <= 2) {
        const error = new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`);
        error.code = 'EPERM';
        throw error;
      }
      return rename(from, to);
    };
    const store = createCheckpointStore(root, { rename: flakyRename });
    const workspacePath = nodePath.join(root, 'workspace');
    const meta = manifestFor(workspacePath);

    await store.save(meta);

    assert.equal(attempts, 3, 'two transient failures are retried, not surfaced');
    assert.deepEqual(await store.load(workspacePath, meta.checkpointId), meta);
    // No temp file is left behind by the retried publish.
    const hashedDir = nodePath.join(root, (await fsp.readdir(root))[0]);
    const files = await fsp.readdir(hashedDir);
    assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a checkpoint manifest write that keeps failing reports the error instead of vanishing', async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'zcode-cp-store-'));
  try {
    const alwaysFails = async () => {
      const error = new Error('EPERM: operation not permitted');
      error.code = 'EPERM';
      throw error;
    };
    const store = createCheckpointStore(root, { rename: alwaysFails });
    const workspacePath = nodePath.join(root, 'workspace');
    await assert.rejects(store.save(manifestFor(workspacePath)), /EPERM/);

    // The abandoned temp file must not be left lying around.
    const hashedDir = nodePath.join(root, (await fsp.readdir(root))[0]);
    const files = await fsp.readdir(hashedDir);
    assert.deepEqual(files.filter((name) => name.endsWith('.tmp')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The history is a read-modify-write of one .jsonl file. Two gates finishing in
// the same tick used to both read the old file, so the second write dropped the
// first record; both writes were plain writeFile, so a crash could leave a torn
// line (readers skip it, so the record is simply gone).
test('concurrent quality records are all kept and stay parseable', async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), 'zcode-quality-'));
  try {
    await Promise.all(Array.from({ length: 20 }, (_, index) => index + 1).map((index) => persistQualityRecord(
      fsp,
      nodePath,
      dir,
      'structure_audit',
      { index },
      'main@abc@1',
      { ok: true, output: `run-${index}` },
    )));

    const historyPath = nodePath.join(dir, '.aicode', 'quality', 'structure_audit', 'history.jsonl');
    const lines = (await readFile(historyPath, 'utf8')).split('\n').filter((line) => line.trim());
    assert.equal(lines.length, 20, 'no record is dropped');
    const indexes = lines.map((line) => JSON.parse(line).input.index).sort((a, b) => a - b);
    assert.deepEqual(indexes, Array.from({ length: 20 }, (_, index) => index + 1));

    const latest = JSON.parse(await readFile(nodePath.join(dir, '.aicode', 'quality', 'structure_audit', 'latest.json'), 'utf8'));
    assert.equal(latest.result.ok, true);
    assert.equal(latest.tool, 'structure_audit');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the quality history keeps its cap', async () => {
  const dir = await mkdtemp(nodePath.join(tmpdir(), 'zcode-quality-'));
  try {
    for (let index = 0; index < 55; index += 1) {
      await persistQualityRecord(fsp, nodePath, dir, 'structure_audit', { index }, null, { ok: true, output: 'x' });
    }
    const historyPath = nodePath.join(dir, '.aicode', 'quality', 'structure_audit', 'history.jsonl');
    const lines = (await readFile(historyPath, 'utf8')).split('\n').filter((line) => line.trim());
    assert.equal(lines.length, 50);
    assert.equal(JSON.parse(lines.at(-1)).input.index, 54);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
