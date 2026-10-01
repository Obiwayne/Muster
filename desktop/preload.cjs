// Bridge for the project picker page. The dashboard itself talks to its orchestrator over HTTP/WS
// and gets nothing from here.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') contextBridge.exposeInMainWorld('muster', {
  recent: () => ipcRenderer.invoke('muster:recent'),
  choose: () => ipcRenderer.invoke('muster:choose'),
  open: (root) => ipcRenderer.invoke('muster:open', root),
  forget: (root) => ipcRenderer.invoke('muster:forget', root),
  stop: (root) => ipcRenderer.invoke('muster:stop', root),
  getName: () => ipcRenderer.invoke('muster:getName'),
  setName: (name) => ipcRenderer.invoke('muster:setName', name),
  closeChoice: (r) => ipcRenderer.send('muster:closeChoice', r),
});

// The dashboard (served by the project's own orchestrator on localhost) gets project switching only.
if (location.protocol === 'http:' && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  contextBridge.exposeInMainWorld('musterApp', {
    projects: () => ipcRenderer.invoke('app:projects'),
    switchTo: (root) => ipcRenderer.invoke('app:switch', root),
    openFolder: () => ipcRenderer.invoke('app:openFolder'),
    stopCurrent: () => ipcRenderer.invoke('app:stopCurrent'),
    showPicker: () => ipcRenderer.invoke('app:picker'),
  });
}
