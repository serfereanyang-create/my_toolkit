const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zcodeDesktop', {
  version: '0.1.0',
  workspace: {
    open: () => ipcRenderer.invoke('workspace.open'),
    setRoot: (root) => ipcRenderer.invoke('workspace.setRoot', root),
    getTree: (relativePath) => ipcRenderer.invoke('workspace.getTree', relativePath),
  },
  fs: {
    read: (relativePath) => ipcRenderer.invoke('fs.read', relativePath),
    write: (relativePath, content) => ipcRenderer.invoke('fs.write', relativePath, content),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings.get'),
    set: (next) => ipcRenderer.invoke('settings.set', next),
  },
  secrets: {
    setApiKey: (providerId, apiKey) => ipcRenderer.invoke('secrets.setApiKey', providerId, apiKey),
    hasApiKey: (providerId) => ipcRenderer.invoke('secrets.hasApiKey', providerId),
  },
});
