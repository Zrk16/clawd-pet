const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clawdSettings', {
  getFullSettings: () => ipcRenderer.invoke('get-full-settings'),
  saveFullSettings: (s) => ipcRenderer.send('save-full-settings', s),
  onUiPreset: (cb) => ipcRenderer.on('ui-preset', (_, preset) => cb(preset)),
});
