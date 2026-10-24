'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const fs = require('node:fs/promises');
const { BackgroundAppService, resolveProject, validateInput, storageDirectory } = require('../electron/background-app.cjs');
const { createBackgroundProcessJob } = require('../electron/background-process-job.cjs');
const root = path.resolve(__dirname, '..');
const appId = '11111111-1111-4111-8111-111111111111';

test('project resolver accepts built CommonJS main and confines resolved paths', async () => {
  const project = await resolveProject(root, 'tests/fixtures/background-app');
  assert.equal(project.entry, path.join(root, 'tests', 'fixtures', 'background-app', 'main.cjs'));
  await assert.rejects(resolveProject(root, '../cli'));
  await assert.rejects(resolveProject(root, path.dirname(root)));
  await assert.rejects(resolveProject(root, 'src'));
});

test('host validates operation, identifiers, dimensions and selector payloads', () => {
  for (const input of [{ path: '.', width: 0 }, { path: '.', command: 'ignored' }, { path: '.', height: 4097 }, { path: '.', width: 1.1 }]) assert.throws(() => validateInput('background_app_open', input));
  for (const [tool, input] of [['inspect', { appId: 'wrong' }], ['inspect', { appId, windowId: -1 }], ['click', { appId }], ['fill', { appId, selector: '#name', value: 1 }], ['close', { appId, windowId: 1 }]]) assert.throws(() => validateInput(`background_app_${tool}`, input));
  assert.equal(validateInput('background_app_open', { path: '.', width: 800 }), 'open');
  assert.equal(validateInput('background_app_fill', { appId, selector: '#name', value: '中文' }), 'fill');
});

test('module format follows extension and the nearest package boundary', async () => {
  const directory = path.join(root, 'out', 'background-app-policy-review', 'module-formats');
  await fs.mkdir(path.join(directory, 'dist'), { recursive: true });
  const cases = [
    { entry: 'main.mjs', rootType: 'commonjs', expected: 'module' },
    { entry: 'main.cjs', rootType: 'module', expected: 'commonjs' },
    { entry: 'main.js', rootType: 'module', expected: 'module' },
    { entry: 'dist/main.js', rootType: 'commonjs', nestedType: 'module', expected: 'module' },
    { entry: 'dist/main.js', rootType: 'module', nestedType: 'commonjs', expected: 'commonjs' },
  ];
  for (const scenario of cases) {
    await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: scenario.rootType, main: scenario.entry }));
    await fs.writeFile(path.join(directory, scenario.entry), '');
    if (scenario.nestedType) await fs.writeFile(path.join(directory, 'dist', 'package.json'), JSON.stringify({ type: scenario.nestedType }));
    assert.equal((await resolveProject(root, path.relative(root, directory))).moduleFormat, scenario.expected);
  }
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ main: 'main.exe' }));
  await fs.writeFile(path.join(directory, 'main.exe'), '');
  await assert.rejects(resolveProject(root, path.relative(root, directory)), /JavaScript/);
});

test('Windows process guard refuses malformed identities before launching its helper', { skip: process.platform !== 'win32' }, async () => {
  await assert.rejects(createBackgroundProcessJob(-1, root), /进程 ID/);
  await assert.rejects(createBackgroundProcessJob(process.pid, root), /归属标记/);
});

test('unknown handles and unsupported tools answer explicitly without starting a child', async () => {
  const service = new BackgroundAppService();
  for (const tool of ['background_app_inspect', 'background_app_eval', 'computer_screenshot']) {
    const result = await service.execute({ sessionId: 'owner', workspaceRoot: root, tool, input: { appId } });
    assert.equal(result.ok, false);
  }
  assert.equal(service.apps.size, 0);
  await service.dispose();
});

test('workspace switch cancels a pending launch before it can spawn', async () => {
  const service = new BackgroundAppService({ executable: 'must-not-spawn' });
  const launch = service.execute({ sessionId: 'owner', workspaceRoot: root, tool: 'background_app_open', input: { path: 'tests/fixtures/background-app' } });
  await service.dispose();
  const result = await launch;
  assert.equal(result.ok, false);
  assert.equal(service.apps.size, 0);
});

test('closing a session invalidates a launch that is resolving its workspace', async () => {
  const service = new BackgroundAppService({ executable: 'must-not-spawn' });
  const launch = service.execute({ sessionId: 'owner', workspaceRoot: root, tool: 'background_app_open', input: { path: 'tests/fixtures/background-app' } });
  await service.closeSession('owner');
  assert.equal((await launch).ok, false);
  assert.equal(service.apps.size, 0);
  await service.dispose();
});

test('storage rejects an existing junction that points outside its workspace', async () => {
  const directory = path.join(root, 'out', 'background-app-policy-review');
  const workspace = path.join(directory, 'workspace');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(workspace, { recursive: true }); await fs.mkdir(outside, { recursive: true });
  try { await fs.symlink(outside, path.join(workspace, '.aicode'), 'junction'); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assert.rejects(storageDirectory(workspace, ['.aicode', 'screenshots']), /outside workspace/);
  assert.deepEqual(await fs.readdir(outside), []);
});
