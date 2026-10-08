'use strict';

const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
app.setName('Fake Fantasy Editor');

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const { spawn } = require('node:child_process');

let modelWindow;
let modelInitialTarget = null;

let windowRef;
let worker;
let requestSequence = 0;
let mutationBusy = false;
let shuttingDown = false;
let shutdownComplete = false;
let allowWindowClose = false;
let allowAppQuit = false;
let closePromptOpen = false;
let rendererDirty = false;
let workerFailed = false;
const pending = new Map();
const MUTATIONS = new Set(['modelConfigure', 'modelAddSources', 'modelRemoveSource', 'modelInspect', 'modelRender', 'modelApply', 'modelExport', 'modelEdit', 'createProject', 'openProject', 'refreshProject', 'replaceFile', 'replaceDirectory', 'stageFile', 'stageDirectory', 'stageFolder', 'stageText', 'resetEntry', 'resetAll', 'importEditable', 'importTableSchema', 'clearTableSchema', 'repack']);

function dirtyState() {
  return rendererDirty || workerFailed;
}

function sendTask(method, args = {}) {
  if (!worker) return Promise.reject(new Error('后台工作线程尚未启动'));
  if (MUTATIONS.has(method) && mutationBusy) return Promise.reject(new Error('当前有写入任务正在进行，请稍后再试'));
  const requestId = ++requestSequence;
  if (MUTATIONS.has(method)) mutationBusy = true;
  return new Promise((resolve, reject) => {
    pending.set(requestId, { resolve, reject, method });
    try {
      worker.postMessage({ requestId, method, args });
    } catch (error) {
      pending.delete(requestId);
      if (MUTATIONS.has(method)) mutationBusy = false;
      reject(error);
    }
  });
}

function dialogOptions(properties, options = {}) {
  return { properties, ...options };
}

