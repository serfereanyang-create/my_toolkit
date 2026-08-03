const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openDb, closeDb } = require('./db.cjs');
const auth = require('./auth.cjs');
const libraryStore = require('./library-store.cjs');

let mainWindow;

function getIconPath() {
  return path.join(__dirname, '..', 'assets', 'icon.png');
}

function sendCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('paper:command', command);
  }
}

function createMenu() {
  return Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        { label: '新建论文', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('new-paper') },
        { label: '导入文献', accelerator: 'CmdOrCtrl+I', click: () => sendCommand('import-references') },
        { label: '导入资料库', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('import-library') },
        { label: '导出资料库', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('export-library') },
        { label: '导出当前 Markdown', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('export-markdown') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于科研论文辅助工作台',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: '科研论文辅助工作台',
              detail: '本地文献阅读、证据管理与引用自查工具。',
            });
          },
        },
      ],
    },
  ]);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1100,
    minHeight: 720,
    title: '科研论文辅助工作台',
    backgroundColor: '#eef2f6',
    icon: getIconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

function cleanFileName(value, fallback) {
  const name = String(value || fallback).replace(/[\\/:*?"<>|]/g, '_').trim();
  return name || fallback;
}

ipcMain.handle('paper:save-markdown', async (event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导出当前 Markdown',
    defaultPath: `${cleanFileName(defaultName, 'paper-note')}.md`,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, content, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('paper:export-library', async (event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导出资料库',
    defaultPath: `${cleanFileName(defaultName, 'paper-library')}.json`,
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, content, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

ipcMain.handle('paper:import-library', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导入资料库',
    properties: ['openFile'],
    filters: [
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const content = await fs.readFile(result.filePaths[0], 'utf8');
  return { canceled: false, filePath: result.filePaths[0], content };
});

ipcMain.handle('paper:import-references', async (event) => {
  const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
    title: '导入文献',
    properties: ['openFile'],
    filters: [
      { name: '标准引用文件', extensions: ['bib', 'ris', 'enw', 'nbib', 'txt', 'csv', 'tsv', 'ciw'] },
      { name: 'BibTeX / Google Scholar / arXiv / Crossref', extensions: ['bib'] },
      { name: 'RIS / Semantic Scholar / Crossref / EndNote', extensions: ['ris', 'enw'] },
      { name: 'PubMed NBIB', extensions: ['nbib', 'txt'] },
      { name: 'CNKI/知网文本', extensions: ['txt'] },
      { name: 'CSV / TSV 自定义表格', extensions: ['csv', 'tsv'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || result.filePaths.length === 0) return { canceled: true };
  const content = await fs.readFile(result.filePaths[0], 'utf8');
  return { canceled: false, filePath: result.filePaths[0], content };
});

ipcMain.handle('auth:register', (_event, input) => auth.register(input || {}));
ipcMain.handle('auth:login', (_event, input) => auth.login(input || {}));
ipcMain.handle('auth:logout', () => {
  auth.logout();
  return { ok: true };
});
ipcMain.handle('auth:get-session', () => {
  const session = auth.getSession();
  return session ? { user: session.user } : null;
});
ipcMain.handle('auth:update-profile', (_event, patch) => auth.updateProfile(patch || {}));
ipcMain.handle('auth:change-password', (_event, input) => auth.changePassword(input || {}));
ipcMain.handle('library:load', () => libraryStore.loadPapers());
ipcMain.handle('library:save', (_event, papers) => {
  libraryStore.savePapers(papers || []);
  return { ok: true };
});

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  openDb(userDataPath);
  auth.configureAuth({ userDataPath, sessionDays: 30 });
  Menu.setApplicationMenu(createMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  closeDb();
});
