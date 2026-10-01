// Bridge for the project picker page. The dashboard itself talks to its orchestrator over HTTP/WS
// and gets nothing from here.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') contextBridge.exposeInMainWorld('muster', {
  recent: () => ipcRenderer.invoke('muster:recent'),
  choose: () => ipcRenderer.invoke('muster:choose'),
  open: (root) => ipcRenderer.invoke('muster:open', root),
  forget: (root) => ipcRenderer.invoke('muster:forget', root),
  stop: (root) => ipcRenderer.invoke('muster:stop', root),
});
