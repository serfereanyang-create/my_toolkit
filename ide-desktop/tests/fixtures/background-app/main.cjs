const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
ipcMain.handle('fixture.message', (_event, value) => `真实 IPC：${value}`);
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 960, height: 640, show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); win.showInactive(); win.maximize(); win.webContents.openDevTools(); });
});
