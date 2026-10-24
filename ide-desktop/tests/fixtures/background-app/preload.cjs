const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fixture', { message: value => ipcRenderer.invoke('fixture.message', value) });
