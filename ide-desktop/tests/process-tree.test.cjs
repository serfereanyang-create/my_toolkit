'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const processTree = require('../electron/process-tree.cjs');

const INTERVAL_SCRIPT = 'setInterval(() => {}, 1000); process.stdout.write("up\\n");';
// Parent prints "up" once running, then spawns a grandchild doing the same.
const PARENT_SCRIPT = `
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', ${JSON.stringify(INTERVAL_SCRIPT)}], { stdio: 'ignore' });
process.stdout.write('up ' + child.pid + '\\n');
setInterval(() => {}, 1000);
`;

function startTree() {
  return new Promise((resolvePromise) => {
    const parent = spawn(process.execPath, ['-e', PARENT_SCRIPT], { stdio: 'pipe' });
    let stdout = '';
    parent.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('up ')) {
        const grandchildPid = Number.parseInt(stdout.split('up ')[1], 10);
        resolvePromise({ parent, grandchildPid });
      }
    });
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for: ${message}`);
}

test('listDescendants finds the spawned grandchild', async () => {
  const { parent, grandchildPid } = await startTree();
  try {
    await waitFor(
      () => processTree.listDescendants(parent.pid).then((ids) => ids.includes(grandchildPid)),
      10_000,
      'grandchild to appear in the snapshot',
    );
    assert.ok((await processTree.listDescendants(parent.pid)).includes(grandchildPid));
  } finally {
    await processTree.terminateProcessTree(parent, { forceAfterMs: 1000 });
  }
});

test('terminateProcessTree kills the whole tree and reports the outcome', async () => {
  const { parent, grandchildPid } = await startTree();
  const alive = (pid) => new Promise((resolvePromise) => {
    try {
      process.kill(pid, 0);
      resolvePromise(true);
    } catch {
      resolvePromise(false);
    }
  });
  assert.ok(await alive(parent.pid));
  assert.ok(await alive(grandchildPid));

  const result = await processTree.terminateProcessTree(parent, { forceAfterMs: 2000 });
  assert.equal(result.killed, true);
  assert.equal(result.alreadyExited, false);
  await waitFor(() => alive(grandchildPid).then((a) => !a), 10_000, 'grandchild to exit');
  await waitFor(() => alive(parent.pid).then((a) => !a), 10_000, 'parent to exit');
});

test('terminateProcessTree is a no-op for an already-exited child', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  await new Promise((r) => child.once('exit', r));
  const result = await processTree.terminateProcessTree(child);
  assert.equal(result.alreadyExited, true);
  assert.equal(result.killed, true);
});
