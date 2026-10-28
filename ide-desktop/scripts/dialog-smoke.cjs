'use strict';
require('./lib/probe-guard.cjs');

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out', 'dialog-review');
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
let server;
let previewWindow;
const evaluate = (expression) => previewWindow.webContents.executeJavaScript(expression, true);
const settle = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const failures = [];
const reports = [];
const errors = [];

app.whenReady().then(async () => {
  const { createServer } = require('vite');
  server = await createServer({ root, cacheDir: path.join(output, 'vite'), plugins: [{ name: 'dialog-review', configureServer(vite) {
    vite.middlewares.use('/__dialog-review', async (_request, response, next) => {
      try {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(await vite.transformIndexHtml('/__dialog-review', '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="/scripts/dialog-preview.tsx"></script></body></html>'));
      } catch (error) { next(error); }
    });
  } }], server: { host: '127.0.0.1', port: 0 }, clearScreen: false });
  await server.listen();
  previewWindow = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: 'dialog-review' } });
  previewWindow.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  await previewWindow.loadURL(`http://127.0.0.1:${server.httpServer.address().port}/__dialog-review`);
  await previewWindow.webContents.insertCSS('* { transition: none !important; animation: none !important; }');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await evaluate('document.documentElement.dataset.dialogPreviewReady === "true"')) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(await evaluate('document.documentElement.dataset.dialogPreviewReady'), 'true', errors.join('\n'));
  previewWindow.webContents.debugger.attach('1.3');
  const key = async (key, code, virtualKey, modifiers = 0) => {
    await previewWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: virtualKey, modifiers, ...(key === 'Enter' ? { text: '\r' } : {}) });
    await previewWindow.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: virtualKey, modifiers });
    await settle();
  };
  const open = async (scenario) => {
    await evaluate('window.dialogPreview.open("closed")');
    await settle();
    await evaluate(`window.dialogPreview.clear(); document.querySelector('#trigger').focus(); window.dialogPreview.open(${JSON.stringify(scenario)});`);
    await settle();
  };
  const waitFor = async (expression, name) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Timed out waiting for ${name}`);
  };
  const openSave = async () => {
    await open('closed');
    await open('save');
    await evaluate('document.querySelector("#save").click()');
    await waitFor('!!document.querySelector(".confirm-dialog")', 'save conflict');
  };
  const check = async (name, action) => {
    try { await action(); reports.push({ name, ok: true }); console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, error: error.message }); reports.push({ name, ok: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  };
  const capture = async () => {
    await evaluate('window.getSelection()?.removeAllRanges()');
    await settle();
    const image = await new Promise((resolve, reject) => {
      const onPaint = (_event, _rect, frame) => { clearTimeout(timeout); resolve(frame); };
      const timeout = setTimeout(() => { previewWindow.webContents.removeListener('paint', onPaint); reject(new Error('Timed out waiting for a freshly painted screenshot')); }, 3000);
      previewWindow.webContents.once('paint', onPaint);
      previewWindow.webContents.invalidate();
    });
    return image.toPNG();
  };
  await check('Enter on focused Cancel never confirms', async () => {
    await open('confirm');
    assert.equal(await evaluate('document.activeElement.className'), 'confirm-dialog-cancel');
    await key('Enter', 'Enter', 13);
    assert.deepEqual(await evaluate('window.dialogPreview.events().map(event => event.kind)'), ['cancel']);
  });
  await check('parent rerender preserves focused action', async () => {
    await open('confirm');
    await evaluate('document.querySelector(".confirm-dialog-confirm").focus(); window.dialogPreview.rerender()');
    await settle();
    assert.equal(await evaluate('document.activeElement.classList.contains("confirm-dialog-confirm")'), true);
  });
  await check('A modal mounted open restores its trigger in StrictMode', async () => {
    await open('mounted-confirm');
    assert.equal(await evaluate('document.activeElement.classList.contains("confirm-dialog-cancel")'), true);
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('document.activeElement.id'), 'trigger');
  });
  await check('A lower approval never takes focus or shortcuts from a visible confirmation', async () => {
    await open('confirm');
    await evaluate('window.dialogPreview.showApproval()');
    await settle();
    assert.equal(await evaluate('document.activeElement.classList.contains("confirm-dialog-cancel")'), true);
    await key('y', 'KeyY', 89);
    assert.equal(await evaluate('window.dialogPreview.events().length'), 0);
    await key('Enter', 'Enter', 13);
    assert.deepEqual(await evaluate('window.dialogPreview.events().map(event => event.kind)'), ['cancel']);
    assert.equal(await evaluate('document.querySelector(".approval-modal").contains(document.activeElement)'), true);
  });
  await check('Closing a lower modal preserves the current confirmation action', async () => {
    await open('confirm');
    await evaluate('window.dialogPreview.showApproval()');
    await settle();
    await evaluate('document.querySelector(".confirm-dialog-confirm").focus(); window.dialogPreview.hideApproval()');
    await settle();
    assert.equal(await evaluate('document.activeElement.classList.contains("confirm-dialog-confirm")'), true);
  });
  await check('confirmation escapes size-contained main pane', async () => {
    await open('confirm');
    assert.equal(await evaluate('!!document.querySelector("#root .confirm-dialog-backdrop")'), false, 'modal must portal to document body');
  });
  await check('approval shortcut executes only once with inline cards present', async () => {
    await open('approval');
    await key('y', 'KeyY', 89);
    assert.deepEqual(await evaluate('window.dialogPreview.events().map(event => event.kind)'), ['approval']);
  });
  await check('Enter on focused Deny never allows', async () => {
    await open('approval');
    await evaluate('document.querySelector(".approval-modal .approval-btn.deny").focus()');
    await key('Enter', 'Enter', 13);
    assert.deepEqual(await evaluate('window.dialogPreview.events().map(event => event.value)'), ['deny']);
  });
  await check('modified approval shortcut never decides', async () => {
    await open('approval');
    await key('a', 'KeyA', 65, 2);
    assert.equal(await evaluate('window.dialogPreview.events().length'), 0);
  });
  await check('Guard ignores Escape while a decision is pending', async () => {
    await open('guard');
    await evaluate('document.querySelector(".guard-options button").click()');
    await settle();
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('window.dialogPreview.events().length'), 1);
    await evaluate('window.dialogPreview.finish()');
    await settle();
  });
  await check('Escape restores the trigger and Tab stays in the modal', async () => {
    await open('confirm');
    await key('Tab', 'Tab', 9);
    assert.equal(await evaluate('document.activeElement.classList.contains("confirm-dialog-confirm")'), true);
    await key('Tab', 'Tab', 9);
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '关闭');
    await key('Escape', 'Escape', 27);
    assert.equal(await evaluate('document.activeElement.id'), 'trigger');
    assert.deepEqual(await evaluate('window.dialogPreview.events().map(event => event.kind)'), ['cancel']);
  });
  await check('Shift Tab cycles back to the close control', async () => {
    await open('confirm');
    await key('Tab', 'Tab', 9, 8);
    assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), '关闭');
    await key('Tab', 'Tab', 9, 8);
    assert.equal(await evaluate('document.activeElement.classList.contains("confirm-dialog-confirm")'), true);
  });
  await check('Cancel, Escape and backdrop retain local edits without disk reads', async () => {
    for (const mode of ['button', 'escape', 'backdrop']) {
      await openSave();
      if (mode === 'button') await evaluate('document.querySelector(".confirm-dialog-cancel").click()');
      else if (mode === 'escape') await key('Escape', 'Escape', 27);
      else await evaluate('document.querySelector(".confirm-dialog-backdrop").dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))');
      await settle();
      const snapshot = await evaluate('window.savePreview.snapshot()');
      assert.equal(snapshot.files[0].content, '未保存的代码', mode);
      assert.equal(snapshot.files[0].dirty, true, mode);
      assert.equal(snapshot.reads, 0, mode);
      assert.equal(snapshot.writes, 0, mode);
    }
  });
  await check('Reload requires its separate button and uses disk contents', async () => {
    await openSave();
    await evaluate('document.querySelectorAll(".confirm-dialog-actions button")[1].click()');
    await waitFor('!document.querySelector(".confirm-dialog")', 'disk reload');
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.files[0].content, '磁盘新版本');
    assert.equal(snapshot.files[0].dirty, false);
    assert.equal(snapshot.reads, 1);
    assert.equal(snapshot.writes, 0);
  });
  await check('Enter on the reload action never overwrites the disk', async () => {
    await openSave();
    await evaluate('document.querySelectorAll(".confirm-dialog-actions button")[1].focus()');
    await key('Enter', 'Enter', 13);
    await waitFor('!document.querySelector(".confirm-dialog")', 'keyboard reload');
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.files[0].content, '磁盘新版本');
    assert.equal(snapshot.writes, 0);
  });
  await check('Overwrite checks the confirmed disk revision before saving', async () => {
    await openSave();
    await evaluate('document.querySelector(".confirm-dialog-confirm").click()');
    await waitFor('!document.querySelector(".confirm-dialog")', 'overwrite');
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.disk.content, '未保存的代码');
    assert.equal(snapshot.files[0].dirty, false);
    assert.equal(snapshot.writes, 1);
  });
  await check('A new disk revision requires a new overwrite decision', async () => {
    await openSave();
    await evaluate('window.savePreview.changeDisk(); document.querySelector(".confirm-dialog-confirm").click()');
    await settle();
    assert.equal(await evaluate('!!document.querySelector(".confirm-dialog")'), true);
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.writes, 0);
    assert.equal(snapshot.disk.content, '再次变化的磁盘版本');
    assert.equal(snapshot.files[0].dirty, true);
  });
  await check('Read and write failures retain local code and a retryable decision', async () => {
    for (const kind of ['read', 'write']) {
      await openSave();
      await evaluate(kind === 'read' ? 'window.savePreview.readFailure(); document.querySelectorAll(".confirm-dialog-actions button")[1].click()' : 'window.savePreview.writeFailure(); document.querySelector(".confirm-dialog-confirm").click()');
      await waitFor('window.dialogPreview.events().some(event => event.kind === "save-error")', `${kind} failure`);
      const snapshot = await evaluate('window.savePreview.snapshot()');
      assert.equal(snapshot.files[0].content, '未保存的代码');
      assert.equal(snapshot.files[0].dirty, true);
      assert.equal(await evaluate('!!document.querySelector(".confirm-dialog")'), true);
    }
  });
  await check('A late disk reload never replaces another workspace file', async () => {
    await openSave();
    await evaluate('window.savePreview.deferRead(); document.querySelectorAll(".confirm-dialog-actions button")[1].click()');
    await waitFor('window.savePreview.snapshot().reads === 1', 'deferred read');
    await evaluate('window.savePreview.switchWorkspace()');
    await settle();
    await evaluate('window.savePreview.finishRead()');
    await settle();
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.files[0].content, '新项目内容');
    assert.equal(snapshot.root, 'C:/other-project');
  });
  await check('Edits made during a pending disk reload are retained', async () => {
    await openSave();
    await evaluate('window.savePreview.deferRead(); document.querySelectorAll(".confirm-dialog-actions button")[1].click()');
    await waitFor('window.savePreview.snapshot().reads === 1', 'pending reload');
    await evaluate('window.savePreview.edit()');
    await settle();
    await evaluate('window.savePreview.finishRead()');
    await waitFor('window.dialogPreview.events().some(event => event.kind === "save-error")', 'changed draft notice');
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.files[0].content, '保存期间新增的编辑');
    assert.equal(snapshot.files[0].dirty, true);
  });
  await check('Edits made during a pending save stay dirty and save again without a conflict', async () => {
    await openSave();
    await evaluate('window.savePreview.deferSave(); document.querySelector(".confirm-dialog-confirm").click()');
    await waitFor('window.savePreview.snapshot().writes === 1', 'pending save');
    await evaluate('window.savePreview.edit()');
    await settle();
    await evaluate('window.savePreview.finishSave()');
    await waitFor('!document.querySelector(".confirm-dialog")', 'completed earlier save');
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.disk.content, '未保存的代码');
    assert.equal(snapshot.files[0].content, '保存期间新增的编辑');
    assert.equal(snapshot.files[0].dirty, true);
    await evaluate('document.querySelector("#save").click()');
    await waitFor('window.savePreview.snapshot().writes === 2', 'latest draft save without another conflict');
    await waitFor('window.savePreview.snapshot().files[0].dirty === false', 'latest draft marked saved');
    assert.equal(await evaluate('window.savePreview.snapshot().disk.content'), '保存期间新增的编辑');
  });
  await check('A previous workspace reload never blocks a new conflict', async () => {
    await openSave();
    await evaluate('window.savePreview.deferRead(); document.querySelectorAll(".confirm-dialog-actions button")[1].click()');
    await waitFor('window.savePreview.snapshot().reads === 1', 'old workspace reload');
    await evaluate('window.savePreview.switchWorkspace()');
    await settle();
    await evaluate('document.querySelector("#save").click()');
    await waitFor('!!document.querySelector(".confirm-dialog")', 'new workspace conflict');
    assert.equal(await evaluate('document.querySelector(".confirm-dialog-confirm").disabled'), false);
    await evaluate('window.savePreview.finishRead()');
    await settle();
  });
  await check('A completed old save cannot mark a reopened workspace file', async () => {
    await openSave();
    await evaluate('window.savePreview.deferSave(); document.querySelector(".confirm-dialog-confirm").click()');
    await waitFor('window.savePreview.snapshot().writes === 1', 'old workspace save');
    await evaluate('window.savePreview.switchWorkspace()');
    await settle();
    await evaluate('window.savePreview.switchWorkspace("C:/project")');
    await settle();
    await evaluate('window.savePreview.finishSave()');
    await settle();
    const snapshot = await evaluate('window.savePreview.snapshot()');
    assert.equal(snapshot.files[0].content, '新项目内容');
    assert.equal(snapshot.files[0].external, undefined);
  });
  await check('Large text and long paths fit a narrow confirmation', async () => {
    previewWindow.setContentSize(640, 560);
    await openSave();
    await evaluate('document.documentElement.style.setProperty("--fs-base", "18px"); document.querySelector(".save-conflict-path").textContent = "C:/project/" + "很长的文件夹名称/".repeat(12) + "authentication.ts"');
    await settle();
    const layout = await evaluate(`(() => {
      const dialog = document.querySelector('.confirm-dialog');
      const bounds = dialog.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, bottom: bounds.bottom, width: innerWidth, height: innerHeight, contained: dialog.scrollWidth <= dialog.clientWidth };
    })()`);
    assert.ok(layout.left >= 0 && layout.right <= layout.width);
    assert.ok(layout.bottom <= layout.height);
    assert.equal(layout.contained, true);
    fs.writeFileSync(path.join(output, 'save-conflict-large-type.png'), await capture());
    previewWindow.setContentSize(1100, 760);
    await evaluate('document.documentElement.style.removeProperty("--fs-base")');
  });
  await check('Destructive button text stays readable in both themes', async () => {
    await openSave();
    for (const theme of ['light', 'dark']) {
      await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      const contrast = await evaluate(`(() => {
        const style = getComputedStyle(document.querySelector('.confirm-dialog-confirm'));
        const context = document.createElement('canvas').getContext('2d');
        const luminance = (color) => {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => {
            const normalized = value / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const foreground = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      })()`);
      assert.ok(contrast >= 4.5, `${theme} destructive button contrast is ${contrast}`);
    }
  });
  await openSave();
  const themeImages = [];
  for (const theme of ['light', 'dark']) {
    await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
    await settle();
    const image = await capture();
    themeImages.push(image);
    fs.writeFileSync(path.join(output, `save-conflict-${theme}.png`), image);
  }
  assert.equal(themeImages[0].equals(themeImages[1]), false, 'light and dark screenshots must differ');
  await open('confirm');
  fs.writeFileSync(path.join(output, 'confirm.png'), await capture());
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ reports, errors }, null, 2));
  assert.deepEqual(failures, [], 'dialog interaction failures');
  assert.deepEqual(errors, [], 'renderer errors');
}).catch((error) => { console.error(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (previewWindow && !previewWindow.isDestroyed()) previewWindow.destroy();
  if (server) await server.close();
  app.exit(process.exitCode || 0);
});
