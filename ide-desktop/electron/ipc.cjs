const { dialog, ipcMain } = require('electron');

function registerIpc({ mainWindow, workspace, settings, secrets }) {
  ipcMain.handle('workspace.open', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    const root = workspace.setRoot(result.filePaths[0]);
    await settings.addRecentWorkspace(root);
    return { canceled: false, root };
  });

  ipcMain.handle('workspace.setRoot', async (_event, root) => {
    const resolved = workspace.setRoot(root);
    await settings.addRecentWorkspace(resolved);
    return { root: resolved };
  });

  ipcMain.handle('workspace.getTree', async (_event, relativePath) => await workspace.tree(relativePath || '.'));
  ipcMain.handle('fs.read', async (_event, relativePath) => await workspace.readFile(relativePath));
  ipcMain.handle('fs.write', async (_event, relativePath, content) => await workspace.writeFile(relativePath, content));
  ipcMain.handle('settings.get', async () => await settings.get());
  ipcMain.handle('settings.set', async (_event, next) => await settings.set(next));
  ipcMain.handle('secrets.setApiKey', async (_event, providerId, apiKey) => await secrets.setApiKey(providerId, apiKey));
  ipcMain.handle('secrets.hasApiKey', async (_event, providerId) => await secrets.hasApiKey(providerId));
}

module.exports = { registerIpc };
