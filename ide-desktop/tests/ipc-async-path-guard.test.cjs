'use strict';
/*
 * Guard: async path helpers must be awaited at every call site in the main
 * process.
 *
 * `media.prepare` called the async `resolveWorkspacePath` without await AND with
 * its arguments swapped, then handed the resulting Promise to
 * `assertInsideRoot` as if it were a path. Every call therefore threw
 * "The \"from\" argument must be of type string. Received an instance of
 * Promise" and left an unhandled rejection in the main process — a path check
 * that looks present in review but never actually runs. Nothing about the
 * broken line looked wrong at a glance, so this test checks the shape instead:
 * any call to one of these helpers that is not awaited is a failure.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');

/** Async helpers that resolve, canonicalize and contain-check a path. */
const ASYNC_PATH_HELPERS = ['resolveWorkspacePath', 'resolveEditorPath', 'describeFile', 'inspectProject'];

function electronSources() {
  return fs.readdirSync(ELECTRON_DIR)
    .filter((name) => name.endsWith('.cjs'))
    .map((name) => ({ name, lines: fs.readFileSync(path.join(ELECTRON_DIR, name), 'utf8').split('\n') }));
}

test('every call to an async path helper is awaited', () => {
  const offenders = [];
  for (const { name, lines } of electronSources()) {
    lines.forEach((line, index) => {
      // Skip the definition, the require/import and the export list.
      if (/function\s+\w+/.test(line) && /resolveWorkspacePath|resolveEditorPath|describeFile|inspectProject/.test(line) && !/\(await/.test(line) && !/= await /.test(line) && !/const \{ path: /.test(line)) {
        // definitions look like `async function resolveWorkspacePath(candidate...)`
        if (/^\s*(async\s+)?function\s/.test(line)) return;
      }
      if (/require\(/.test(line) || /module\.exports/.test(line)) return;
      for (const helper of ASYNC_PATH_HELPERS) {
        const callSite = new RegExp(`(?<![\\w.])${helper}\\s*\\(`);
        if (!callSite.test(line)) continue;
        if (/^\s*(async\s+)?function\s+\w+/.test(line)) continue; // the definition itself
        if (line.includes('await ') || line.includes('.then(')) continue;
        offenders.push(`${name}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [], `un-awaited async path helper calls:\n${offenders.join('\n')}`);
});

test('the path policy helpers really are async, so awaiting them is mandatory', () => {
  const policy = fs.readFileSync(path.join(ELECTRON_DIR, 'preview-policy.cjs'), 'utf8');
  assert.match(policy, /async function resolveWorkspacePath/);
  assert.match(policy, /async function describeFile/);
  assert.match(policy, /async function inspectProject/);
});

test('the path policy rejects escapes, blocked segments and missing inputs', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
  const { tmpdir } = require('node:os');
  const { resolveWorkspacePath, assertInsideRoot } = require('../electron/preview-policy.cjs');

  const root = await mkdtemp(path.join(tmpdir(), 'zcode-policy-'));
  try {
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFile(path.join(root, 'src', 'a.txt'), 'x', 'utf8');

    const inside = await resolveWorkspacePath('src/a.txt', root);
    assert.equal(path.basename(inside.path), 'a.txt');

    await assert.rejects(() => resolveWorkspacePath('../outside.txt', root), /outside workspace root/);
    await assert.rejects(() => resolveWorkspacePath('src/../../outside.txt', root), /outside workspace root/);
    await assert.rejects(() => resolveWorkspacePath('.git/config', root), /Blocked path segment/);
    await assert.rejects(() => resolveWorkspacePath('', root), /Path is required/);
    await assert.rejects(() => resolveWorkspacePath('src/missing.txt', root), /ENOENT/);
    // A write target that does not exist yet still has to be contained.
    const created = await resolveWorkspacePath('src/new/deep.txt', root, { mustExist: false });
    assert.ok(created.path.startsWith(inside.root));
    assert.equal(assertInsideRoot(created.path, inside.root), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
