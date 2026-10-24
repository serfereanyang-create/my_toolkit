const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nativeReview', { zoom: () => ipcRenderer.invoke('input.zoom') });
