'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Worker } = require('node:worker_threads');

const SCHEME = 'fantasypkg';
const STATE_KEY = 'fantasyPkg.mounts.v1';
const MAX_PENDING = 8;

class PackageWorker {
  constructor(workerPath) {
    this.worker = new Worker(workerPath);
    this.nextId = 1;
    this.pending = new Map();
    this.waiters = [];
    this.closed = false;
    this.failure = null;
    this.worker.on('message', message => {
      if (message?.type === 'progress') {
        const request = this.pending.get(message.requestId);
        for (const listener of request?.listeners || []) listener(message.value);
        return;
      }
      const request = this.pending.get(message?.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.result);
      this.releaseSlot();
    });
    this.worker.on('error', error => this.failAll(error));
    this.worker.on('exit', code => {
      if (!this.closed) this.failAll(new Error(`PKG worker stopped (${code}).`));
    });
  }

  releaseSlot() {
    const next = this.waiters.shift();
    if (next) next();
  }

  failAll(error) {
    if (!this.failure) this.failure = error;
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    while (this.waiters.length) this.waiters.shift()();
  }

  async call(method, args = {}, onProgress) {
    if (this.closed) throw this.failure || new Error('PKG worker is closed.');
    if (this.pending.size >= MAX_PENDING) await new Promise(resolve => this.waiters.push(resolve));
    if (this.closed) throw this.failure || new Error('PKG worker is closed.');
    const requestId = this.nextId++;
    let resolveRequest;
    let rejectRequest;
    const result = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    this.pending.set(requestId, { resolve: resolveRequest, reject: rejectRequest, listeners: onProgress ? [onProgress] : [] });
    try { this.worker.postMessage({ requestId, method, args }); }
    catch (error) { this.pending.delete(requestId); this.releaseSlot(); rejectRequest(error); }
    return result;
  }

  async dispose() {
    if (!this.closed) await this.call('shutdown').catch(() => {});
    this.closed = true;
    this.failAll(new Error('PKG worker was closed.'));
    await this.worker.terminate();
  }
}

function makeUri(mountId, relativePath = '') {
  const pathname = relativePath ? `/${relativePath}` : '/';
  return vscode.Uri.from({ scheme: SCHEME, authority: mountId, path: pathname });
}

function safeSegments(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) return null;
  const parts = name.replace(/\\/g, '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) return null;
  return parts;
}

function uniqueName(parent, name, entryId) {
  const existing = parent.children.get(name);
  if (!existing) return name;
  const ext = path.posix.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let candidate = `${stem} (entry ${entryId})${ext}`;
  let ordinal = 2;
  while (parent.children.has(candidate)) candidate = `${stem} (entry ${entryId}-${ordinal++})${ext}`;
  return candidate;
}

function createMountIndex(mount, entries) {
  const root = { name: mount.name, type: vscode.FileType.Directory, relativePath: '', children: new Map() };
  mount.nodes = new Map([['/', root]]);
  mount.filesByUri = new Map();
  let skipped = 0;
  for (const entry of entries) {
    const parts = safeSegments(entry.name);
    if (!parts) { skipped += 1; continue; }
    let node = root;
    let relative = '';
    for (let i = 0; i < parts.length; i += 1) {
      const isFile = i === parts.length - 1;
      let label = parts[i];
      const existing = node.children.get(label);
      if (!isFile && existing?.type === vscode.FileType.File) {
        throw new Error(`PKG path collision: a file is also used as a folder (${parts.slice(0, i + 1).join('/')}).`);
      }
      if (isFile && existing?.type === vscode.FileType.Directory) {
        throw new Error(`PKG path collision: a folder is also used as a file (${parts.join('/')}).`);
      }
      if (isFile && existing) label = uniqueName(node, label, entry.id);
      let child = node.children.get(label);
      if (!child) {
        relative = relative ? `${relative}/${label}` : label;
        child = {
          name: label,
          type: isFile ? vscode.FileType.File : vscode.FileType.Directory,
          relativePath: relative,
          ...(isFile ? { entry } : { children: new Map() }),
        };
        node.children.set(label, child);
        mount.nodes.set(`/${relative}`, child);
      } else {
        relative = child.relativePath;
      }
      if (isFile) {
        const uri = makeUri(mount.id, child.relativePath);
        child.uri = uri;
        mount.filesByUri.set(uri.toString(), child);
      }
      node = child;
    }
  }
  mount.rootUri = makeUri(mount.id);
  mount.skipped = skipped;
}

