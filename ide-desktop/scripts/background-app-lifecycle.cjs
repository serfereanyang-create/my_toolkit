'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, fork } = require('node:child_process');
const { BackgroundAppService } = require('../electron/background-app.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'background-app-lifecycle');
const source = path.join(root, 'tests', 'fixtures', 'background-app');
const results = [];
const services = new Set();
const alive = processId => { try { process.kill(processId, 0); return true; } catch { return false; } };
async function waitFor(predicate, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(`Timed out: ${label}`);
}
async function fixture(name, mode) {
  const directory = path.join(output, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: `fixture-${name}`, main: 'lifecycle.cjs' }));
  await fs.writeFile(path.join(directory, 'mode.json'), JSON.stringify({ mode }));
  for (const filename of ['lifecycle.cjs', 'worker.cjs', 'preload.cjs', 'index.html']) await fs.copyFile(path.join(source, filename), path.join(directory, filename));
}
async function pids(name) { return JSON.parse(await fs.readFile(path.join(output, name, 'pids.json'), 'utf8')); }
async function ended(name) {
  const owned = await pids(name);
  await waitFor(() => !alive(owned.appPid) && !alive(owned.workerPid), `${name} app and worker both exit`);
}
async function check(name, callback) {
  try { await callback(); results.push({ name, ok: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); throw error; }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This lifecycle proof exercises Windows Job Objects');
  await fs.mkdir(output, { recursive: true });
  const control = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    for (const mode of ['normal-close', 'boot-failure', 'boot-hang', 'operation-hang', 'app-crash']) {
      await fixture(mode, mode);
      const service = new BackgroundAppService({ executable: require('electron'), timeoutMs: mode === 'boot-hang' ? 2000 : 10000 });
      services.add(service);
      const call = (operation, input) => service.execute({ sessionId: 'lifecycle', workspaceRoot: output, tool: `background_app_${operation}`, input });
      await check(`${mode} ends its worker without touching an unrelated Node process`, async () => {
        const opened = await call('open', { path: mode });
        if (mode === 'boot-failure' || mode === 'boot-hang') {
          assert.equal(opened.ok, false);
          assert.match(opened.output, mode === 'boot-hang' ? /超时/ : /fixture boot failure/);
        } else {
          assert.equal(opened.ok, true, opened.output);
          const appId = opened.data.appId;
          if (mode === 'normal-close') assert.equal((await call('close', { appId })).ok, true);
          else {
            if (mode === 'operation-hang') service.timeoutMs = 500;
            const clicked = await call('click', { appId, selector: '#submit' });
            if (mode === 'operation-hang') {
              const result = clicked.ok ? await call('inspect', { appId }) : clicked;
              assert.equal(result.ok, false);
              assert.match(result.output, /超时/);
            }
          }
        }
        await ended(mode);
        await waitFor(() => service.apps.size === 0, `${mode} handles clear`);
        assert.equal(alive(control.pid), true);
      });
      await service.dispose();
    }
    await fixture('host-exit', 'normal-close');
    await check('host crash releases the job and its complete application process tree', async () => {
      const host = fork(path.join(__dirname, 'background-app-host-fixture.cjs'), [output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let errors = '';
      host.stdout.on('data', () => {});
      host.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-2000); });
      try {
        const opened = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`Host fixture timeout: ${errors}`)), 15000);
          host.once('message', result => { clearTimeout(timeout); resolve(result); });
          host.once('exit', code => { clearTimeout(timeout); reject(new Error(`Host exited ${code}: ${errors}`)); });
        });
        assert.equal(opened.ok, true, opened.output);
        host.kill();
        await ended('host-exit');
        assert.equal(alive(control.pid), true);
      } finally { if (alive(host.pid)) host.kill(); }
    });
  } finally { control.kill(); }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await Promise.all([...services].map(service => service.dispose()));
  await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ date: new Date().toISOString(), results }, null, 2));
});
