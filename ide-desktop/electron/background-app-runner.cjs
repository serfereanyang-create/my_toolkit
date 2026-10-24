'use strict';
const electron = require('electron');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildInspectScript, buildFillScript } = require('./background-browser.cjs');
const { clickRenderer, keyRenderer, typeRenderer, withRenderer } = require('./background-input.cjs');
const { app, BrowserWindow } = electron;
const settings = JSON.parse(process.argv[2]);
const windows = new Set();
const errors = [];
let blockedDisplays = 0;
const send = message => { if (process.connected) process.send(message, () => {}); };
const describe = () => [...windows].filter(win => !win.isDestroyed()).map(win => ({ windowId: win.id, title: win.webContents.getTitle(), url: win.webContents.getURL(), loading: win.webContents.isLoadingMainFrame(), visible: win.isVisible(), focused: win.isFocused() }));

app.setAppPath(settings.project);
app.setName(`yoy-background-${path.basename(settings.profile)}`);
for (const [name, suffix] of [['userData', ''], ['sessionData', 'chromium'], ['crashDumps', 'crashes']]) {
  const directory = path.join(settings.profile, suffix);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(name, directory);
}
app.setAppLogsPath(path.join(settings.profile, 'logs'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.on('window-all-closed', () => {});

class HiddenWindow extends BrowserWindow {
  constructor(options = {}) {
    super({ ...options, show: false, skipTaskbar: true, focusable: false, fullscreen: false, kiosk: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    windows.add(this);
    this.once('closed', () => windows.delete(this));
    this.webContents.openDevTools = () => { blockedDisplays += 1; };
    const setWindowOpenHandler = this.webContents.setWindowOpenHandler.bind(this.webContents);
    this.webContents.setWindowOpenHandler = () => setWindowOpenHandler(() => ({ action: 'deny' }));
    this.webContents.setWindowOpenHandler();
    this.webContents.focus = () => {};
    this.webContents.on('render-process-gone', (_event, details) => errors.push(`renderer: ${details.reason}`));
    this.webContents.on('console-message', (_event, level, message) => { if (level >= 3) { errors.push(message); if (errors.length > 20) errors.shift(); } });
  }
  show() { blockedDisplays += 1; }
  showInactive() { blockedDisplays += 1; }
  focus() { blockedDisplays += 1; }
  restore() { blockedDisplays += 1; }
  maximize() { blockedDisplays += 1; }
  setFullScreen() { blockedDisplays += 1; }
  setKiosk() { blockedDisplays += 1; }
}
const unavailable = () => { throw new Error('后台运行不支持原生对话框，请使用应用内界面。'); };
const dialog = new Proxy(electron.dialog, { get: () => unavailable });
const hiddenElectron = new Proxy(electron, { get: (target, property) => property === 'BrowserWindow' ? HiddenWindow : property === 'dialog' ? dialog : Reflect.get(target, property) });
const originalLoad = Module._load;
const electronAliases = ['electron', 'electron/main', 'electron/common', 'electron/renderer'];
Module._load = function(name, parent, isMain) { return electronAliases.includes(name) ? hiddenElectron : originalLoad.call(this, name, parent, isMain); };
globalThis[Symbol.for('yoycode.backgroundElectron')] = hiddenElectron;
const facadePath = path.join(settings.profile, 'electron-facade.mjs');
const exportNames = Object.keys(electron).filter(name => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) && name !== 'default');
fs.writeFileSync(facadePath, `const api = globalThis[Symbol.for('yoycode.backgroundElectron')];\nexport default api;\n${exportNames.map(name => `export const ${name} = api.${name};`).join('\n')}\n`, { flag: 'wx' });
Module.register(pathToFileURL(path.join(__dirname, 'background-app-loader.mjs')).href, { parentURL: pathToFileURL(__filename).href, data: { facade: pathToFileURL(facadePath).href } });

async function readyWindow(windowId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const win = [...windows].find(candidate => !candidate.isDestroyed() && (windowId === undefined || candidate.id === windowId));
    if (windowId !== undefined && !win) throw new Error(`窗口 ${windowId} 已关闭或不存在。请调用 background_app_windows 刷新窗口列表后重新选择。`);
    if (win && win.webContents.getURL() && win.webContents.getURL() !== 'about:blank' && !win.webContents.isLoadingMainFrame() && await win.webContents.executeJavaScript('document.readyState !== "loading"').catch(() => false)) return win;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('未找到加载完成的 Electron 窗口。');
}

async function screenshot(win) {
  const contents = win.webContents;
  await contents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await new Promise((resolve, reject) => {
    const onPaint = (_event, _rect, frame) => { clearTimeout(timer); resolve(frame); };
    const timer = setTimeout(() => { contents.removeListener('paint', onPaint); reject(new Error('等待新渲染帧超时。')); }, 5000);
    contents.once('paint', onPaint);
    contents.invalidate();
  });
  const image = await contents.capturePage();
  if (image.isEmpty()) throw new Error('后台渲染返回空图像。');
  const size = image.getSize();
  const [width, height] = win.getContentSize();
  return { png: image.toPNG().toString('base64'), width: size.width, height: size.height, viewport: { width, height } };
}

async function operate(operation, input) {
  if (operation === 'windows') return { windows: describe(), blockedDisplays, rendererErrors: errors.slice() };
  if (['click', 'fill', 'type', 'key'].includes(operation) && input.windowId === undefined && [...windows].filter(win => !win.isDestroyed()).length > 1) throw new Error('当前存在多个窗口，请先调用 background_app_windows 并明确指定 windowId，避免操作错误的窗口。');
  const win = await readyWindow(input.windowId);
  if (win.isVisible() || win.isFocused()) throw new Error('后台窗口可见性异常，拒绝继续。');
  const contents = win.webContents;
  return withRenderer(contents, async () => {
    if (operation === 'screenshot') return { ...await screenshot(win), windowId: win.id, windows: describe(), blockedDisplays, rendererErrors: errors.slice() };
    if (operation === 'inspect') return { snapshot: await contents.executeJavaScript(buildInspectScript(100)), windowId: win.id, windows: describe(), blockedDisplays, rendererErrors: errors.slice() };
    const result = operation === 'click' ? await clickRenderer(win, input)
      : operation === 'key' ? await keyRenderer(win, input)
        : operation === 'type' ? await typeRenderer(win, input)
          : operation === 'fill' ? await contents.executeJavaScript(buildFillScript(input.selector, input.value), true) : undefined;
    if (!result) throw new Error('不支持的后台操作。');
    if (!result?.ok) throw new Error(result?.reason || '后台操作失败。');
    return { ...result, windowId: win.id, windows: describe() };
  });
}

process.on('message', message => {
  if (message?.operation === 'start') return;
  if (message?.operation === 'close') { app.exit(0); return; }
  void operate(message?.operation, message?.input ?? {}).then(result => send({ id: message.id, result })).catch(error => send({ id: message.id, error: error.message }));
});
process.on('disconnect', () => app.exit(0));
process.on('uncaughtException', error => { send({ id: 'ready', error: error.message }); app.exit(1); });
process.on('unhandledRejection', error => { send({ id: 'ready', error: String(error) }); app.exit(1); });

async function start() {
  try {
    if (settings.waitForHost) await new Promise(resolve => {
      const startFromHost = message => {
        if (message?.operation !== 'start') return;
        process.removeListener('message', startFromHost);
        resolve();
      };
      process.on('message', startFromHost);
      send({ id: 'bootstrap', result: { waiting: true } });
    });
    for (const alias of electronAliases) {
      const facade = await import(alias);
      if (facade.BrowserWindow !== HiddenWindow || facade.default !== hiddenElectron) throw new Error('Electron 模块未进入隐藏渲染模式，已取消启动。');
    }
    process.argv = [process.execPath, settings.project];
    if (settings.moduleFormat === 'module') await import(pathToFileURL(settings.entry).href);
    else require(settings.entry);
    app.whenReady().then(async () => {
      const win = await readyWindow();
      if (settings.width || settings.height) { const [width, height] = win.getContentSize(); win.setContentSize(settings.width ?? width, settings.height ?? height); }
      send({ id: 'ready', result: { windows: describe(), windowId: win.id, moduleFormat: settings.moduleFormat } });
    }).catch(error => { send({ id: 'ready', error: error.message }); app.exit(1); });
  } catch (error) { send({ id: 'ready', error: error.message }); app.exit(1); }
}

module.exports = { start };
