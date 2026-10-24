'use strict';
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const { BackgroundAppService } = require('../electron/background-app.cjs');
const { createBackgroundBrowserService } = require('../electron/background-browser.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'interrupt-review', 'host');
const browser = createBackgroundBrowserService();
const apps = new BackgroundAppService();
const reports = [];
app.on('window-all-closed', () => {});
const browserCall = (operation, input, signal) => browser.execute({ sessionId: 'owner', workspaceRoot: output, tool: `background_browser_${operation}`, input, signal });
const appCall = (operation, input, signal) => apps.execute({ sessionId: 'owner', workspaceRoot: output, tool: `background_app_${operation}`, input, signal });
async function waitFor(predicate, label) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(label);
}
async function check(name, callback) { await callback(); reports.push({ name, ok: true }); console.log(`PASS ${name}`); }
async function fixture(name, mode) {
  const directory = path.join(output, name); await fs.mkdir(directory, { recursive: true });
  const token = randomUUID();
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `cancel-${name}`, main: 'lifecycle.cjs' }));
  await fs.writeFile(path.join(directory, 'mode.json'), JSON.stringify({ mode, token }));
  for (const filename of ['lifecycle.cjs', 'worker.cjs', 'preload.cjs', 'index.html']) await fs.copyFile(path.join(root, 'tests', 'fixtures', 'background-app', filename), path.join(directory, filename));
  return { directory, token };
}
const alive = processId => { try { process.kill(processId, 0); return true; } catch { return false; } };
async function ended(directory) {
  const processIds = JSON.parse(await fs.readFile(path.join(directory, 'pids.json'), 'utf8'));
  await waitFor(() => !alive(processIds.appPid) && !alive(processIds.workerPid), 'cancelled app or worker remains alive');
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const profile = path.join(output, 'profile'); await fs.mkdir(profile, { recursive: true }); app.setPath('userData', profile);
  await app.whenReady();
  await fs.writeFile(path.join(output, 'idle.html'), '<!doctype html><h1>idle page remains available</h1>');
  let seen = 0;
  const server = createServer((request, response) => { request.resume(); seen += 1; response.writeHead(200, { 'content-type': 'text/html' }); response.write('<!doctype html><h1>loading'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/slow`;
  try {
    await check('Cancel during browser startup destroys the unregistered page and settles its load', async () => {
      const controller = new AbortController(); const before = seen;
      const pending = browserCall('open', { url }, controller.signal);
      await waitFor(() => seen > before, 'browser request never began');
      controller.abort(); assert.equal((await pending).ok, false);
      assert.equal(browser.status().length, 0); assert.equal(BrowserWindow.getAllWindows().length, 0);
    });
    const idle = await browserCall('open', { path: 'idle.html' }); assert.equal(idle.ok, true, idle.output);
    const active = await browserCall('open', { path: 'idle.html' }); assert.equal(active.ok, true, active.output);
    await check('Cancel a pending navigation without closing an idle page owned by the same conversation', async () => {
      const controller = new AbortController(); const before = seen;
      const pending = browserCall('navigate', { browserId: active.data.browserId, url }, controller.signal);
      await waitFor(() => seen > before, 'navigation never began'); controller.abort();
      assert.equal((await pending).ok, false);
      assert.deepEqual(browser.status().map(page => page.browserId), [idle.data.browserId]);
      assert.equal((await browserCall('screenshot', { browserId: idle.data.browserId })).ok, true);
    });
    await fixture('idle-app', 'normal-close');
    const idleApp = await appCall('open', { path: 'idle-app' }); assert.equal(idleApp.ok, true, idleApp.output);
    await check('Cancel a CPU-blocked application startup and retain an idle application from the same session', async () => {
      const target = await fixture('boot-hang', 'boot-hang');
      const controller = new AbortController();
      const pending = appCall('open', { path: 'boot-hang' }, controller.signal);
      await waitFor(async () => { try { const pids = JSON.parse(await fs.readFile(path.join(target.directory, 'pids.json'), 'utf8')); return alive(pids.appPid); } catch { return false; } }, 'application did not enter startup');
      controller.abort(); assert.equal((await pending).ok, false); await ended(target.directory);
      assert.equal(apps.apps.size, 1); assert.equal((await appCall('inspect', { appId: idleApp.data.appId })).ok, true);
    });
    await check('Cancel a real hung renderer action and its worker while unrelated app state survives', async () => {
      const target = await fixture('operation-hang', 'operation-hang');
      const opened = await appCall('open', { path: 'operation-hang' }); assert.equal(opened.ok, true, opened.output);
      const controller = new AbortController();
      const pending = appCall('click', { appId: opened.data.appId, selector: '#submit' }, controller.signal);
      await waitFor(async () => { try { const entered = JSON.parse(await fs.readFile(path.join(target.directory, 'operation.json'), 'utf8')); return entered.token === target.token; } catch { return false; } }, 'application never entered the blocked action');
      controller.abort(); assert.equal((await pending).ok, false); await ended(target.directory);
      assert.equal(apps.apps.size, 1); assert.equal((await appCall('screenshot', { appId: idleApp.data.appId })).ok, true);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

main().catch(error => { reports.push({ name: 'host cancellation failure', ok: false, error: error.stack }); console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await apps.dispose(); await browser.disposeAll();
  await fs.mkdir(output, { recursive: true }); await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), reports }, null, 2));
  app.exit(process.exitCode || 0);
});