class PackageFileSystemProvider {
  constructor(mounts) {
    this.mounts = mounts;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this.emitter.event;
  }
  watch() { return new vscode.Disposable(() => {}); }
  mountFor(uri) {
    const mount = this.mounts.get(uri.authority);
    if (!mount || uri.scheme !== SCHEME) throw vscode.FileSystemError.FileNotFound(uri);
    return mount;
  }
  nodeFor(uri) {
    const mount = this.mountFor(uri);
    const node = mount.nodes.get(uri.path || '/');
    if (!node) throw vscode.FileSystemError.FileNotFound(uri);
    return { mount, node };
  }
  stat(uri) {
    const { node } = this.nodeFor(uri);
    return { type: node.type, ctime: 0, mtime: 0, size: node.type === vscode.FileType.File ? node.entry.size : 0 };
  }
  readDirectory(uri) {
    const { node } = this.nodeFor(uri);
    if (node.type !== vscode.FileType.Directory) throw vscode.FileSystemError.FileNotADirectory(uri);
    return Array.from(node.children, ([name, child]) => [name, child.type]);
  }
  async readFile(uri) {
    const { mount, node } = this.nodeFor(uri);
    if (node.type !== vscode.FileType.File) throw vscode.FileSystemError.FileIsADirectory(uri);
    return Buffer.from(await mount.worker.call('read', { id: node.entry.id }));
  }
  writeFile(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
  createDirectory(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
  delete(uri) { throw vscode.FileSystemError.NoPermissions(uri); }
  rename() { throw vscode.FileSystemError.NoPermissions(); }
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function previewHtml(webview, result) {
  const csp = `default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline';`;
  let body;
  if (result.kind === 'image') {
    body = `<img alt="" src="data:${htmlEscape(result.mime)};base64,${result.base64}">`;
  } else if (result.kind === 'audio') {
    body = `<audio controls preload="metadata" src="data:${htmlEscape(result.mime)};base64,${result.base64}"></audio>`;
  } else {
    body = `<pre>${htmlEscape(result.text || '')}</pre>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body{margin:0;min-height:100%;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground)}body{padding:16px;box-sizing:border-box}img{display:block;max-width:100%;max-height:calc(100vh - 32px);object-fit:contain}audio{width:min(100%,560px)}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--vscode-editor-font-weight) var(--vscode-editor-font-size)/1.5 var(--vscode-editor-font-family);tab-size:4}</style></head><body>${body}</body></html>`;
}

function animationHtml(webview, result, extensionUri) {
  const framesPerDirection = Number(result.framesPerDirection);
  const directionNames = Array.isArray(result.directions)
    ? result.directions.map((value, index) => typeof value === 'string' ? value : `方向 ${index + 1}`)
    : Number.isSafeInteger(result.directions) && result.directions > 0
      ? Array.from({ length: result.directions }, (_, index) => `方向 ${index + 1}`)
      : [];
  const totalFrames = framesPerDirection * directionNames.length;
  const frameIndex = Number(result.frameIndex);
  if (!Number.isSafeInteger(framesPerDirection) || framesPerDirection < 1 || !directionNames.length ||
      !Number.isSafeInteger(totalFrames) || totalFrames > 1000000 ||
      !Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= totalFrames ||
      typeof result.base64 !== 'string') {
    throw new Error('Animation preview returned invalid frame information.');
  }
  const nonce = crypto.randomBytes(16).toString('hex');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'animation.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'animation.css'));
  const options = directionNames.map((name, index) => `<option value="${index}">${htmlEscape(name)}</option>`).join('');
  const csp = `default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${htmlEscape(styleUri.toString())}"><script nonce="${nonce}" defer src="${htmlEscape(scriptUri.toString())}"></script></head><body><main id="animation" data-frames-per-direction="${framesPerDirection}" data-frame-index="${frameIndex}"><div class="controls"><label for="direction">方向</label><select id="direction">${options}</select><button id="previous" type="button" aria-label="上一帧">‹</button><button id="play" type="button" aria-pressed="false">播放</button><button id="next" type="button" aria-label="下一帧">›</button><input id="frame" type="range" min="0" max="${framesPerDirection - 1}" value="${frameIndex % framesPerDirection}" aria-label="动画帧"><output id="frame-label">${(frameIndex % framesPerDirection) + 1} / ${framesPerDirection}</output><label for="fps">FPS</label><input id="fps" type="number" min="1" max="30" step="1" value="8" title="预览播放速度；资源本身未提供官方时序信息" aria-label="预览播放速度，帧每秒"></div><div class="stage"><img id="frame-image" alt="动画帧" src="data:image/png;base64,${result.base64}"></div><output id="status" aria-live="polite"></output></main></body></html>`;
  return { html, totalFrames };
}

async function externalFingerprint(uri, stat) {
  if (uri.scheme === 'file') {
    const value = await fs.stat(uri.fsPath, { bigint: true });
    return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].map(String).join(':');
  }
  return [stat.size, stat.mtime, stat.ctime].map(String).join(':');
}

async function activate(context) {
  const mounts = new Map();
  let externalPreviewWorker;
  const mountChanges = new vscode.EventEmitter();
  const decorationChanges = new vscode.EventEmitter();
  const provider = new PackageFileSystemProvider(mounts);
  context.subscriptions.push(mountChanges, decorationChanges, provider.emitter);
  context.subscriptions.push(vscode.workspace.registerFileSystemProvider(SCHEME, provider, { isReadonly: true, isCaseSensitive: true }));
  context.subscriptions.push(vscode.window.registerFileDecorationProvider({
    onDidChangeFileDecorations: decorationChanges.event,
    provideFileDecoration(uri) {
      const mount = mounts.get(uri.authority);
      const node = mount?.nodes.get(uri.path || '/');
      if (node?.type === vscode.FileType.File && mount.staged.has(String(node.entry.id))) {
        return { badge: 'R', tooltip: '替换项已暂存', color: new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') };
      }
      return undefined;
    },
  }));

  function refreshMount(mount) {
    decorationChanges.fire(undefined);
  }

  function registerCommand(name, handler) {
    return vscode.commands.registerCommand(name, async (...args) => {
      try { return await handler(...args); }
      catch (error) { await vscode.window.showErrorMessage(error?.message || String(error)); return undefined; }
    });
  }

  async function addWorkspaceFolder(uri, name) {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.some(folder => folder.uri.toString() === uri.toString())) return true;
    const changed = new Promise(resolve => {
      const timer = setTimeout(() => { sub.dispose(); resolve(false); }, 10000);
      const sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        clearTimeout(timer); sub.dispose(); resolve(true);
      });
    });
    if (!vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name })) {
      return false;
    }
    return changed;
  }

  async function mountArchive(filePath, restoredId) {
    const realPath = await fs.realpath(filePath);
    if (!restoredId) {
      const existing = Array.from(mounts.values()).find(item => item.realPath === realPath);
      if (existing) return existing;
    }
    const mountId = restoredId || require('node:crypto').createHash('sha256').update(realPath).digest('hex').slice(0, 32);
    const worker = new PackageWorker(path.join(context.extensionPath, 'worker.cjs'));
    const savedBefore = context.globalState.get(STATE_KEY, []);
    let recordSaved = false;
    try {
      const opened = await worker.call('open', { path: realPath, mountId });
      const name = path.basename(realPath);
      const mount = { id: mountId, path: realPath, realPath, name, worker, staged: new Set(opened.staged || []) };
      createMountIndex(mount, opened.entries);
      mounts.set(mountId, mount);
      const next = savedBefore.filter(item => item.id !== mountId);
      next.push({ id: mountId, path: realPath });
      await context.globalState.update(STATE_KEY, next);
      recordSaved = true;
      if (!await addWorkspaceFolder(mount.rootUri, name)) {
        mounts.delete(mountId);
        await context.globalState.update(STATE_KEY, savedBefore);
        recordSaved = false;
        await worker.dispose();
        throw new Error('The PKG workspace folder could not be added to the Explorer.');
      }
      mountChanges.fire();
      return mount;
    } catch (error) {
      if (recordSaved && !mounts.has(mountId)) await context.globalState.update(STATE_KEY, savedBefore).catch(() => {});
      if (!mounts.has(mountId)) await worker.dispose().catch(() => {});
      throw error;
    }
  }

  async function restoreMounts() {
    const saved = context.globalState.get(STATE_KEY, []);
    const errors = [];
    const currentIds = new Set((vscode.workspace.workspaceFolders || [])
      .filter(folder => folder.uri.scheme === SCHEME).map(folder => folder.uri.authority));
    for (const item of saved) {
      if (!item || typeof item.path !== 'string' || typeof item.id !== 'string' || !currentIds.has(item.id)) continue;
      try { await mountArchive(item.path, item.id); }
      catch (error) { errors.push(`${path.basename(item.path)}: ${error.message}`); }
    }
    if (errors.length) vscode.window.showWarningMessage(`Some saved PKG mounts could not be restored: ${errors.join('; ')}`);
  }

  function targetFrom(args) {
    if (args instanceof vscode.Uri && args.scheme === SCHEME) return args;
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === SCHEME) return active;
    return null;
  }
  function selectedNode(args) {
    const uri = targetFrom(args);
    if (!uri) throw new Error('Select a PKG resource in the Explorer first.');
    const { mount, node } = provider.nodeFor(uri);
    return { uri, mount, node };
  }
  async function assertNotMountedArchive(target) {
    const targetPath = path.resolve(target.fsPath);
    let realTarget = targetPath;
    try { realTarget = await fs.realpath(targetPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { realTarget = path.join(await fs.realpath(path.dirname(targetPath)), path.basename(targetPath)); }
      catch (_) { /* Use the resolved path when the destination directory does not exist. */ }
    }
    if (Array.from(mounts.values()).some(mount => mount.realPath === targetPath || mount.realPath === realTarget)) {
      throw new Error('An open source PKG archive cannot be overwritten. Choose a different output path.');
    }
  }
  async function progressTask(title, mount, method, args) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, progress => {
      let last = 0;
      return mount.worker.call(method, args, value => {
        const complete = value.total ? Math.min(100, Math.max(0, (value.done / value.total) * 100)) : last;
        progress.report({ increment: Math.max(0, complete - last), message: value.message || undefined });
        last = complete;
      });
    });
  }

  context.subscriptions.push(vscode.window.registerCustomEditorProvider('fantasyPkg.preview', {
    openCustomDocument(uri) { return { uri, dispose() {} }; },
    async resolveCustomEditor(document, webviewPanel) {
      const webview = webviewPanel.webview;
      webview.options = { enableScripts: false, localResourceRoots: [] };
      try {
        let result;
        let getFrame;
        const documentUri = document.uri.toString();
        if (document.uri.scheme === SCHEME) {
          const { mount, node } = provider.nodeFor(document.uri);
          if (node.type !== vscode.FileType.File) throw new Error('Folders do not have a preview.');
          const source = { kind: 'archive', documentUri, mountId: mount.id, entryId: node.entry.id };
          result = await mount.worker.call('preview', { id: node.entry.id, documentUri });
          getFrame = frameIndex => mount.worker.call('previewFrame', { source, frameIndex });
        } else {
          const name = path.posix.basename(document.uri.path);
          const stat = await vscode.workspace.fs.stat(document.uri);
          if (stat.size > 67108864) throw new Error('File exceeds the 64 MiB preview limit.');
          let sourceFingerprint = await externalFingerprint(document.uri, stat);
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          if (bytes.byteLength > 67108864) throw new Error('File exceeds the 64 MiB preview limit.');
          if (!externalPreviewWorker) externalPreviewWorker = new PackageWorker(path.join(context.extensionPath, 'worker.cjs'));
          const source = { kind: 'external', documentUri };
          result = await externalPreviewWorker.call('previewBytes', { bytes, name, documentUri, fingerprint: sourceFingerprint });
          getFrame = async frameIndex => {
            const latestStat = await vscode.workspace.fs.stat(document.uri);
            if (latestStat.size > 67108864) throw new Error('File exceeds the 64 MiB preview limit.');
            const fingerprint = await externalFingerprint(document.uri, latestStat);
            let frameResult;
            if (fingerprint === sourceFingerprint) {
              frameResult = await externalPreviewWorker.call('previewFrame', { source, name, fingerprint, frameIndex });
            }
            if (!frameResult || frameResult.needSource) {
              const latestBytes = await vscode.workspace.fs.readFile(document.uri);
              if (latestBytes.byteLength > 67108864) throw new Error('File exceeds the 64 MiB preview limit.');
              frameResult = await externalPreviewWorker.call('previewFrame', { source, name, fingerprint, bytes: latestBytes, frameIndex });
            }
            sourceFingerprint = fingerprint;
            return frameResult;
          };
        }
        if (result.kind !== 'animation') {
          webview.html = previewHtml(webview, result);
          return;
        }
        const animation = animationHtml(webview, result, context.extensionUri);
        webview.options = {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        };
          webview.html = animation.html;

        let disposed = false;
        let visible = webviewPanel.visible;
        let generation = 0;
        let lastSequence = 0;
        let active = false;
        let pending = null;
        async function pumpFrames() {
          if (disposed || !visible || active || !pending) return;
          const request = pending;
          pending = null;
          active = true;
          const requestGeneration = generation;
          try {
            const frameResult = await getFrame(request.frameIndex);
            if (frameResult.kind !== 'animation') throw new Error('This resource has no animation frame at that index.');
            if (frameResult.frameIndex !== request.frameIndex || typeof frameResult.base64 !== 'string') {
              throw new Error('Animation preview returned the wrong frame.');
            }
            if (!disposed && visible && requestGeneration === generation && request.sequence === lastSequence) {
              webview.postMessage({ type: 'frame', sequence: request.sequence, frameIndex: frameResult.frameIndex, base64: frameResult.base64 });
            }
          } catch (error) {
            if (!disposed && visible && requestGeneration === generation && request.sequence === lastSequence) {
              webview.postMessage({ type: 'frame', sequence: request.sequence, frameIndex: request.frameIndex, error: error.message || String(error) });
            }
          } finally {
            active = false;
            if (pending) pumpFrames();
          }
        }
        const messageSubscription = webview.onDidReceiveMessage(message => {
          if (!message || message.type !== 'frame' || !Number.isSafeInteger(message.sequence) ||
              message.sequence <= lastSequence || !Number.isSafeInteger(message.frameIndex) ||
              message.frameIndex < 0 || message.frameIndex >= animation.totalFrames) return;
          lastSequence = message.sequence;
          pending = { sequence: message.sequence, frameIndex: message.frameIndex };
          pumpFrames();
        });
        const stateSubscription = webviewPanel.onDidChangeViewState(() => {
          visible = webviewPanel.visible;
          generation += 1;
          if (!visible) pending = null;
          webview.postMessage({ type: 'visibility', visible });
          if (visible) pumpFrames();
        });
        let disposeSubscription;
        disposeSubscription = webviewPanel.onDidDispose(() => {
          disposed = true;
          visible = false;
          generation += 1;
          pending = null;
          messageSubscription.dispose();
          stateSubscription.dispose();
          disposeSubscription.dispose();
        });
        webview.postMessage({ type: 'visibility', visible });
      } catch (error) {
        webview.html = previewHtml(webview, { kind: 'text', text: error.message || String(error) });
      }
    },
  }, { webviewOptions: { retainContextWhenHidden: true } }));

  const commands = [
    registerCommand('fantasyPkg.open', async () => {
      const picks = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { 'PKG archives': ['pkg'] }, openLabel: 'Open PKG in Explorer' });
      if (!picks?.length) return;
      await mountArchive(picks[0].fsPath);
    }),
    registerCommand('fantasyPkg.exportRaw', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.File) throw new Error('Select a file.');
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(mount.path), path.basename(node.entry.name))), saveLabel: 'Export Raw Resource' });
      if (!target) return;
      await assertNotMountedArchive(target);
      const bytes = Buffer.from(await mount.worker.call('read', { id: node.entry.id }));
      if (target.scheme !== 'file') throw new Error('请将导出文件保存到本地文件夹。');
      const output = await fs.open(target.fsPath, 'wx', 0o600);
      try { await output.writeFile(bytes); }
      catch (error) { await output.close().catch(() => {}); await fs.unlink(target.fsPath).catch(() => {}); throw error; }
      await output.close();
      vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}.`);
    }),
    registerCommand('fantasyPkg.replaceRaw', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.File) throw new Error('Select a file.');
      const picks = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: 'Use as Raw Replacement' });
      if (!picks?.length) return;
      const snapshot = await mount.worker.call('replace', { id: node.entry.id, path: picks[0].fsPath });
      mount.staged = new Set(snapshot.staged || []);
      refreshMount(mount);
      vscode.window.showInformationMessage(`Replacement staged for ${node.entry.name}.`);
    }),
    registerCommand('fantasyPkg.exportFolder', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.Directory) throw new Error('Select a folder.');
      const picks = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Export Package Folder Here' });
      if (!picks?.length) return;
      const result = await progressTask('Exporting PKG folder', mount, 'exportFolder', { folder: node.relativePath, directory: picks[0].fsPath });
      vscode.window.showInformationMessage(`Exported ${result.count} resource(s).`);
    }),
    registerCommand('fantasyPkg.importFolder', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.Directory) throw new Error('Select a folder.');
      const picks = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Import Matching Replacements' });
      if (!picks?.length) return;
      const result = await progressTask('Comparing folder replacements', mount, 'replaceFolder', { folder: node.relativePath, path: picks[0].fsPath });
      mount.staged = new Set(result.staged || []);
      refreshMount(mount);
      vscode.window.showInformationMessage(`Compared ${result.matched}: staged ${result.changed} changed, kept ${result.unchanged} unchanged.`);
    }),
    registerCommand('fantasyPkg.exportPng', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.File || path.extname(node.entry.name).toLowerCase() !== '.gsa') throw new Error('Editable PNG export supports GSA files.');
      const picks = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Export Editable PNG Here' });
      if (!picks?.length) return;
      const result = await mount.worker.call('exportPng', { id: node.entry.id });
      const created = [];
      try {
        for (const file of result.files) {
          const outputPath = path.join(picks[0].fsPath, `${path.basename(node.entry.name)}${file.suffix}`);
          await assertNotMountedArchive(vscode.Uri.file(outputPath));
          const handle = await fs.open(outputPath, 'wx', 0o600);
          try { await handle.writeFile(Buffer.from(file.data)); }
          catch (error) { await handle.close().catch(() => {}); await fs.unlink(outputPath).catch(() => {}); throw error; }
          await handle.close();
          created.push(outputPath);
        }
      } catch (error) {
        await Promise.all(created.map(outputPath => fs.unlink(outputPath).catch(() => {})));
        throw error;
      }
      vscode.window.showInformationMessage(`Exported editable PNG and metadata for ${node.entry.name}.`);
    }),
    registerCommand('fantasyPkg.importPng', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.File || path.extname(node.entry.name).toLowerCase() !== '.gsa') throw new Error('Editable PNG import supports GSA files.');
      const picks = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { PNG: ['png'] }, openLabel: 'Convert PNG into GSA Replacement' });
      if (!picks?.length) return;
      const snapshot = await mount.worker.call('importPng', { id: node.entry.id, path: picks[0].fsPath });
      mount.staged = new Set(snapshot.staged || []);
      refreshMount(mount);
      vscode.window.showInformationMessage(`PNG converted and staged for ${node.entry.name}.`);
    }),
    registerCommand('fantasyPkg.clearEntry', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.File) throw new Error('Select a file.');
      const snapshot = await mount.worker.call('clear', { id: node.entry.id });
      mount.staged = new Set(snapshot.staged || []);
      refreshMount(mount);
    }),
    registerCommand('fantasyPkg.clearFolder', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.Directory) throw new Error('Select a folder.');
      const snapshot = await mount.worker.call('clearFolder', { folder: node.relativePath });
      mount.staged = new Set(snapshot.staged || []);
      refreshMount(mount);
    }),
    registerCommand('fantasyPkg.clearAll', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.Directory || node.relativePath) throw new Error('Select a package root.');
      const snapshot = await mount.worker.call('clearFolder', { folder: '' });
      mount.staged = new Set(snapshot.staged || []);
      refreshMount(mount);
      vscode.window.showInformationMessage('All staged replacements were cleared.');
    }),
    registerCommand('fantasyPkg.repack', async args => {
      const { mount, node } = selectedNode(args);
      if (node.type !== vscode.FileType.Directory || node.relativePath) throw new Error('Select a package root.');
      const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(mount.path), `${path.basename(mount.path, path.extname(mount.path))}-repacked.pkg`)), filters: { 'PKG archives': ['pkg'] }, saveLabel: 'Save Repacked PKG' });
      if (!target) return;
      await assertNotMountedArchive(target);
      const result = await progressTask('Repacking PKG archive', mount, 'repack', { path: target.fsPath });
      vscode.window.showInformationMessage(`Saved ${result.pathName || path.basename(target.fsPath)} with ${result.replaced} replacement(s).`);
    }),
  ];
  context.subscriptions.push(...commands);
  await restoreMounts();
  if (Array.from(mounts.values()).some(mount => mount.skipped)) {
    const skipped = Array.from(mounts.values()).reduce((total, mount) => total + mount.skipped, 0);
    vscode.window.showWarningMessage(`${skipped} unsafe or conflicting PKG path(s) were omitted from the Explorer.`);
  }
  context.subscriptions.push(new vscode.Disposable(() => {
    for (const mount of mounts.values()) mount.worker.dispose().catch(() => {});
    mounts.clear();
    if (externalPreviewWorker) externalPreviewWorker.dispose().catch(() => {});
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
