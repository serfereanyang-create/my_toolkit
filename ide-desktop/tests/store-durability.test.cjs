'use strict';
/*
 * Durability guard for every JSON sidecar store in the main process.
 *
 * These stores all answer "read the whole file, change one thing, write it
 * back". Doing that naively loses data three ways — an in-place write tears on
 * a crash, a rename over an open file fails EPERM on Windows, and a corrupt
 * file that reads as "empty" is then overwritten by the next mutation. The
 * shared helpers exist so each store does not have to remember.
 *
 * This test fails when a store goes back to its own writeFile/rename pair, so a
 * future store cannot quietly reintroduce the bug these were fixed for.
 */
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ELECTRON_DIR = path.join(__dirname, '..', 'electron');

/** Every module that persists a JSON sidecar the user cares about. */
const STORES = [
  'bookmarks-store.cjs',
  'file-history.cjs',
  'keybindings-store.cjs',
  'message-queue-store.cjs',
  'secret-store.cjs',
  'settings-store.cjs',
  'session-notes.cjs',
  'session-tags.cjs',
  'snippets-store.cjs',
  'subagent-runs.cjs',
  'workspace.cjs',
];

function source(name) {
  return fs.readFileSync(path.join(ELECTRON_DIR, name), 'utf8');
}

test('every sidecar store publishes its file through a durable helper', () => {
  for (const name of STORES) {
    const text = source(name);
    const usesHelper = /require\('\.\/json-store\.cjs'\)/.test(text) || /require\('\.\/atomic-file\.cjs'\)/.test(text);
    assert.ok(usesHelper, `${name} must use json-store.cjs or atomic-file.cjs instead of raw fs writes`);
    // A bare `fs.rename(tmp, target)` is the un-retried publish step. Moving a
    // corrupt file aside may stay a plain rename: it is best-effort cleanup.
    const barePublish = /fs\.rename\(\s*(tmp|temporary|temp)\b/.test(text);
    assert.equal(barePublish, false, `${name} still publishes through fs.rename; use renameWithRetry`);
  }
});

test('a store that reads a whole file wholesale serialises its mutations', () => {
  for (const name of STORES) {
    const text = source(name);
    if (!/JSON\.parse\(/.test(text)) continue;
    const serialised = /createJsonStore\(|serialize\(|chain = |writeQueue = |enqueueOnTarget|writes\.get\(/.test(text);
    assert.ok(serialised, `${name} parses the whole file but does not serialise its writes`);
  }
});

test('the shared helpers themselves keep the atomic temp-then-rename shape', () => {
  const atomic = source('atomic-file.cjs');
  assert.match(atomic, /renameWithRetry/);
  assert.match(atomic, /EPERM|EBUSY/);
  const json = source('json-store.cjs');
  assert.match(json, /readJson/);
  assert.match(json, /corrupt-/, 'an unreadable file must be moved aside, not overwritten');
  assert.match(json, /renameWithRetry/, 'rename must be retried on transient Windows failures');
});
