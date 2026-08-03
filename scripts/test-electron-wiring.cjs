const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron', 'preload.cjs'), 'utf8');

for (const channel of [
  'auth:register',
  'auth:login',
  'auth:logout',
  'auth:get-session',
  'auth:update-profile',
  'auth:change-password',
  'library:load',
  'library:save',
]) {
  assert.ok(main.includes(`ipcMain.handle('${channel}'`), `main is missing ${channel}`);
  assert.ok(preload.includes(`ipcRenderer.invoke('${channel}'`), `preload is missing ${channel}`);
}

assert.ok(main.includes('openDb(userDataPath)'), 'database is not opened during app startup');
assert.ok(main.includes('auth.configureAuth({ userDataPath, sessionDays: 30 })'), 'auth is not configured during app startup');
assert.equal(main.includes("{ role: 'toggleDevTools'"), false, 'application menu exposes Chromium developer tools');
assert.ok(main.includes('devTools: false'), 'BrowserWindow does not explicitly disable developer tools');
console.log('electron wiring tests passed');
