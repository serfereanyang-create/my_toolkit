const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
let splash;
let primary;
let secondary;
function open(screen) {
  const win = new BrowserWindow({ width: 960, height: 640, show: true, webPreferences: { preload: path.join(__dirname, 'multi-preload.cjs'), contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'multi-window.html'), { query: { screen } });
  return win;
}
ipcMain.handle('multi.transition', () => {
  primary = open('主窗口');
  secondary = open('辅助窗口');
  splash.destroy();
  return { primary: primary.id, secondary: secondary.id };
});
ipcMain.handle('multi.close-secondary', () => { secondary.destroy(); return true; });
app.whenReady().then(() => { splash = open('启动页'); });
