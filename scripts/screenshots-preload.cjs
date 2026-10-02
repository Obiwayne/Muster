// Preload for scripts/screenshots.mjs: stands in for the desktop app's project-switcher bridge
// so the sidebar shows the project switcher in the screenshots.
const { contextBridge } = require('electron');
const projects = [
  { root: '/work/acme-app', name: 'acme-app', running: true },
  { root: '/work/storefront', name: 'storefront', running: true },
  { root: '/work/docs-site', name: 'docs-site', running: false },
];
contextBridge.exposeInMainWorld('musterApp', {
  projects: async () => ({ current: '/work/acme-app', projects }),
  switchTo: async () => ({ ok: true }),
  openFolder: async () => null,
  stopCurrent: async () => {},
  showPicker: async () => {},
});
