import electron, { app, BrowserWindow, ipcMain, protocol } from 'electron';
import { BrowserWindow as MainWindow } from 'electron/main';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

await new Promise(resolve => setTimeout(resolve, 25));
if (app.isReady()) throw new Error('ESM initialization ran after app.ready');
const common = await import('electron/common');
const renderer = createRequire(import.meta.url)('electron/renderer');
if (BrowserWindow !== MainWindow || BrowserWindow !== common.BrowserWindow || BrowserWindow !== renderer.BrowserWindow || electron.BrowserWindow !== BrowserWindow) throw new Error('Electron imports bypassed hidden window wrapper');
protocol.registerSchemesAsPrivileged([{ scheme: 'hidden-fixture', privileges: { standard: true, secure: true } }]);
const directory = dirname(fileURLToPath(import.meta.url));
ipcMain.handle('fixture.message', (_event, value) => `真实 IPC：${value}`);
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 960, height: 640, show: true, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  win.loadFile(join(directory, 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); win.showInactive(); win.maximize(); win.webContents.openDevTools(); });
});
