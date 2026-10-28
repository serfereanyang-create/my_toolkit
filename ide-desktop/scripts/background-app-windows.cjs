'use strict';
require('./lib/probe-guard.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BackgroundAppService } = require('../electron/background-app.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'background-app-windows');
const source = path.join(root, 'tests', 'fixtures', 'background-app');
const service = new BackgroundAppService({ executable: require('electron') });
const reports = [];
const call = (operation, input) => service.execute({ sessionId: 'window-review', workspaceRoot: output, tool: `background_app_${operation}`, input });
async function check(name, callback) { await callback(); reports.push({ name, ok: true }); console.log(`PASS ${name}`); }
async function main() {
  await fs.mkdir(path.join(output, 'fixture'), { recursive: true });
  await fs.writeFile(path.join(output, 'fixture', 'package.json'), JSON.stringify({ name: 'multi-window-review', main: 'multi-window.cjs' }));
  for (const filename of ['multi-window.cjs', 'multi-preload.cjs', 'multi-window.html']) await fs.copyFile(path.join(source, filename), path.join(output, 'fixture', filename));
  const opened = await call('open', { path: 'fixture' });
  assert.equal(opened.ok, true, opened.output);
  const appId = opened.data.appId;
  const splashId = opened.data.windowId;
  await call('click', { appId, windowId: splashId, selector: '#advance' });
  const primary = await call('inspect', { appId });
  assert.equal(primary.ok, true, primary.output);
  assert.equal(primary.data.snapshot.title, '主窗口');
  if (process.argv.includes('--baseline')) {
    service.timeoutMs = 600;
    const started = Date.now();
    const stale = await call('screenshot', { appId, windowId: splashId });
    reports.push({ name: 'stale splash id forces an operation timeout', ok: false, elapsedMs: Date.now() - started, output: stale.output });
    console.log(JSON.stringify(reports.at(-1)));
    return;
  }
  await check('A closed splash is rejected promptly without killing or redirecting the app', async () => {
    const started = Date.now();
    const stale = await call('screenshot', { appId, windowId: splashId });
    assert.equal(stale.ok, false);
    assert.match(stale.output, /关闭|不存在/);
    assert.doesNotMatch(stale.output, /超时/);
    assert.ok(Date.now() - started < 1000);
    assert.equal(service.apps.size, 1);
  });
  let listed = await call('windows', { appId });
  const deadline = Date.now() + 3000;
  while (listed.ok && Date.now() < deadline && (!listed.data.windows.some(win => win.title === '辅助窗口') || listed.data.windows.some(win => win.loading))) {
    await new Promise(resolve => setTimeout(resolve, 50));
    listed = await call('windows', { appId });
  }
  await check('Window listing refreshes current main and auxiliary windows without a target id', async () => {
    assert.equal(listed.ok, true, listed.output);
    assert.deepEqual(listed.data.windows.map(win => win.title).sort(), ['主窗口', '辅助窗口'].sort());
    assert.ok(listed.data.windows.every(win => !win.visible && !win.focused));
  });
  const mainWindow = listed.data.windows.find(win => win.title === '主窗口');
  const auxiliary = listed.data.windows.find(win => win.title === '辅助窗口');
  await check('Ambiguous write actions never silently target the first window', async () => {
    const result = await call('click', { appId, selector: '#close-secondary' });
    assert.equal(result.ok, false);
    assert.match(result.output, /多个窗口.*windowId/);
    const current = await call('windows', { appId });
    assert.equal(current.data.windows.length, 2);
  });
  await check('Explicit window selection captures distinct real surfaces', async () => {
    const mainShot = await call('screenshot', { appId, windowId: mainWindow.windowId });
    const auxiliaryShot = await call('screenshot', { appId, windowId: auxiliary.windowId });
    assert.equal(mainShot.ok, true, mainShot.output); assert.equal(auxiliaryShot.ok, true, auxiliaryShot.output);
    assert.notEqual(mainShot.data.computerImage.data, auxiliaryShot.data.computerImage.data);
    await fs.writeFile(path.join(output, 'main.png'), Buffer.from(mainShot.data.computerImage.data, 'base64'));
    await fs.writeFile(path.join(output, 'auxiliary.png'), Buffer.from(auxiliaryShot.data.computerImage.data, 'base64'));
  });
  await check('Closing an auxiliary window removes only its handle and keeps the main operational', async () => {
    await call('click', { appId, windowId: mainWindow.windowId, selector: '#close-secondary' });
    const refreshed = await call('windows', { appId });
    assert.equal(refreshed.ok, true, refreshed.output);
    assert.deepEqual(refreshed.data.windows.map(win => win.windowId), [mainWindow.windowId]);
    assert.equal((await call('inspect', { appId, windowId: auxiliary.windowId })).ok, false);
    assert.equal((await call('inspect', { appId, windowId: mainWindow.windowId })).ok, true);
  });
}
main().catch(error => { reports.push({ name: 'window review failure', ok: false, error: error.stack }); console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await service.dispose();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, process.argv.includes('--baseline') ? 'baseline.json' : 'results.json'), JSON.stringify({ date: new Date().toISOString(), reports }, null, 2));
});
