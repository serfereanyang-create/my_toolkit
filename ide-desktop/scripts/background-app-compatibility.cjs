'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { BackgroundAppService } = require('../electron/background-app.cjs');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'background-app-compatibility');
const source = path.join(root, 'tests', 'fixtures', 'background-app');
const results = [];
const service = new BackgroundAppService({ executable: require('electron') });
const call = (tool, input, owner = 'compatibility') => service.execute({ sessionId: owner, workspaceRoot: output, tool: `background_app_${tool}`, input });

async function fixture(name, manifest, entry, contents, nestedType) {
  const directory = path.join(output, name);
  await fs.mkdir(path.dirname(path.join(directory, entry)), { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `fixture-${name}`, ...manifest, main: entry }));
  await fs.writeFile(path.join(directory, entry), contents);
  if (nestedType) await fs.writeFile(path.join(directory, path.dirname(entry), 'package.json'), JSON.stringify({ type: nestedType }));
  for (const filename of ['preload.cjs', 'index.html']) await fs.copyFile(path.join(source, filename), path.join(directory, path.dirname(entry), filename));
}

async function check(name, callback) {
  try { await callback(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.error(`FAIL ${name}: ${error.message}`); throw error; }
}

async function verify(name, format) {
  await check(`${name}: real preload, IPC and fresh PNG remain hidden`, async () => {
    const opened = await call('open', { path: name });
    assert.equal(opened.ok, true, opened.output);
    const appId = opened.data.appId;
    try {
      assert.equal(opened.data.moduleFormat, format);
      assert.ok(opened.data.windows.every(win => !win.visible && !win.focused));
      assert.equal((await call('fill', { appId, selector: '#name', value: `${name} 验收` })).ok, true);
      assert.equal((await call('click', { appId, selector: '#submit' })).ok, true);
      const inspected = await call('inspect', { appId });
      assert.equal(inspected.ok, true, inspected.output);
      assert.ok(inspected.data.snapshot.text.includes(`真实 IPC：${name} 验收`));
      const capture = await call('screenshot', { appId });
      assert.equal(capture.ok, true, capture.output);
      assert.ok(capture.data.blockedDisplays >= 5);
      assert.ok(capture.data.windows.every(win => !win.visible && !win.focused));
      assert.deepEqual(capture.data.rendererErrors, []);
      const png = Buffer.from(capture.data.computerImage.data, 'base64');
      assert.ok(png.length > 5000);
      await fs.writeFile(path.join(output, `${name}.png`), png);
    } finally { await call('close', { appId }); }
    assert.equal(service.apps.size, 0);
  });
}

async function main() {
  await fs.mkdir(output, { recursive: true });
  const esm = await fs.readFile(path.join(source, 'main.mjs'), 'utf8');
  const commonjs = await fs.readFile(path.join(source, 'main.cjs'), 'utf8');
  await fixture('esm-mjs', {}, 'main.mjs', esm);
  await fixture('esm-js', { type: 'module' }, 'main.js', esm);
  await fixture('nested-esm', {}, 'dist/main.js', esm, 'module');
  await fixture('nested-commonjs', { type: 'module' }, 'dist/main.js', commonjs, 'commonjs');
  for (const [name, format] of [['esm-mjs', 'module'], ['esm-js', 'module'], ['nested-esm', 'module'], ['nested-commonjs', 'commonjs']]) await verify(name, format);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await service.dispose();
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
});
