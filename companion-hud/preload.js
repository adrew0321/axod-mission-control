const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hud', {
  resize: (width, height) => ipcRenderer.send('hud:resize', { width, height }),
  // Main pushes { port, token } (or null) whenever bridge.json appears/changes.
  onBridge: (cb) => ipcRenderer.on('hud:bridge', (_e, bridge) => cb(bridge)),
});
