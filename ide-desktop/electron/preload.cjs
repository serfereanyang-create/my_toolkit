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
  sessions: {
    list: () => ipcRenderer.invoke('sessions.list'),
  },
  agent: {
    start: () => ipcRenderer.invoke('agent.start'),
    prompt: (text) => ipcRenderer.invoke('agent.prompt', text),
    cancel: () => ipcRenderer.invoke('agent.cancel'),
    restart: () => ipcRenderer.invoke('agent.restart'),
    approve: (requestId, decision) => ipcRenderer.invoke('agent.approve', requestId, decision),
    onEvent: (handler) => {
      const listener = (_event, payload) => handler(payload);
      ipcRenderer.on('agent.event', listener);
      return () => ipcRenderer.removeListener('agent.event', listener);
    },
  },
});
