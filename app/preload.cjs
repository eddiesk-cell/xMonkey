// Preload bridge. This file defines the ENTIRE surface the renderer can touch.
//
// contextIsolation is on and the renderer is sandboxed, so everything the UI can
// do is listed here and nowhere else. Keep it small and specific: no generic
// `invoke(channel, ...)` escape hatch, because that would hand the renderer the
// whole main-process IPC namespace.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xmonkey', {
  version: () => ipcRenderer.invoke('app:info'),

  // ---- session lifecycle
  startSession: (opts) => ipcRenderer.invoke('session:start', opts),
  send: (text) => ipcRenderer.invoke('session:send', text),
  stop: () => ipcRenderer.invoke('session:stop'),
  closeSession: () => ipcRenderer.invoke('session:close'),
  todos: () => ipcRenderer.invoke('session:todos'),

  // ---- discovery
  probeModels: (cwd) => ipcRenderer.invoke('models:probe', cwd),
  recentSessions: () => ipcRenderer.invoke('sessions:recent'),
  scaffoldConfig: (dir) => ipcRenderer.invoke('config:scaffold', dir),

  // ---- misc
  pickFolder: () => ipcRenderer.invoke('app:pick-folder'),
  openPath: (p) => ipcRenderer.invoke('app:open-path', p),
  answerPermission: (id, approved) => ipcRenderer.invoke('permission:answer', { id, approved }),

  // ---- events (main -> renderer)
  onEvent: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('session:event', h);
    return () => ipcRenderer.removeListener('session:event', h);
  },
  onPermissionAsk: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('permission:ask', h);
    return () => ipcRenderer.removeListener('permission:ask', h);
  },
  onPermissionExpired: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on('permission:expired', h);
    return () => ipcRenderer.removeListener('permission:expired', h);
  },
  onMenu: (name, cb) => {
    const ch = `menu:${name}`;
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  },
});
