const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');

/**
 * The renderer can only reach the main process through a channel that is
 * BOTH registered by `ipcMain.handle` and exposed by the preload bridge.
 * Registering one without the other fails only at click time — which is how
 * "the buttons are there but nothing happens" ships: a handler with no
 * bridge entry, or a bridge entry with no handler.
 *
 * This is a static check on the two files, so it catches the gap in the
 * default test run rather than in the running app.
 */
function invokedChannels() {
  const source = readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');
  const found = new Map();
  const pattern = /ipcRenderer\.invoke\(\s*'([^']+)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const before = source.slice(0, match.index);
    found.set(match[1], before.split('\n').length);
  }
  return found;
}

function handledChannels() {
  const source = readFileSync(path.join(root, 'electron', 'ipc.cjs'), 'utf8');
  const found = new Set();
  const pattern = /ipcMain\.handle\(\s*'([^']+)'/g;
  let match;
  while ((match = pattern.exec(source)) !== null) found.add(match[1]);
  return found;
}

test('every channel the preload bridge invokes has an ipcMain handler', () => {
  const handled = handledChannels();
  const missing = [...invokedChannels()]
    .filter(([channel]) => !handled.has(channel))
    .map(([channel, line]) => `${channel} (preload.cjs:${line})`);

  assert.deepEqual(missing, [], `preload invokes channels with no ipcMain.handle: ${missing.join(', ')}`);
});

test('sessions.fork is reachable end to end', () => {
  // Regression guard: the fork feature needs all three layers — handler,
  // bridge entry, and the typed renderer API.
  const handled = handledChannels();
  assert.ok(handled.has('sessions.fork'), 'ipc.cjs must register sessions.fork');
  assert.ok(invokedChannels().has('sessions.fork'), 'preload.cjs must expose sessions.fork');

  const typed = readFileSync(path.join(root, 'src', 'lib', 'ipc.ts'), 'utf8');
  assert.match(typed, /fork\(id: string\)/, 'src/lib/ipc.ts must declare sessions.fork');
});
