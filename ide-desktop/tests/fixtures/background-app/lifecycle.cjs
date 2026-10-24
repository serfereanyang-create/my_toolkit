const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const modeConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'mode.json'), 'utf8'));
const mode = modeConfig.mode;
const worker = spawn(process.execPath, [path.join(__dirname, 'worker.cjs')], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });
fs.writeFileSync(path.join(__dirname, 'pids.json'), JSON.stringify({ appPid: process.pid, workerPid: worker.pid }));
if (mode === 'boot-failure') throw new Error('fixture boot failure after starting a worker');
if (mode === 'boot-hang') { while (true) {} }
ipcMain.handle('fixture.message', (_event, value) => {
  if (mode === 'operation-hang') { fs.writeFileSync(path.join(__dirname, 'operation.json'), JSON.stringify({ processId: process.pid, token: modeConfig.token })); while (true) {} }
  if (mode === 'app-crash') app.exit(23);
  return `真实 IPC：${value}`;
});
app.whenReady().then(() => {
  const win = new BrowserWindow({ show: true, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'index.html'));
});
