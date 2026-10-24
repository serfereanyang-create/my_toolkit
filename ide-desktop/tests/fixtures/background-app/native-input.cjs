const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
ipcMain.handle('input.zoom', event => { event.sender.setZoomFactor(1.5); return true; });
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1024, height: 768, show: true, webPreferences: { preload: path.join(__dirname, 'native-preload.cjs'), contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'native-input.html'));
});
