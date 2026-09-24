'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { TerminalManager, listShellProfiles, defaultShell } = require('../electron/terminal.cjs');

test('shell profile discovery finds at least one usable shell', () => {
  const profiles = listShellProfiles();
  assert.ok(profiles.length >= 1, 'at least one shell available');
  assert.ok(profiles.every((profile) => profile.id && profile.name && profile.file && Array.isArray(profile.args)));
});

test('defaultShell picks the first available profile on this platform', () => {
  const shell = defaultShell();
  assert.ok(shell.file);
  assert.ok(Array.isArray(shell.args));
});

test('kill terminates the shell process and is idempotent afterwards', async () => {
  const manager = new TerminalManager();
  const session = manager.create({ cwd: os.tmpdir() });
  const id = session.id;
  // Wait for the shell to actually spawn.
  await new Promise((r) => setTimeout(r, 600));
  const first = await manager.kill(id);
  assert.equal(first.ok, true);
  const second = await manager.kill(id);
  assert.equal(second.ok, false, 'session already removed');
  await manager.disposeAll();
});
