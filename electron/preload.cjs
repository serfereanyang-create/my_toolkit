const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  saveMarkdown: (defaultName, content) => ipcRenderer.invoke('paper:save-markdown', { defaultName, content }),
  exportLibrary: (defaultName, content) => ipcRenderer.invoke('paper:export-library', { defaultName, content }),
  importLibrary: () => ipcRenderer.invoke('paper:import-library'),
  importReferences: () => ipcRenderer.invoke('paper:import-references'),
  onCommand: (callback) => {
    const listener = (_event, command) => callback(command);
    ipcRenderer.on('paper:command', listener);
    return () => ipcRenderer.removeListener('paper:command', listener);
  },
  auth: {
    register: (input) => ipcRenderer.invoke('auth:register', input),
    login: (input) => ipcRenderer.invoke('auth:login', input),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getSession: () => ipcRenderer.invoke('auth:get-session'),
    updateProfile: (patch) => ipcRenderer.invoke('auth:update-profile', patch),
    changePassword: (input) => ipcRenderer.invoke('auth:change-password', input),
  },
  library: {
    load: () => ipcRenderer.invoke('library:load'),
    save: (papers) => ipcRenderer.invoke('library:save', papers),
  },
  ai: {
    getConfig: () => ipcRenderer.invoke('ai:get-config'),
    saveConfig: (input) => ipcRenderer.invoke('ai:save-config', input),
    testConnection: () => ipcRenderer.invoke('ai:test-connection'),
    generateReview: (messages) => ipcRenderer.invoke('ai:generate-review', { messages }),
    cancelReview: () => ipcRenderer.invoke('ai:cancel-review'),
    onChunk: (callback) => {
      const listener = (_event, delta) => callback(delta);
      ipcRenderer.on('ai:review-chunk', listener);
      return () => ipcRenderer.removeListener('ai:review-chunk', listener);
    },
    onDone: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('ai:review-done', listener);
      return () => ipcRenderer.removeListener('ai:review-done', listener);
    },
    onError: (callback) => {
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on('ai:review-error', listener);
      return () => ipcRenderer.removeListener('ai:review-error', listener);
    },
  },
});
