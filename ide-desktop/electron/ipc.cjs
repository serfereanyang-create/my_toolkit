const { dialog, ipcMain } = require('electron');

function registerIpc({ mainWindow, workspace, settings, secrets, agentManager }) {
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
  ipcMain.handle('agent.start', async () => await agentManager.start());
  ipcMain.handle('agent.prompt', async (_event, text) => agentManager.prompt(text));
  ipcMain.handle('agent.cancel', async () => agentManager.cancel());
  ipcMain.handle('agent.restart', async () => await agentManager.restart());
  ipcMain.handle('agent.approve', async (_event, requestId, decision) => agentManager.approve(requestId, decision));
}

module.exports = { registerIpc };
