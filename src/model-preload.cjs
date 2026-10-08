'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name, ...args) => ipcRenderer.invoke(`model:${name}`, ...args);
function subscribe(channel, listener) {
  if (typeof listener !== 'function') return () => {};
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}
contextBridge.exposeInMainWorld('modelStudio', Object.freeze({
  status: () => invoke('status'),
  addSources: () => invoke('add'),
  configure: () => invoke('configure'),
  inspect: sourceId => invoke('inspect', sourceId),
  describeTarget: (id, scale, role) => invoke('describe', id, scale, role),
  render: jobs => invoke('render', jobs),
  frame: (id, index) => invoke('frame', id, index),
  discard: id => invoke('discard', id),
  remove: sourceId => invoke('remove', sourceId),
  export: ids => invoke('export', ids),
  apply: ids => invoke('apply', ids),
  edit: sourceId => invoke('edit', sourceId),
  cancel: () => invoke('cancel'),
  onProgress: listener => subscribe('model:progress', listener),
  onCommand: listener => subscribe('model:command', listener),
}));
