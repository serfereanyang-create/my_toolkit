'use strict';
require('./lib/probe-guard.cjs');

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BackgroundAppService } = require('../electron/background-app.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'background-app-input');
const service = new BackgroundAppService({ executable: require('electron') });
const reports = [];
let appId;
const call = (operation, input = {}) => service.execute({ sessionId: 'input-review', workspaceRoot: output, tool: `background_app_${operation}`, input: { appId, ...input } });
async function state() {
  const result = await call('inspect');
  assert.equal(result.ok, true, result.output);
  const json = result.data.snapshot.text.match(/STATE: (\{[^\n]+\})/u)?.[1];
  assert.ok(json, result.data.snapshot.text);
  assert.ok(result.data.windows.every(win => !win.visible && !win.focused));
  return JSON.parse(json);
}
async function action(operation, input) { const result = await call(operation, input); assert.equal(result.ok, true, result.output); return result; }
async function check(name, callback) { await callback(); reports.push({ name, ok: true }); console.log(`PASS ${name}`); }
async function main() {
  const fixture = path.join(output, 'fixture');
  await fs.mkdir(fixture, { recursive: true });
  await fs.writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: 'native-input-review', main: 'native-input.cjs' }));
  for (const filename of ['native-input.cjs', 'native-preload.cjs', 'native-input.html']) await fs.copyFile(path.join(root, 'tests', 'fixtures', 'background-app', filename), path.join(fixture, filename));
  const opened = await service.execute({ sessionId: 'input-review', workspaceRoot: output, tool: 'background_app_open', input: { path: 'fixture', width: 1024, height: 768 } });
  assert.equal(opened.ok, true, opened.output); appId = opened.data.appId;
  await check('DOM snapshots mask password and hidden input values while retaining their selectors', async () => {
    const inspected = await call('inspect');
    assert.equal(inspected.ok, true, inspected.output);
    const serialized = JSON.stringify(inspected);
    assert.equal(serialized.includes('private-password-fixture'), false);
    assert.equal(serialized.includes('private-token-fixture'), false);
    for (const selector of ['#private-password', '#private-token']) assert.ok(inspected.data.snapshot.elements.some(element => element.selector === selector && element.name === '[redacted]'));
  });
  await check('Screenshot coordinates focus the actual input, Control+A replaces text and Unicode input is trusted', async () => {
    await action('screenshot');
    await action('click', { x: 80, y: 160 });
    assert.equal((await state()).active, 'first');
    await action('key', { key: 'Control+A' });
    await action('type', { text: '后台输入🚲' });
    const current = await state();
    assert.equal(current.first, '后台输入🚲');
    assert.ok(current.trustedInputs > 0);
  });
  await check('Tab moves native focus and Enter performs the default form submission', async () => {
    await action('key', { key: 'Tab' });
    assert.equal((await state()).active, 'second');
    await action('type', { text: 'second field' });
    await action('key', { key: 'Enter' });
    const current = await state();
    assert.equal(current.second, 'second field');
    assert.equal(current.submitted, 1);
  });
  await check('Canvas pointer events, double click and right click are real renderer input', async () => {
    await action('click', { x: 600, y: 250 });
    assert.equal((await state()).pointers, 1);
    await action('click', { selector: '#surface', double: true });
    assert.equal((await state()).doubleClicks, 1);
    await action('click', { selector: '#surface', button: 'right' });
    assert.equal((await state()).rightClicks, 1);
    const screenshot = await action('screenshot');
    await fs.writeFile(path.join(output, 'native-input.png'), Buffer.from(screenshot.data.computerImage.data, 'base64'));
  });
  await check('No editable target, covered elements and out-of-image points fail without affecting the app', async () => {
    assert.equal((await call('type', { text: 'must not type here' })).ok, false);
    assert.equal((await call('click', { selector: '#covered' })).ok, false);
    assert.equal((await call('click', { x: 5000, y: 5000 })).ok, false);
    const current = await state();
    assert.equal(current.coveredClicks, 0);
    assert.equal(current.first, '后台输入🚲');
    assert.equal(service.apps.size, 1);
  });
  await check('Screenshot pixel coordinates remain correct with 150% renderer zoom', async () => {
    await action('click', { selector: '#zoom' });
    const before = await state();
    assert.ok(Math.abs(before.zoom - 1.5) < 0.01);
    await action('screenshot');
    await action('click', { x: 80, y: 240 });
    assert.equal((await state()).active, 'first');
    await action('key', { key: 'Control+A' });
    await action('type', { text: '缩放后输入' });
    assert.equal((await state()).first, '缩放后输入');
    const screenshot = await action('screenshot');
    await fs.writeFile(path.join(output, 'zoomed-input.png'), Buffer.from(screenshot.data.computerImage.data, 'base64'));
  });
}
main().catch(error => { reports.push({ name: 'input review failure', ok: false, error: error.stack }); console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await service.dispose();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), reports }, null, 2));
});
