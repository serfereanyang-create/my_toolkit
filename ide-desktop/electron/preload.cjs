const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('zcodeDesktop', {
  version: '0.1.0',
});
