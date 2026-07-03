const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  resize: (width, height) => ipcRenderer.send('hud:resize', { width, height }),
});
