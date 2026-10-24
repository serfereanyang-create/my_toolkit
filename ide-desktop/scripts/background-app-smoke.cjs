'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const { BackgroundAppService } = require('../electron/background-app.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'background-app-review');
const service = new BackgroundAppService({ executable: require('electron') });
const results = [];
const call = (tool, input, sessionId = 'smoke-owner', workspaceRoot = output) => service.execute({ sessionId, workspaceRoot, tool: `background_app_${tool}`, input });
async function check(name, callback) { await callback(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }

async function main() {
  await fs.mkdir(output, { recursive: true });
  const fixture = path.join(output, 'fixture');
  await fs.mkdir(fixture, { recursive: true });
  for (const name of ['package.json', 'main.cjs', 'preload.cjs', 'index.html']) await fs.copyFile(path.join(root, 'tests', 'fixtures', 'background-app', name), path.join(fixture, name));
  const opened = await call('open', { path: 'fixture', width: 960, height: 640 });
  assert.equal(opened.ok, true, opened.output);
  const appId = opened.data.appId;
  await check('Real Electron main starts with every window hidden and unfocused', async () => { assert.ok(opened.data.windows.length); assert.ok(opened.data.windows.every(win => !win.visible && !win.focused)); });
  await check('Session ownership rejects another conversation', async () => { const result = await call('inspect', { appId }, 'other-session'); assert.equal(result.ok, false); });
  const initial = await call('screenshot', { appId });
  await check('Fresh real PNG frame, no visible window or focus, attempts to show are blocked', async () => {
    assert.equal(initial.ok, true, initial.output);
    assert.ok(Math.abs(initial.data.viewport.width - 960) <= 2 && Math.abs(initial.data.viewport.height - 640) <= 2);
    assert.ok(initial.data.width >= 960 && initial.data.height >= 640);
    assert.ok(initial.data.blockedDisplays >= 5);
    assert.ok(initial.data.windows.every(win => !win.visible && !win.focused));
    assert.deepEqual(initial.data.rendererErrors, []);
    const png = Buffer.from(initial.data.computerImage.data, 'base64');
    assert.ok(png.length > 5000);
    assert.deepEqual(await fs.readFile(path.join(output, initial.data.computerImage.path)), png);
    await fs.writeFile(path.join(output, 'initial.png'), png);
  });
  await check('Preload and IPC survive hidden launch and real DOM interaction', async () => {
    assert.equal((await call('fill', { appId, selector: '#name', value: '后台验收通过' })).ok, true);
    assert.equal((await call('click', { appId, selector: '#submit' })).ok, true);
    const inspected = await call('inspect', { appId });
    assert.equal(inspected.ok, true, inspected.output);
    assert.match(inspected.data.snapshot.text, /真实 IPC：后台验收通过/);
  });
  const updated = await call('screenshot', { appId });
  await check('Screenshot refreshes after interaction with materially different pixels', async () => {
    assert.equal(updated.ok, true, updated.output);
    const before = await sharp(Buffer.from(initial.data.computerImage.data, 'base64')).raw().toBuffer();
    const after = await sharp(Buffer.from(updated.data.computerImage.data, 'base64')).raw().toBuffer();
    let changed = 0; for (let index = 0; index < before.length; index += 1) if (before[index] !== after[index]) changed += 1;
    assert.ok(changed > 10_000, `Only ${changed} channels changed`);
    await fs.writeFile(path.join(output, 'updated.png'), Buffer.from(updated.data.computerImage.data, 'base64'));
  });
  await check('Close ends only the owned child and invalidates its handle', async () => {
    assert.equal((await call('close', { appId })).ok, true);
    assert.equal(service.apps.size, 0);
    assert.equal((await call('inspect', { appId })).ok, false);
  });
  if (process.argv.includes('--self')) {
    const self = await call('open', { path: '.', width: 1440, height: 960 }, 'self-review', root);
    assert.equal(self.ok, true, self.output);
    const shot = await call('screenshot', { appId: self.data.appId }, 'self-review', root);
    assert.equal(shot.ok, true, shot.output);
    assert.ok(shot.data.windows.every(win => !win.visible && !win.focused));
    await fs.writeFile(path.join(output, 'yoycode-real-app.png'), Buffer.from(shot.data.computerImage.data, 'base64'));
    results.push({ name: 'YOYcode actual main/preload/built renderer captured invisibly', ok: true, rendererErrors: shot.data.rendererErrors });
    console.log('PASS actual YOYcode hidden screenshot');
  }
}
main().catch(error => { results.push({ name: 'smoke failure', ok: false, error: error.stack }); console.error(error); process.exitCode = 1; }).finally(async () => {
  await service.dispose();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
});
