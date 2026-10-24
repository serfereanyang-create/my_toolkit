const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('multi', { transition: () => ipcRenderer.invoke('multi.transition'), closeSecondary: () => ipcRenderer.invoke('multi.close-secondary') });