async function openModelWindow(targetId = null) {
  modelInitialTarget = targetId === null || targetId === undefined ? null : String(targetId);
  if (modelWindow && !modelWindow.isDestroyed()) {
    modelWindow.show(); modelWindow.focus();
    if (modelInitialTarget !== null) modelWindow.webContents.send('model:command', { command: 'target', id: modelInitialTarget });
    return;
  }
  modelWindow = new BrowserWindow({ width: 1150, height: 820, minWidth: 900, minHeight: 640,
    title: '3D 素材转换 · Fake Fantasy Editor', backgroundColor: '#1e1e1e',
    webPreferences: { preload: path.join(__dirname, 'model-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const current = modelWindow;
  current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  current.webContents.on('will-navigate', event => event.preventDefault());
  current.on('close', event => {
    if ([...pending.values()].some(item => item.method.startsWith('model'))) {
      event.preventDefault();
      dialog.showMessageBox(current, { type: 'info', message: '转换任务仍在进行，请先取消任务或等待完成。', buttons: ['知道了'] });
    }
  });
  current.on('closed', () => {
    if (modelWindow === current) {
      modelWindow = null;
      if (!shuttingDown) sendTask('modelReset').catch(() => {});
    }
  });
  await current.loadFile(path.join(__dirname, 'model-studio.html'));
}
async function sendModelCommand(command) {
  try {
    if (!modelWindow || modelWindow.isDestroyed()) await openModelWindow();
    modelWindow.webContents.send('model:command', command);
  } catch (error) { dialog.showErrorBox('无法打开 3D 转换', error.message); }
}
function registerModelIpc() {
  const handle = (channel, action) => ipcMain.handle(channel, async (event, ...args) => {
    if (!modelWindow || event.sender !== modelWindow.webContents || event.senderFrame !== modelWindow.webContents.mainFrame) {
      throw new Error('无效的转换窗口请求');
    }
    return action(...args);
  });
  ipcMain.handle('pkg:model:open', async (event, id) => {
    if (event.sender !== windowRef?.webContents) throw new Error('无效窗口');
    await openModelWindow(id); return {};
  });
  handle('model:status', async () => ({ ...(await sendTask('modelStatus')), initialTargetId: modelInitialTarget }));
  handle('model:add', async () => {
    const result = await dialog.showOpenDialog(modelWindow, { title: '添加 3D 模型', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '3D 模型', extensions: ['glb', 'gltf', 'fbx', 'obj', 'blend', 'stl', 'ply'] }] });
    if (result.canceled) return { canceled: true };
    return sendTask('modelAddSources', { paths: result.filePaths });
  });
  handle('model:configure', async () => {
    const result = await dialog.showOpenDialog(modelWindow, { title: '选择 Blender 程序（macOS 可选择 Blender.app）', properties: ['openFile'] });
    if (result.canceled) return { canceled: true };
    const configured = await sendTask('modelConfigure', { path: result.filePaths[0] });
    await fsp.writeFile(path.join(app.getPath('userData'), 'model-converter.json'), JSON.stringify(configured), { mode: 0o600 });
    return configured;
  });
  handle('model:inspect', sourceId => sendTask('modelInspect', { sourceId }));
  handle('model:describe', (id, scale, role) => sendTask('modelDescribeTarget', { id, scale, role }));
  handle('model:render', jobs => sendTask('modelRender', { jobs }));
  handle('model:frame', (id, index) => sendTask('modelFrame', { id, index }));
  handle('model:discard', id => sendTask('modelDiscard', { id }));
  handle('model:remove', sourceId => sendTask('modelRemoveSource', { sourceId }));
  handle('model:cancel', () => { worker?.postMessage({ method: 'cancelModel' }); return {}; });
  handle('model:export', async ids => {
    const result = await dialog.showOpenDialog(modelWindow, { title: '导出二维素材到目录', properties: ['openDirectory', 'createDirectory'] });
    if (result.canceled) return { canceled: true };
    return sendTask('modelExport', { ids, directory: result.filePaths[0] });
  });
  handle('model:apply', async ids => {
    const result = await sendTask('modelApply', { ids });
    if (result.results.some(item => item.ok)) sendCommand('refreshProject');
    return result;
  });
  handle('model:edit', async sourceId => {
    const save = await dialog.showSaveDialog(modelWindow, { title: '另存 Blender 工作副本', defaultPath: 'model-workspace.blend',
      filters: [{ name: 'Blender 工作文件', extensions: ['blend'] }] });
    if (save.canceled || !save.filePath) return { canceled: true };
    const result = await sendTask('modelEdit', { sourceId, path: save.filePath });
    // A working copy, never the imported original. No shell interpolation or source scripts.
    await new Promise((resolve, reject) => {
      const child = spawn(result.blender, ['--factory-startup', '--disable-autoexec', result.path], { shell: false, detached: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
    return { source: result.source };
  });
}

function registerIpc() {
  ipcMain.handle('pkg:table-schema:import', async () => {
    const result = await dialog.showOpenDialog(windowRef, {
      title: '关联表定义 ov_res.bin', properties: ['openFile'],
      filters: [{ name: 'BIN 表定义', extensions: ['bin'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('importTableSchema', { path: result.filePaths[0] });
  });
  ipcMain.handle('pkg:table-schema:clear', () => sendTask('clearTableSchema'));
  ipcMain.handle('pkg:confirm-close-tab', async (_event, name) => {
    const result = await dialog.showMessageBox(windowRef, {
      type: 'question', title: '保存修改',
      message: `是否保存对“${String(name || '文件').slice(0, 512)}”的修改？`,
      buttons: ['保存', '不保存', '取消'], defaultId: 0, cancelId: 2, noLink: true,
    });
    return ['save', 'discard', 'cancel'][result.response] || 'cancel';
  });
  ipcMain.handle('pkg:open', async () => {
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openFile'], {
      title: '打开 PKG 文件', filters: [{ name: 'PKG 资源包', extensions: ['pkg'] }, { name: '所有文件', extensions: ['*'] }],
    }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    const sourcePath = result.filePaths[0];
    const base = path.basename(sourcePath, path.extname(sourcePath)) || 'Fantasy PKG Project';
    const target = await dialog.showSaveDialog(windowRef, {
      title: '新建工程目录', defaultPath: path.join(path.dirname(sourcePath), base),
      buttonLabel: '创建工程', properties: ['createDirectory'],
    });
    if (target.canceled || !target.filePath) return { canceled: true };
    return sendTask('createProject', { path: sourcePath, directory: target.filePath });
  });
  ipcMain.handle('pkg:project:open', async () => {
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openDirectory'], { title: '打开 Fake Fantasy Editor 工程' }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('openProject', { directory: result.filePaths[0] });
  });
  ipcMain.handle('pkg:project:refresh', () => sendTask('refreshProject'));
  ipcMain.handle('pkg:session', async () => {
    const session = await sendTask('getSession');
    return { ...session, backendDirty: false, hasUnsavedChanges: rendererDirty };
  });
  ipcMain.handle('pkg:preview', (_event, id, options = { page: 0 }) => sendTask('previewEntry', { id, options }));
  ipcMain.handle('pkg:preview-frame', (_event, id, frameIndex) => sendTask('previewFrame', { id, frameIndex }));
  ipcMain.handle('pkg:text:get', (_event, id) => sendTask('readText', { id }));
  ipcMain.handle('pkg:text:save', (_event, id, text, expectedHash) => sendTask('stageText', { id, text, expectedHash }));
  ipcMain.on('pkg:dirty', (_event, value) => { if (typeof value === 'boolean') rendererDirty = value; });
  ipcMain.handle('pkg:staged', () => sendTask('getStaged'));
  ipcMain.handle('pkg:replace-file', async (_event, id) => {
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openFile'], { title: '选择替换文件' }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('replaceFile', { id, path: result.filePaths[0] });
  });
  ipcMain.handle('pkg:replace-directory', async (_event, folderPath = '') => {
    const title = folderPath ? `选择替换目录（资源路径：${folderPath}；请选择导出的对应子目录）` : '选择替换目录';
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openDirectory'], { title }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('replaceDirectory', { path: result.filePaths[0], folderPath });
  });
  ipcMain.handle('pkg:reset-entry', (_event, id) => sendTask('resetEntry', { id }));
  ipcMain.handle('pkg:reset-all', () => sendTask('resetAll'));
  ipcMain.handle('pkg:export-selected', async (_event, ids) => {
    if (!Array.isArray(ids)) throw new Error('所选条目无效');
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openDirectory', 'createDirectory'], { title: '选择导出目录' }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('exportSelected', { ids, directory: result.filePaths[0] });
  });
  ipcMain.handle('pkg:export-all', async () => {
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openDirectory', 'createDirectory'], { title: '选择全部导出目录' }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('exportAll', { directory: result.filePaths[0] });
  });
  ipcMain.handle('pkg:export-editable', async (_event, id) => {
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openDirectory', 'createDirectory'], { title: '选择可编辑预览导出目录' }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('exportEditable', { id, directory: result.filePaths[0] });
  });
  ipcMain.handle('pkg:import-editable', async (_event, id) => {
    const result = await dialog.showOpenDialog(windowRef, dialogOptions(['openFile'], {
      title: '导入编辑后的 PNG', filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    }));
    if (result.canceled || !result.filePaths[0]) return { canceled: true };
    return sendTask('importEditable', { id, path: result.filePaths[0] });
  });
  ipcMain.handle('pkg:save-as', async () => {
    const result = await dialog.showSaveDialog(windowRef, {
      title: '另存为 PKG', defaultPath: 'edited.pkg',
      filters: [{ name: 'PKG 资源包', extensions: ['pkg'] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    return sendTask('repack', { path: result.filePath });
  });
}

function sendCommand(command) {
  if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('pkg:command', command);
}

function installApplicationMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '从 PKG 新建工程…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
        { label: '打开工程…', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendCommand('openProject') },
        { label: '刷新工程', accelerator: 'CmdOrCtrl+R', click: () => sendCommand('refreshProject') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { label: '导出 PKG…', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendCommand('saveAs') },
        { type: 'separator' },
        { label: '关闭编辑器', accelerator: 'CmdOrCtrl+W', click: () => sendCommand('closeTab') },
        { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+Shift+W' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
        { type: 'separator' },
        { label: '查找…', accelerator: 'CmdOrCtrl+F', click: () => sendCommand('find') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '快速打开…', accelerator: 'CmdOrCtrl+P', click: () => sendCommand('quickOpen') },
        { label: '切换侧边栏', accelerator: 'CmdOrCtrl+B', click: () => sendCommand('toggleSidebar') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '3D',
      submenu: [
        { label: '3D 素材转换…', click: () => openModelWindow().catch(error => dialog.showErrorBox('3D 转换', error.message)) },
        { label: '添加模型…', click: () => sendModelCommand('add') },
        { label: '读取动画列表', click: () => sendModelCommand('inspect') },
        { label: '在 Blender 中编辑工作副本…', click: () => sendModelCommand('edit') },
        { type: 'separator' },
        { label: '预览当前帧', click: () => sendModelCommand('preview') },
        { label: '转换当前模型', click: () => sendModelCommand('render') },
        { label: '批量转换全部模型', click: () => sendModelCommand('renderAll') },
        { label: '将当前参数应用到全部模型', click: () => sendModelCommand('copySettings') },
        { type: 'separator' },
        { label: '导出当前结果…', click: () => sendModelCommand('export') },
        { label: '批量导出结果…', click: () => sendModelCommand('exportAll') },
        { label: '写入当前映射资源', click: () => sendModelCommand('apply') },
        { label: '批量写入映射资源', click: () => sendModelCommand('applyAll') },
        { type: 'separator' },
        { label: '移除当前模型', click: () => sendModelCommand('remove') },
        { label: '选择 Blender…', click: () => sendModelCommand('configure') },
      ],
    },
    {
      label: '资源',
      submenu: [
        { label: '关联表定义…', click: () => sendCommand('importTableSchema') },
        { label: '取消外部表定义关联', click: () => sendCommand('clearTableSchema') },
        { type: 'separator' },
        { label: '导出所选资源…', click: () => sendCommand('exportSelected') },
        { label: '导出全部资源…', click: () => sendCommand('exportAll') },
        { type: 'separator' },
        { label: '替换文件…', click: () => sendCommand('replaceFile') },
        { label: '导入目录…', click: () => sendCommand('replaceDirectory') },
        { label: '导出为 PNG…', click: () => sendCommand('exportEditable') },
        { label: '导入 PNG…', click: () => sendCommand('importEditable') },
        { type: 'separator' },
        { label: '恢复所选资源…', click: () => sendCommand('resetEntry') },
        { label: '恢复全部资源…', click: () => sendCommand('resetAll') },
        { type: 'separator' },
        { label: '资源信息', click: () => sendCommand('info') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function confirmDiscard(reason, isWindowClose = false) {
  if (pending.size || mutationBusy) {
    const options = {
      type: 'info', title: '仍在处理中', message: '请等当前操作完成后再关闭应用。',
      detail: '当前后台任务完成前，关闭窗口可能中断读取或文件写入。', buttons: ['知道了'], defaultId: 0,
    };
    if (windowRef && !windowRef.isDestroyed()) await dialog.showMessageBox(windowRef, options);
    else await dialog.showMessageBox(options);
    return false;
  }
  if (!dirtyState()) return true;
  const buttons = process.platform === 'darwin' && isWindowClose ? ['继续编辑', '关闭窗口'] : ['继续编辑', '退出并丢弃'];
  const options = {
    type: 'warning', title: '确认关闭', message: '仍有未保存的修改或后台状态需要确认。',
    detail: reason || (process.platform === 'darwin' && isWindowClose
      ? '关闭窗口会丢弃未保存的文本草稿；已写入工程文件的修改会保留。'
      : '退出会丢弃未保存的文本草稿；已写入工程文件的修改会保留。'), buttons, defaultId: 0, cancelId: 0,
    noLink: true,
  };
  const result = windowRef && !windowRef.isDestroyed()
    ? await dialog.showMessageBox(windowRef, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

async function handleWindowClose(event) {
  if (allowWindowClose) return;
  event.preventDefault();
  if (closePromptOpen) return;
  closePromptOpen = true;
  try {
    const closeDetail = process.platform === 'darwin'
      ? '关闭窗口会丢弃未保存的文本草稿；已写入工程文件的修改会保留。'
      : '退出会丢弃未保存的文本草稿；已写入工程文件的修改会保留。';
    const confirmed = await confirmDiscard(closeDetail, true);
    if (!confirmed) return;
    if (process.platform === 'darwin') rendererDirty = false;
    allowWindowClose = true;
    if (process.platform !== 'darwin') allowAppQuit = true;
    if (windowRef && !windowRef.isDestroyed()) windowRef.close();
  } finally {
    closePromptOpen = false;
  }
}

function createWorker() {
  const activeWorker = new Worker(path.join(__dirname, 'worker.cjs'));
  worker = activeWorker;
  activeWorker.on('message', (message) => {
    if (message?.type === 'progress') {
      if (windowRef && !windowRef.isDestroyed()) windowRef.webContents.send('pkg:progress', message.progress);
      if (modelWindow && !modelWindow.isDestroyed()) modelWindow.webContents.send('model:progress', message.progress);
      return;
    }
    const item = pending.get(message?.requestId);
    if (!item) return;
    pending.delete(message.requestId);
    if (MUTATIONS.has(item.method)) mutationBusy = false;
    if (message.error) item.reject(new Error(message.error));
    else {
      item.resolve(message.result);
    }
  });
  activeWorker.on('error', (error) => {
    workerFailed = true;
    mutationBusy = false;
    for (const item of pending.values()) item.reject(error);
    pending.clear();
    if (worker === activeWorker) worker = null;
  });
  activeWorker.on('exit', (code) => {
    if (!shutdownComplete) workerFailed = true;
    mutationBusy = false;
    for (const item of pending.values()) item.reject(new Error(`后台工作线程已退出 (${code})`));
    pending.clear();
    if (worker === activeWorker) worker = null;
  });
}

function createWindow() {
  windowRef = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 620,
    backgroundColor: '#1e1e1e',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  windowRef.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const appDocumentUrl = require('node:url').pathToFileURL(path.join(__dirname, 'index.html')).href;
  windowRef.webContents.on('will-navigate', (event, url) => {
    if (url !== appDocumentUrl) event.preventDefault();
  });
  windowRef.on('close', handleWindowClose);
  windowRef.on('closed', () => { windowRef = null; allowWindowClose = false; });
  windowRef.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
  createWorker();
  try {
    const saved = JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'model-converter.json'), 'utf8'));
    if (typeof saved.blender === 'string') await sendTask('modelConfigure', { path: saved.blender });
  } catch (_) { /* A missing optional Blender installation is shown in the converter. */ }
  registerIpc();
  registerModelIpc();
  installApplicationMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  if (!allowAppQuit) {
    event.preventDefault();
    if (closePromptOpen) return;
    closePromptOpen = true;
    confirmDiscard('退出后将丢弃当前会话中尚未另存的修改。').then((confirmed) => {
      if (confirmed) {
        allowAppQuit = true;
        allowWindowClose = true;
        app.quit();
      }
    }).finally(() => { closePromptOpen = false; });
    return;
  }
  if (!worker) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  sendTask('shutdown').catch(() => {}).finally(async () => {
    const active = worker;
    worker = null;
    shutdownComplete = true;
    if (active) await active.terminate().catch(() => {});
    app.exit(0);
  });
});
