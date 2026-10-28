'use strict';
require('./lib/probe-guard.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'draft-restart-review');
const profile = path.join(output, 'profile');
const workspace = path.join(output, 'workspace');
const draftText = 'RESTART_TEXT @restart-reference.txt';

function ownedDirectory(directory) {
  const marker = path.join(directory, '.draft-restart-owned.json');
  if (fs.existsSync(directory)) {
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).owner, 'yoy-draft-restart-v1');
  }
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ owner: 'yoy-draft-restart-v1' }));
}

async function orchestrate() {
  const { spawn } = require('node:child_process');
  ownedDirectory(output);
  ownedDirectory(profile);
  ownedDirectory(workspace);
  const processes = [];
  const electronPath = require('electron');
  for (const phase of ['seed', 'restore', 'empty']) {
    const logPath = path.join(output, `${phase}.log`);
    const result = await new Promise((resolve, reject) => {
      const environment = { ...process.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const child = spawn(electronPath, [__filename, '--phase', phase], {
        cwd: root, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error(`Draft restart phase timed out: ${phase}`)); }, 60000);
      child.stdout.on('data', chunk => { log += chunk.toString(); });
      child.stderr.on('data', chunk => { log += chunk.toString(); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        fs.writeFileSync(logPath, log);
        if (code !== 0) reject(new Error(`${phase} failed (${code}): ${log.slice(-1800)}`));
        else resolve({ phase, pid: child.pid, code });
      });
    });
    processes.push(result);
    console.log(`PASS new Electron process ${phase}: ${result.pid}`);
  }
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ processes, profile, workspace }, null, 2));
}

async function runElectronPhase() {
  const electron = require('electron');
  const { app, dialog } = electron;
  const Module = require('node:module');
  const phase = process.argv[process.argv.indexOf('--phase') + 1];
  assert.ok(['seed', 'restore', 'empty'].includes(phase));
  app.setPath('userData', profile);
  const chromium = path.join(profile, 'chromium');
  fs.mkdirSync(chromium, { recursive: true });
  app.setPath('sessionData', chromium);
  app.disableHardwareAcceleration();
  delete process.env.VITE_DEV_SERVER_URL;
  if (phase === 'seed') {
    const { defaultSettings } = require('../electron/settings-store.cjs');
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
      ...defaultSettings, recentWorkspaces: [workspace],
      preferences: { ...defaultSettings.preferences, 'gen.turnNotify': 'never', 'gen.permissionNotify': false },
    }));
    fs.writeFileSync(path.join(workspace, 'package.json'), '{"name":"draft-restart-fixture"}');
    fs.writeFileSync(path.join(workspace, 'restart-reference.txt'), 'REFERENCE_BODY\n');
    fs.writeFileSync(path.join(workspace, 'restart-shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AABAAA//8DAAf+Av0AAAAASUVORK5CYII=', 'base64'));
  }
  let window;
  const errors = [];
  class TestWindow extends electron.BrowserWindow {
    constructor(options) {
      super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
      window = this;
      this.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
    }
    show() {}
    focus() {}
  }
  const originalLoad = Module._load;
  const bridged = new Proxy(electron, { get: (target, property) => property === 'BrowserWindow' ? TestWindow : Reflect.get(target, property) });
  Module._load = function(request, parent, isMain) {
    return request === 'electron' ? bridged : originalLoad.call(this, request, parent, isMain);
  };
  require('../electron/main.cjs');
  const evaluate = expression => window.webContents.executeJavaScript(expression, true);
  const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const waitFor = async (expression, label) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (window && !window.isDestroyed() && await evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${label}`);
  };
  const click = async selector => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await settle();
  };
  const writeDraft = async text => {
    await evaluate(`(() => {
      const field = document.querySelector('.composer-input-row textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, ${JSON.stringify(text)});
      field.setSelectionRange(field.value.length, field.value.length);
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await settle();
  };
  await app.whenReady();
  await waitFor('!!document.querySelector(".rail")', 'production App boot');
  await click('.rail button[aria-label="对话"]');
  await waitFor('!!document.querySelector(".composer-input-row textarea")', 'composer');
  if (phase === 'seed') {
    while (await evaluate('!!document.querySelector(".file-attachment-card .file-remove")')) await click('.file-attachment-card .file-remove');
    while (await evaluate('!!document.querySelector(".mention-chip-remove")')) await click('.mention-chip-remove');
    const originalPicker = dialog.showOpenDialog;
    try {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(workspace, 'restart-shot.png')] });
      await click('.composer button[aria-label="添加附件"]');
      await waitFor('!!document.querySelector(".file-attachment-thumb")', 'selected image thumbnail');
    } finally { dialog.showOpenDialog = originalPicker; }
    await writeDraft('RESTART_TEXT @restart-reference');
    await waitFor('[...document.querySelectorAll(".mention-item")].some(item => item.textContent.includes("restart-reference.txt"))', 'file reference search');
    await evaluate('[...document.querySelectorAll(".mention-item")].find(item => item.textContent.includes("restart-reference.txt")).click()');
    await settle();
    assert.equal(await evaluate('document.querySelector(".composer-input-row textarea").value'), draftText);
    await waitFor(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(workspace)}).then(records => records.some(record => record.sessionId === null && record.text === ${JSON.stringify(draftText)} && record.files.length === 1 && record.mentions.length === 1))`, 'draft saved to the real main process');
  } else if (phase === 'restore') {
    await waitFor(`document.querySelector('.composer-input-row textarea')?.value === ${JSON.stringify(draftText)}`, 'text restored after process restart');
    assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card").length'), 1);
    assert.match(await evaluate('document.querySelector(".mention-chip").textContent'), /restart-reference.txt/);
    await waitFor('document.querySelector(".file-attachment-thumb")?.getAttribute("src")?.startsWith("data:image/png;base64,")', 'thumbnail regenerated after process restart');
    await click('.file-attachment-card .file-remove');
    await click('.mention-chip-remove');
    await writeDraft('');
    await waitFor(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(workspace)}).then(records => records.length === 0)`, 'cleared draft saved to disk');
  } else {
    await evaluate(`window.zcodeDesktop.composerDraft.load(${JSON.stringify(workspace)})`);
    await settle();
    assert.equal(await evaluate('document.querySelector(".composer-input-row textarea").value'), '');
    assert.equal(await evaluate('document.querySelectorAll(".file-attachment-card, .mention-chip").length'), 0);
  }
  await evaluate('window.zcodeDesktop.composerDraft.flush()');
  assert.deepEqual(errors, [], 'renderer errors');
  fs.writeFileSync(path.join(output, `${phase}-result.json`), JSON.stringify({ phase, pid: process.pid, ok: true, errors }, null, 2));
  console.log(`PASS ${phase}: production draft state verified`);
  window.close();
}

if (process.versions.electron) {
  runElectronPhase().catch(error => { console.error(error.stack || error); require('electron').app.exit(1); });
} else {
  orchestrate().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
}
