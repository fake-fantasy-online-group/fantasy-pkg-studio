'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('pkgStudio', Object.freeze({
  openModelStudio: (id = null) => invoke('pkg:model:open', id),
  openArchive: () => invoke('pkg:open'),
  openProject: () => invoke('pkg:project:open'),
  importTableSchema: () => invoke('pkg:table-schema:import'),
  clearTableSchema: () => invoke('pkg:table-schema:clear'),
  refreshProject: () => invoke('pkg:project:refresh'),
  getSession: () => invoke('pkg:session'),
  previewEntry: (id, options = { page: 0 }) => invoke('pkg:preview', id, options),
  previewFrame: (id, frameIndex) => invoke('pkg:preview-frame', id, frameIndex),
  getText: (id) => invoke('pkg:text:get', id),
  saveText: (id, text, expectedHash) => invoke('pkg:text:save', id, text, expectedHash),
  confirmCloseTab: (name) => invoke('pkg:confirm-close-tab', name),
  setDirty: (dirty) => {
    if (typeof dirty === 'boolean') ipcRenderer.send('pkg:dirty', dirty);
  },
  getStaged: () => invoke('pkg:staged'),
  replaceFile: (id) => invoke('pkg:replace-file', id),
  replaceDirectory: (folderPath = '') => invoke('pkg:replace-directory', folderPath),
  resetEntry: (id) => invoke('pkg:reset-entry', id),
  resetAll: () => invoke('pkg:reset-all'),
  exportSelected: (ids) => invoke('pkg:export-selected', ids),
  exportAll: () => invoke('pkg:export-all'),
  exportEditable: (id) => invoke('pkg:export-editable', id),
  importEditable: (id) => invoke('pkg:import-editable', id),
  saveAs: () => invoke('pkg:save-as'),
  onProgress: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('pkg:progress', wrapped);
    return () => ipcRenderer.removeListener('pkg:progress', wrapped);
  },
  onCommand: (listener) => {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, command) => listener(command);
    ipcRenderer.on('pkg:command', wrapped);
    return () => ipcRenderer.removeListener('pkg:command', wrapped);
  },
}));
