'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

contextBridge.exposeInMainWorld('api', {
  call,
  pathForFile: (file) => webUtils.getPathForFile(file),
  onWindowState: (fn) => ipcRenderer.on('win:state', (_e, s) => fn(s)),
  onKeyProgress: (fn) => ipcRenderer.on('keys:progress', (_e, p) => fn(p)),
  onProfile: (fn) => ipcRenderer.on('profile:changed', () => fn()),
});
