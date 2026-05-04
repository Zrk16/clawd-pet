const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clawdSettings', {
  getFullSettings: () => ipcRenderer.invoke('get-full-settings'),
  saveFullSettings: (s) => ipcRenderer.send('save-full-settings', s),
});
