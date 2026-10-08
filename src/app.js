'use strict';

(() => {
  const api = window.pkgStudio;
  const $ = (id) => document.getElementById(id);
  const state = {
    opened: false, projectMode: false, archiveName: '', projectName: '', projectPath: '', entryCount: 0, query: '', entries: [], entryById: new Map(),
    treeRoot: null, visibleNodes: [], matchingEntries: [], expandedFolders: new Set(), searchCollapsed: new Set(),
    focusedKey: '', contextTarget: null, current: null, staged: new Map(), tabs: [], activeTabId: null,
    previewRequest: 0, taskBusy: false, toastTimer: null, previewData: null, mapScene: null, effectScene: null,
    previewVisible: !document.hidden, previewMode: '', animation: null, animationSequence: 0, frameInFlight: null, mapPage: null,
    textRequest: 0, textDrafts: new Map(), focusRefreshTimer: null, quickItems: [], quickIndex: 0, quickMode: 'open',
    sidebarWidth: 248, sidebarVisible: true, resizeActive: false,
  };

  const ROW_HEIGHT = 32;
  const TREE_OVERSCAN = 8;

  const elements = {
    archiveName: $('archiveName'), explorerProject: $('explorerProject'),
    welcomeState: $('welcomeState'), welcomeOpenButton: $('welcomeOpenButton'), welcomeProjectButton: $('welcomeProjectButton'),
    entryList: $('entryList'), treeContent: $('treeContent'), sidebar: $('sidebar'), sidebarResizer: $('sidebarResizer'),
    tabBar: $('tabBar'), editorHeading: $('editorHeading'), currentName: $('currentName'), fileKind: $('fileKind'), headingDirty: $('headingDirty'),
    editorContent: $('editorContent'), editorWrap: $('editorWrap'), lineGutter: $('lineGutter'), editorNotice: $('editorNotice'),
    textEditor: $('textEditor'), conflictNotice: $('conflictNotice'), reloadDiskButton: $('reloadDiskButton'),
    previewArea: $('previewArea'), previewStage: $('previewStage'), previewControls: $('previewControls'), tableViewTabs: $('tableViewTabs'),
    formatInfo: $('formatInfo'), metadataGrid: $('metadataGrid'), infoDialog: $('infoDialog'), infoTitle: $('infoTitle'), infoFormat: $('infoFormat'), closeInfoButton: $('closeInfoButton'),
    statusLed: $('statusLed'), statusText: $('statusText'), progressTrack: $('progressTrack'), progressFill: $('progressFill'),
    stagedSummary: $('stagedSummary'), cursorState: $('cursorState'), encodingInfo: $('encodingInfo'), toast: $('toast'), contextMenu: $('contextMenu'),
    quickOpen: $('quickOpen'), quickOpenInput: $('quickOpenInput'), quickOpenResults: $('quickOpenResults'),
  };

  const formatBytes = (value) => {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  };

  function notify(message, isError = false) {
    elements.toast.textContent = message;
    elements.toast.classList.remove('hidden');
    elements.toast.classList.toggle('toast-error', isError);
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => elements.toast.classList.add('hidden'), 3400);
  }

  function setStatus(message, kind = 'ready') {
    elements.statusText.textContent = message;
    elements.statusLed.classList.toggle('busy', kind === 'busy');
    elements.statusLed.classList.toggle('error', kind === 'error');
  }

  function isProjectConflict(error) {
    const message = typeof error === 'string' ? error : String(error?.message || error);
    return error?.code === 'PROJECT_CONFLICT' || message.includes('PROJECT_CONFLICT:');
  }

  function setBusy(value, label = '处理中…') {
    state.taskBusy = value;
    elements.textEditor.readOnly = value;
    if (value) {
      stopAnimation();
      destroyEffectScene();
    }
    if (value) {
      setStatus(label, 'busy');
      elements.progressTrack.classList.remove('hidden');
      elements.progressFill.style.width = '8%';
      elements.progressFill.classList.add('indeterminate');
    } else {
      elements.progressTrack.classList.add('hidden');
      elements.progressFill.style.width = '0';
      elements.progressFill.classList.remove('indeterminate');
      setStatus('就绪');
      schedulePreviewResume(false);
    }
    updateControls();
  }

  async function runTask(label, fn) {
    if (state.taskBusy) return null;
    setBusy(true, label);
    let failure = '';
    try {
      const result = await fn();
      return result;
    } catch (error) {
      const message = error?.message || String(error);
      failure = message;
      const displayMessage = isProjectConflict(error)
        ? '工程文件已外部修改，请复制草稿或重新载入磁盘内容'
        : message;
      notify(displayMessage, true);
      failure = displayMessage;
      return null;
    } finally {
      setBusy(false);
      renderStagedSummary();
      syncDirty();
      if (failure) setStatus(failure, 'error');
    }
  }

  function updateControls() {
    syncPreviewControls();
  }

  function renderStagedSummary() {
    const count = state.staged.size;
    elements.stagedSummary.textContent = count ? `${count} 项与源 PKG 不同` : '';
    renderTree();
    updateControls();
  }

  function applyStaged(snapshot) {
    const items = Array.isArray(snapshot) ? snapshot : snapshot?.staged;
    if (!Array.isArray(items)) return false;
    state.staged = new Map(items.map((item) => [String(item.id), item]));
    renderStagedSummary();
    syncDirty();
    return snapshot?.ok !== false && !snapshot?.snapshotError;
  }

  function currentDraft() {
    return state.current ? state.textDrafts.get(String(state.current.id)) : null;
  }

  function currentDraftDirty() {
    const draft = currentDraft();
    return !!draft?.available && draft.text !== draft.stagedText;
  }

  function syncDirty() {
    const draftsDirty = [...state.textDrafts.values()].some((draft) => draft.available && draft.text !== draft.stagedText);
    api.setDirty?.(draftsDirty);
    elements.conflictNotice.classList.toggle('hidden', !currentDraft()?.conflict);
    elements.reloadDiskButton.disabled = !currentDraft()?.conflict || state.taskBusy;
    const tab = state.current && getTab(state.current.id);
    if (tab && currentDraftDirty()) tab.pinned = true;
    elements.headingDirty.classList.toggle('hidden', !currentDraftDirty());
    renderTabs();
    if (!state.taskBusy && currentDraft()?.conflict) setStatus('工程文件已外部修改 · 草稿仍保留');
    else if (!state.taskBusy && currentDraftDirty()) setStatus('未保存');
    else if (!state.taskBusy && state.opened) setStatus('就绪');
  }

  function buildTree(entries) {
    const root = { type: 'folder', name: '', path: '', key: 'folder:', parent: null, children: new Map(), hasMatches: true };
    const entryById = new Map();
    for (const entry of entries) {
      const id = String(entry.id);
      entryById.set(id, entry);
      const parts = String(entry.name || `未命名-${id}`).replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean);
      const fileName = parts.pop() || `未命名-${id}`;
      let parent = root;
      let directory = '';
      for (const part of parts) {
        directory = directory ? `${directory}/${part}` : part;
        const childKey = `folder:${directory}`;
        let folder = parent.children.get(childKey);
        if (!folder) {
          folder = { type: 'folder', name: part, path: directory, key: childKey, parent, children: new Map(), hasMatches: true };
          parent.children.set(childKey, folder);
        }
        parent = folder;
      }
      const filePath = parts.length ? `${parts.join('/')}/${fileName}` : fileName;
      const file = {
        type: 'file', name: fileName, path: filePath, key: `file:${id}`, id: entry.id,
        entry, parent, searchText: String(entry.name || filePath).toLocaleLowerCase(), hasMatches: true,
      };
      parent.children.set(file.key, file);
    }
    root.sortedChildren = sortedChildren(root);
    const expanded = new Set();
    for (const child of root.sortedChildren) if (child.type === 'folder') expanded.add(child.path);
    state.entryById = entryById;
    state.treeRoot = root;
    state.expandedFolders = expanded;
    state.searchCollapsed.clear();
  }

  function sortedChildren(folder) {
    return [...folder.children.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
  }

  function updateMatches() {
    const query = state.query.toLocaleLowerCase();
    state.matchingEntries = [];
    function visit(folder) {
      let found = false;
      for (const child of sortedChildren(folder)) {
        if (child.type === 'folder') {
          child.sortedChildren = child.sortedChildren || sortedChildren(child);
          child.hasMatches = visit(child);
          found = found || child.hasMatches;
        } else {
          child.hasMatches = !query || child.searchText.includes(query);
          if (child.hasMatches) state.matchingEntries.push(child.entry);
          found = found || child.hasMatches;
        }
      }
      folder.hasMatches = found;
      return found;
    }
    if (state.treeRoot) visit(state.treeRoot);
  }

  function isExpanded(folder) {
    return state.query ? !state.searchCollapsed.has(folder.path) : state.expandedFolders.has(folder.path);
  }

  function flattenTree() {
    const result = [];
    if (!state.treeRoot) return result;
    function visit(folder, depth) {
      for (const child of folder.sortedChildren || sortedChildren(folder)) {
        if (state.query && !child.hasMatches) continue;
        result.push({ node: child, depth });
        if (child.type === 'folder' && isExpanded(child)) visit(child, depth + 1);
      }
    }
    visit(state.treeRoot, 0);
    return result;
  }

  function updateTreeCounts() {
    return state.visibleNodes.length;
  }

  function renderTree(recomputeMatches = true, rebuildVisible = true) {
    const previousScrollTop = elements.entryList.scrollTop;
    if (recomputeMatches) updateMatches();
    if (rebuildVisible) state.visibleNodes = flattenTree();
    updateTreeCounts();
    elements.treeContent.replaceChildren();
    if (!state.visibleNodes.length) {
      elements.treeContent.style.height = '100%';
      const empty = document.createElement('div');
      empty.className = 'tree-empty';
      empty.textContent = '此工程没有资源条目';
      elements.treeContent.append(empty);
      updateControls();
      return;
    }

    const height = elements.entryList.clientHeight || ROW_HEIGHT * 14;
    const firstVisible = Math.floor(previousScrollTop / ROW_HEIGHT);
    const start = Math.max(0, firstVisible - TREE_OVERSCAN);
    const end = Math.min(state.visibleNodes.length, Math.ceil((elements.entryList.scrollTop + height) / ROW_HEIGHT) + TREE_OVERSCAN);
    const fragment = document.createDocumentFragment();
    if (start > 0) {
      const topSpacer = document.createElement('div');
      topSpacer.className = 'tree-spacer';
      topSpacer.style.height = `${start * ROW_HEIGHT}px`;
      fragment.append(topSpacer);
    }
    for (let index = start; index < end; index += 1) {
      const { node, depth } = state.visibleNodes[index];
      const row = document.createElement('div');
      const isCurrent = node.type === 'file' && state.current && String(state.current.id) === String(node.id);
      row.className = `entry-row${node.type === 'folder' ? ' folder-row' : ''}${isCurrent ? ' active' : ''}`;
      row.dataset.visibleIndex = String(index);
      row.dataset.treeKey = node.key;
      row.style.paddingLeft = `${9 + depth * 15}px`;
      row.tabIndex = state.focusedKey === node.key ? 0 : -1;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-level', String(depth + 1));
      row.setAttribute('aria-selected', isCurrent ? 'true' : 'false');
      if (node.type === 'folder') row.setAttribute('aria-expanded', String(isExpanded(node)));
      if (node.type === 'folder') {
        const caret = document.createElement('span');
        caret.className = 'folder-caret';
        caret.textContent = isExpanded(node) ? '⌄' : '›';
        const glyph = createFileIcon('', 'file-glyph', isExpanded(node));
        const name = document.createElement('span');
        name.className = 'entry-name';
        name.textContent = node.name;
        name.title = node.path;
        row.append(caret, glyph, name);
      } else {
        const glyph = createFileIcon(node.name, 'file-glyph');
        const name = document.createElement('span');
        name.className = 'entry-name';
        name.textContent = node.name;
        name.title = node.path;
        row.append(glyph, name);
        if (state.staged.has(String(node.id))) {
          const dot = document.createElement('i');
          dot.className = 'entry-staged';
          dot.title = '工程文件与原 PKG 不同';
          row.append(dot);
        }
      }
      row.addEventListener('click', () => {
        if (state.taskBusy) return;
        state.focusedKey = node.key;
        if (node.type === 'folder') toggleFolder(node);
        else openEntry(node.entry, false);
        elements.treeContent.querySelector(`[data-visible-index="${index}"]`)?.focus({ preventScroll: true });
      });
      row.addEventListener('dblclick', (event) => {
        if (node.type !== 'file' || state.taskBusy) return;
        event.preventDefault();
        openEntry(node.entry, true);
      });
      row.addEventListener('contextmenu', (event) => showContextMenu(event, node));
      fragment.append(row);
    }
    const remaining = state.visibleNodes.length - end;
    if (remaining > 0) {
      const bottomSpacer = document.createElement('div');
      bottomSpacer.className = 'tree-spacer';
      bottomSpacer.style.height = `${remaining * ROW_HEIGHT}px`;
      fragment.append(bottomSpacer);
    }
    elements.treeContent.style.height = `${state.visibleNodes.length * ROW_HEIGHT}px`;
    elements.treeContent.append(fragment);
    const maxScroll = Math.max(0, state.visibleNodes.length * ROW_HEIGHT - elements.entryList.clientHeight);
    elements.entryList.scrollTop = Math.min(previousScrollTop, maxScroll);
    updateControls();
  }

  function toggleFolder(folder) {
    const restoreFocus = document.activeElement?.dataset?.treeKey === folder.key;
    if (state.query) {
      if (state.searchCollapsed.has(folder.path)) state.searchCollapsed.delete(folder.path);
      else state.searchCollapsed.add(folder.path);
    } else if (state.expandedFolders.has(folder.path)) state.expandedFolders.delete(folder.path);
    else state.expandedFolders.add(folder.path);
    renderTree(false, true);
    if (restoreFocus) {
      const index = state.visibleNodes.findIndex((entry) => entry.node.key === folder.key);
      if (index >= 0) focusVisibleIndex(index);
    }
  }

  function focusVisibleIndex(index) {
    if (index < 0 || index >= state.visibleNodes.length) return;
    const rowTop = index * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < elements.entryList.scrollTop) elements.entryList.scrollTop = rowTop;
    else if (rowBottom > elements.entryList.scrollTop + elements.entryList.clientHeight) {
      elements.entryList.scrollTop = rowBottom - elements.entryList.clientHeight;
    }
    state.focusedKey = state.visibleNodes[index].node.key;
    renderTree(false, false);
    elements.treeContent.querySelector(`[data-visible-index="${index}"]`)?.focus({ preventScroll: true });
  }

  function collectFolderIds(folder) {
    const ids = [];
    function visit(node) {
      for (const child of node.children.values()) {
        if (child.type === 'folder') visit(child);
        else ids.push(child.id);
      }
    }
    visit(folder);
    return ids;
  }

  function showContextMenu(event, node) {
    event.preventDefault();
    event.stopPropagation();
    state.contextTarget = node;
    const isFolder = node.type === 'folder';
    for (const button of elements.contextMenu.querySelectorAll('button')) {
      const action = button.dataset.action;
      if (action === 'effect-source' || action === 'effect-preview' || action === 'effect-structure') {
        const name = String(node.name || '');
        const supportsRecordView = /\.(eff|link|npc|lst|prc)$/i.test(name);
        const supportsSource = !/\.prc$/i.test(name) && /\.(eff|link|npc|lst)$/i.test(name);
        button.classList.toggle('hidden', isFolder || (action === 'effect-preview' ? !supportsRecordView :
          action === 'effect-structure' ? !/\.eff$/i.test(name) : !supportsSource));
        button.disabled = state.taskBusy;
        continue;
      }
      const folderOnly = ['export-folder', 'replace-folder'].includes(action);
      const fileOnly = ['model-replace', 'open', 'info', 'export-file', 'replace-file', 'export-editable', 'import-editable', 'reset-entry'].includes(action);
      button.classList.toggle('hidden', (folderOnly && !isFolder) || (fileOnly && isFolder));
      button.disabled = state.taskBusy || (action === 'model-replace' && !/\.(gsn|gso)$/i.test(String(node.name))) || (!isFolder && action === 'reset-entry' && !state.staged.has(String(node.id))) ||
        (!isFolder && ['export-editable', 'import-editable'].includes(action) && !String(node.name).toLowerCase().endsWith('.gsa'));
    }
    for (const separator of elements.contextMenu.querySelectorAll('.menu-separator')) separator.classList.remove('hidden');
    elements.contextMenu.classList.remove('hidden');
    const bounds = elements.contextMenu.getBoundingClientRect();
    elements.contextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - bounds.width - 8))}px`;
    elements.contextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - bounds.height - 8))}px`;
  }

  function hideContextMenu() {
    elements.contextMenu.classList.add('hidden');
    state.contextTarget = null;
  }

  async function runContextAction(action) {
    const node = state.contextTarget;
    hideContextMenu();
    if (!node || state.taskBusy) return;
    if ((action === 'effect-source' || action === 'effect-preview' || action === 'effect-structure') && node.type === 'file' &&
        /\.(eff|link|npc|lst|prc)$/i.test(String(node.name))) {
      const draft = state.textDrafts.get(String(node.id));
      const isSource = action === 'effect-source' && !/\.prc$/i.test(String(node.name));
      if (!isSource && draft?.available && draft.text !== draft.stagedText) {
        notify('请先保存文本草稿，再切换到资源预览');
        return;
      }
      openEntry(node.entry, true);
      const tab = getTab(node.id);
      tab.effectSource = isSource && /\.eff$/i.test(String(node.name));
      tab.recordSource = isSource && !/\.eff$/i.test(String(node.name));
      tab.effectView = action === 'effect-structure' ? 'structure' : 'scene';
      if (isSource) state.previewRequest += 1;
      renderTextEntry(node.entry);
      return;
    }
    if (action === 'model-replace' && node.type === 'file') {
      await runTask('正在打开 3D 素材转换…', () => api.openModelStudio(node.id));
      return;
    }
    if (action === 'open' && node.type === 'file') {
      openEntry(node.entry, true);
      return;
    }
    if (action === 'info' && node.type === 'file') {
      if (String(state.current?.id) !== String(node.id)) openEntry(node.entry, true);
      showResourceInfo(node.entry);
      return;
    }
    if (action === 'export-file' && node.type === 'file') {
      const result = await runTask('正在导出文件…', () => api.exportSelected([node.id]));
      if (result && !result.canceled) notify(`已导出 ${result.count} 项到「${result.directoryName}」`);
    } else if (action === 'replace-file' && node.type === 'file') {
      state.focusedKey = node.key;
      selectEntry(node.entry);
      if (!confirmReplacementOverwrite(node.id)) return;
      const result = await runTask('正在写入工程文件…', () => api.replaceFile(node.id));
      if (result && !result.canceled) {
        if (!applyStaged(result)) {
          notify(`工程文件操作未完整完成：${result.error || result.snapshotError || '无法确认工程差异'}`, true);
          return;
        }
        discardTextDraft(node.id);
        notify('工程文件已更新');
      }
    } else if (action === 'export-folder' && node.type === 'folder') {
      const ids = collectFolderIds(node);
      if (!ids.length) return notify('此目录没有文件可导出', true);
      const result = await runTask('正在导出此目录…', () => api.exportSelected(ids));
      if (result && !result.canceled) notify(`已导出目录中的 ${result.count} 项到「${result.directoryName}」`);
    } else if (action === 'replace-folder' && node.type === 'folder') {
      if (!confirmDraftsMayBeReplaced()) return;
      const result = await runTask(`正在比较「${node.path}」的替换目录…`, () => api.replaceDirectory(node.path));
      applyDirectoryResult(result, node.path);
    } else if (action === 'export-editable' && node.type === 'file') {
      const result = await runTask('正在导出 PNG 编辑预览…', () => api.exportEditable(node.id));
      if (result && !result.canceled) notify(`已导出 ${result.files.join('、')}`);
    } else if (action === 'import-editable' && node.type === 'file') {
      if (!confirmReplacementOverwrite(node.id)) return;
      const result = await runTask('正在转换导入 PNG…', () => api.importEditable(node.id));
      if (result && !result.canceled) {
        if (!applyStaged(result)) return notify(`工程文件导入未完整完成：${result.error || result.snapshotError || '无法确认工程差异'}`, true);
        discardTextDraft(node.id);
        notify('PNG 已转换并写入工程文件');
      }
    } else if (action === 'reset-entry' && node.type === 'file') {
      if (String(state.current?.id) !== String(node.id)) openEntry(node.entry, true);
      await clearSelected(node.id);
    }
  }

  function confirmReplacementOverwrite(id) {
    const key = String(id);
    const draft = state.textDrafts.get(key);
    if (!draft || !draft.available || draft.text === draft.stagedText) return true;
    return window.confirm('此条目有未保存的文本草稿。继续操作会丢弃该草稿，是否继续？');
  }

  function confirmDraftsMayBeReplaced() {
    const hasDrafts = [...state.textDrafts.values()].some((draft) => draft.available && draft.text !== draft.stagedText);
    return !hasDrafts || window.confirm('导入目录可能覆盖未保存的文本草稿。继续后受影响草稿会被丢弃，是否继续？');
  }

  function discardTextDraft(id) {
    const key = String(id);
    if (state.current && String(state.current.id) === key) {
      state.textRequest += 1;
      invalidatePreviewCache(key);
    }
    state.textDrafts.delete(key);
    if (state.current && String(state.current.id) === key) {
      const entry = state.entryById.get(key);
      elements.textEditor.value = '';
      elements.textEditor.disabled = true;
      if (entry) renderTextEntry(entry);
    }
    syncDirty();
  }

  function discardDraftsReplacedBy(result) {
    const affected = Array.isArray(result?.affectedIds) ? result.affectedIds.map(String) : null;
    for (const [id, draft] of [...state.textDrafts]) {
      if (affected ? affected.includes(id) : (!draft.available || draft.text === draft.stagedText)) {
        discardTextDraft(id);
      }
    }
  }

  function applyDirectoryResult(result, label = '目录') {
    if (!result || result.canceled) return;
    if (Array.isArray(result.staged)) applyStaged(result.staged);
    discardDraftsReplacedBy(result);
    if (result.ok === false || result.snapshotError) {
      const failed = result.failedPath || result.failedId || '未知文件';
      notify(`已完成 ${Number(result.completed) || 0} 项，处理「${failed}」失败：${result.error || result.snapshotError || '未知错误'}`, true);
      return;
    }
    notify(`「${label}」匹配 ${result.matched ?? result.completed ?? 0} 项，更新 ${result.changed ?? result.completed ?? 0} 项`);
  }

  function getTab(id) {
    return state.tabs.find((tab) => String(tab.id) === String(id)) || null;
  }

  function captureCurrentView() {
    const tab = state.current && getTab(state.current.id);
    if (!tab) return;
    if (!elements.textEditor.disabled && currentDraft()?.available) {
      tab.scrollTop = elements.textEditor.scrollTop;
      tab.selectionStart = elements.textEditor.selectionStart;
      tab.selectionEnd = elements.textEditor.selectionEnd;
    }
  }

  function renderTabs() {
    elements.tabBar.replaceChildren();
    for (const tab of state.tabs) {
      const element = document.createElement('div');
      element.className = `editor-tab${String(tab.id) === String(state.activeTabId) ? ' active' : ''}${tab.pinned ? '' : ' preview'}`;
      element.setAttribute('role', 'tab');
      element.setAttribute('aria-selected', String(String(tab.id) === String(state.activeTabId)));
      element.title = tab.entry.name;
      element.addEventListener('click', (event) => {
        if (event.target.closest('.tab-close')) return;
        activateTab(tab.id);
      });
      element.addEventListener('dblclick', () => {
        tab.pinned = true;
        renderTabs();
      });
      element.addEventListener('mousedown', (event) => {
        if (event.button === 1) {
          event.preventDefault();
          closeTab(tab.id);
        }
      });
      const icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.append(createFileIcon(tab.entry.name));
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tab.entry.name.split(/[\\/]/).pop();
      element.append(icon, name);
      const draft = state.textDrafts.get(String(tab.id));
      if (draft?.available && draft.text !== draft.stagedText) {
        const dirty = document.createElement('span');
        dirty.className = 'tab-dirty';
        dirty.textContent = '●';
        dirty.setAttribute('aria-label', '未保存');
        element.append(dirty);
      }
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `关闭 ${tab.entry.name}`);
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        closeTab(tab.id);
      });
      element.append(close);
      elements.tabBar.append(element);
    }
  }

  function fileType(name) {
    const extension = String(name || '').toLowerCase().split('.').pop();
    if (['link', 'npc', 'lst', 'def', 'ini', 'txt', 'js', 'cjs', 'json', 'xml', 'lua', 'cfg', 'csv', 'md', 'eff', 'eff_'].includes(extension)) return 'text';
    if (['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tga'].includes(extension)) return 'image';
    if (['gsn', 'gso', 'gsa'].includes(extension)) return 'animation';
    if (['gsm', 'msk', 'smp', 'prc', 'mask', 'til', 'glg', 'krd'].includes(extension)) return 'map';
    if (extension === 'rar') return 'archive';
    if (['wav', 'mp3', 'ogg', 'flac', 'mid', 'midi'].includes(extension)) return 'audio';
    if (['bin', 'dat'].includes(extension)) return 'data';
    return 'unknown';
  }

  function createFileIcon(name, className = '', folderOpen = false) {
    const isFolder = !name;
    const type = isFolder ? 'folder' : fileType(name);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('file-icon', `file-icon-${type}`);
    if (className) svg.classList.add(className);
    const paths = {
      folder: folderOpen
        ? ['M1.25 5.1h13.5l-1.2 7.65H2.1L1.25 5.1Z', 'M1.35 5.1V3.25h4.7l1.4 1.55h4.05']
        : ['M1.3 3.25h4.75l1.4 1.55h7.2v7.95H1.3V3.25Z'],
      text: ['M3 1.75h6.5l3.5 3.5v9H3v-12.5Z', 'M9.5 1.9v3.5H13', 'M5 8h6', 'M5 10.5h6', 'M5 13h4'],
      image: ['M2 2.25h12v11.5H2z', 'm3.5 11 3-3 2.1 2 2-2.5 2.4 3.5', 'M5 5.5h.01'],
      animation: ['M2.25 3h11.5v10H2.25z', 'M2.25 5h1.5M2.25 7h1.5M2.25 9h1.5M2.25 11h1.5', 'M13.75 5h-1.5M13.75 7h-1.5M13.75 9h-1.5M13.75 11h-1.5', 'm6.5 5.5 4 2.5-4 2.5z'],
      map: ['M1.5 3.1 5.7 1.8l4.6 1.3 4.2-1.3v11.1l-4.2 1.3-4.6-1.3-4.2 1.3z', 'M5.7 1.8v11.1', 'M10.3 3.1v11.1'],
      audio: ['M9.4 2.2v8.2a2.1 2.1 0 1 1-1.2-1.9V4.1l5-1.2v6.2a2.1 2.1 0 1 1-1.2-1.9V1.9z'],
      data: ['M3 2.25h10v11.5H3z', 'M5.2 5h5.6', 'M5.2 7.6h5.6', 'M5.2 10.2h2.8', 'M1.5 5h1.3M1.5 8h1.3M1.5 11h1.3M13.2 5h1.3M13.2 8h1.3M13.2 11h1.3'],
      archive: ['M3 1.75h10v12.5H3z', 'M7 2v2h2v2H7v2h2', 'M7 10h2v2H7z'],
      unknown: ['M3 1.75h6.5l3.5 3.5v9H3v-12.5Z', 'M9.5 1.9v3.5H13', 'M6.1 7a1.9 1.9 0 1 1 2.5 1.8c-.7.3-.9.7-.9 1.3', 'M7.7 12.2h.01'],
    }[type];
    for (const d of paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function openEntry(entry, pinned = false, force = false) {
    if (!entry || (state.taskBusy && !force)) return;
    captureCurrentView();
    let tab = getTab(entry.id);
    if (!tab) {
      if (!pinned) {
        const preview = state.tabs.find((candidate) => !candidate.pinned);
        if (preview) {
          state.tabs.splice(state.tabs.indexOf(preview), 1);
          const draft = state.textDrafts.get(String(preview.id));
          if (!draft?.available || draft.text === draft.stagedText) state.textDrafts.delete(String(preview.id));
        }
      }
      tab = { id: String(entry.id), entry, pinned: !!pinned, tableView: 'data', scrollTop: 0, selectionStart: 0, selectionEnd: 0 };
      state.tabs.push(tab);
    } else {
      tab.entry = entry;
      if (pinned) tab.pinned = true;
    }
    activateTab(tab.id, force);
  }

  function activateTab(id, force = false) {
    if (state.taskBusy && !force) return;
    captureCurrentView();
    const tab = getTab(id);
    if (!tab) return;
    tab.entry = state.entryById.get(String(id)) || tab.entry;
    state.activeTabId = String(id);
    setCurrent(tab.entry);
    renderTabs();
  }

  async function closeTab(id) {
    if (state.taskBusy) return;
    const tab = getTab(id);
    if (!tab) return;
    const key = String(id);
    const draft = state.textDrafts.get(key);
    if (draft?.available && draft.text !== draft.stagedText) {
      const decision = await api.confirmCloseTab?.(tab.entry.name);
      if (decision === 'save') {
        const result = await runTask('正在保存文本到工程…', () => saveDraftToProject(key, draft));
        if (!result) return;
      } else if (decision !== 'discard') return;
    }
    captureCurrentView();
    const index = state.tabs.indexOf(tab);
    state.tabs.splice(index, 1);
    state.textDrafts.delete(key);
    if (state.activeTabId === key) {
      const next = state.tabs[Math.min(index, state.tabs.length - 1)] || state.tabs[index - 1];
      if (next) activateTab(next.id);
      else {
        destroyMapScene();
        destroyEffectScene();
        state.activeTabId = null;
        state.current = null;
        state.textRequest += 1;
        state.previewRequest += 1;
        stopAnimation();
        state.animation = null;
        state.mapPage = null;
        elements.editorWrap.classList.add('hidden');
        elements.previewArea.classList.add('hidden');
        elements.editorHeading.classList.add('hidden');
        elements.welcomeState.classList.remove('hidden');
        elements.previewStage.classList.remove('solid');
        elements.previewStage.classList.remove('table-preview');
        elements.previewStage.classList.remove('map-scene-preview');
        elements.previewStage.classList.remove('resource-records-preview');
        elements.previewStage.classList.remove('effect-scene-preview');
        elements.tableViewTabs.classList.add('hidden');
        elements.lineGutter.replaceChildren();
        elements.currentName.textContent = '';
        elements.fileKind.textContent = '';
        elements.headingDirty.classList.add('hidden');
        elements.formatInfo.textContent = '';
      }
    }
    renderTabs();
    syncDirty();
  }

  function setCurrent(entry) {
    destroyMapScene();
    destroyEffectScene();
    stopAnimation();
    state.animation = null;
    state.mapPage = null;
    state.previewMode = '';
    state.previewRequest += 1;
    state.current = entry;
    for (const row of elements.treeContent.querySelectorAll('.entry-row')) {
      const node = state.visibleNodes[Number(row.dataset.visibleIndex)]?.node;
      const selected = node?.type === 'file' && String(node.id) === String(entry.id);
      row.classList.toggle('active', selected);
      row.setAttribute('aria-selected', String(selected));
    }
    elements.previewStage.classList.remove('solid');
    elements.previewStage.classList.remove('table-preview');
    elements.previewStage.classList.remove('map-scene-preview');
    elements.previewStage.classList.remove('resource-records-preview');
    elements.previewStage.classList.remove('effect-scene-preview');
    elements.currentName.textContent = entry.name;
    elements.currentName.title = entry.name;
    elements.fileKind.replaceChildren(createFileIcon(entry.name));
    elements.welcomeState.classList.add('hidden');
    elements.editorHeading.classList.remove('hidden');
    elements.previewStage.replaceChildren();
    elements.previewControls.replaceChildren();
    elements.previewControls.classList.add('hidden');
    elements.tableViewTabs.classList.add('hidden');
    const placeholder = document.createElement('div');
    placeholder.className = 'preview-placeholder';
    const mark = document.createElement('span');
    mark.className = 'placeholder-mark';
    mark.textContent = '◇';
    const text = document.createElement('span');
    text.textContent = '正在读取工程文件预览…';
    placeholder.append(mark, text);
    elements.previewStage.append(placeholder);
    state.previewData = null;
    elements.formatInfo.textContent = '';
    renderTextEntry(entry);
    updateControls();
  }

  function renderTextEntry(entry) {
    const request = ++state.textRequest;
    const id = String(entry.id);
    const existing = state.textDrafts.get(id);
    const tab = getTab(entry.id);
    const name = String(entry.name || '');
    if (/\.(bin|gsm|mask|til|tga|glg|krd|rar|prc)$/i.test(name) ||
        (/\.(link|npc|lst)$/i.test(name) && !tab?.recordSource) ||
        (/\.eff$/i.test(String(entry.name || '')) && !getTab(entry.id)?.effectSource)) {
      elements.textEditor.value = '';
      elements.textEditor.disabled = true;
      elements.editorWrap.classList.add('hidden');
      elements.previewArea.classList.remove('hidden');
      elements.editorNotice.classList.add('hidden');
      elements.encodingInfo.textContent = '';
      loadProjectPreview(entry);
      return;
    }
    elements.textEditor.value = existing?.available ? existing.text : '';
    elements.textEditor.disabled = !existing?.available;
    elements.editorWrap.classList.toggle('hidden', existing?.available === false);
    elements.previewArea.classList.toggle('hidden', existing?.available !== false);
    elements.editorNotice.classList.toggle('hidden', !!existing?.available);
    elements.editorNotice.textContent = existing?.error || '正在读取完整 UTF-8 文本…';
    elements.encodingInfo.textContent = existing?.encoding
      ? `${existing.encoding} · ${({ LF: 'LF', CRLF: 'CRLF', CR: 'CR', none: '无换行' }[existing.newline] || '原始换行')}${existing.bom ? ' · BOM' : ''}`
      : '读取中…';
    elements.formatInfo.textContent = existing?.available === false ? '只读预览' : '文本';
    elements.cursorState.textContent = '行 1，列 1';
    syncDirty();
    if (existing) {
      if (!existing.available) {
        elements.encodingInfo.textContent = '';
        loadProjectPreview(entry);
      } else {
        restoreTabEditorState(getTab(id));
        renderLineNumbers();
      }
      return;
    }
    api.getText(entry.id).then((result) => {
      if (request !== state.textRequest) return;
      const text = String(result?.text ?? '').replace(/\r\n?/g, '\n');
      const draft = { available: true, entryId: result?.id ?? entry.id, text, originalText: text, stagedText: text, sha256: result?.sha256 || '', conflict: false, encoding: result?.encoding || 'UTF-8', newline: result?.newline || 'LF', bom: !!result?.bom };
      state.textDrafts.set(id, draft);
      if (request === state.textRequest && state.current && String(state.current.id) === id) {
        elements.textEditor.value = text;
        elements.textEditor.disabled = false;
        elements.editorWrap.classList.remove('hidden');
        elements.previewArea.classList.add('hidden');
        elements.editorNotice.classList.add('hidden');
        elements.encodingInfo.textContent = `${draft.encoding} · ${draft.newline}${draft.bom ? ' · BOM' : ''}`;
        elements.formatInfo.textContent = '文本';
        restoreTabEditorState(getTab(id));
        renderLineNumbers();
        syncDirty();
      }
    }).catch((error) => {
      if (request !== state.textRequest) return;
      const message = error?.message || String(error);
      state.textDrafts.set(id, { available: false, error: `无法编辑：${message}` });
      if (request === state.textRequest && state.current && String(state.current.id) === id) {
        elements.textEditor.value = '';
        elements.textEditor.disabled = true;
        elements.editorNotice.textContent = `无法编辑：${message}`;
        elements.editorNotice.classList.remove('hidden');
        elements.editorWrap.classList.add('hidden');
        elements.previewArea.classList.remove('hidden');
        elements.encodingInfo.textContent = '';
        elements.formatInfo.textContent = '只读预览';
        setStatus('只读预览 · 完整 UTF-8 文本不可用');
        syncDirty();
        loadProjectPreview(entry);
      }
    });
  }

  function updateCursorState() {
    const editor = elements.textEditor;
    const before = editor.value.slice(0, editor.selectionStart);
    const line = (before.match(/\n/g) || []).length + 1;
    const column = before.length - before.lastIndexOf('\n');
    elements.cursorState.textContent = `行 ${line}，列 ${column}`;
    captureCurrentView();
  }

  function restoreTabEditorState(tab) {
    if (!tab) return;
    elements.textEditor.scrollTop = tab.scrollTop || 0;
    const length = elements.textEditor.value.length;
    const start = Math.min(tab.selectionStart || 0, length);
    const end = Math.min(tab.selectionEnd || start, length);
    elements.textEditor.setSelectionRange(start, end);
    updateCursorState();
  }

  function renderLineNumbers() {
    const editor = elements.textEditor;
    if (editor.disabled) {
      elements.lineGutter.replaceChildren();
      return;
    }
    const lineHeight = 21;
    const total = (editor.value.match(/\n/g) || []).length + 1;
    const start = Math.max(0, Math.floor(editor.scrollTop / lineHeight) - 2);
    const visible = Math.ceil((editor.clientHeight || 400) / lineHeight) + 5;
    const end = Math.min(total, start + visible);
    const fragment = document.createDocumentFragment();
    if (start) {
      const spacer = document.createElement('div');
      spacer.style.height = `${start * lineHeight}px`;
      fragment.append(spacer);
    }
    for (let line = start + 1; line <= end; line += 1) {
      const number = document.createElement('div');
      number.className = 'line-number';
      number.textContent = String(line);
      fragment.append(number);
    }
    if (end < total) {
      const spacer = document.createElement('div');
      spacer.style.height = `${(total - end) * lineHeight}px`;
      fragment.append(spacer);
    }
    elements.lineGutter.replaceChildren(fragment);
    elements.lineGutter.scrollTop = editor.scrollTop;
  }

  async function stageTextDraft(draft = currentDraft()) {
    if (!draft || !draft.available || !state.current || draft !== currentDraft() || !currentDraftDirty()) return false;
    const id = String(state.current.id);
    const saved = await runTask('正在保存文本到工程…', () => saveDraftToProject(id, draft));
    if (!saved) return false;
    invalidatePreviewCache(id);
    syncDirty();
    notify('文本已保存到工程；需要时可单独导出 PKG');
    return true;
  }

  async function saveDraftToProject(id, draft) {
    if (!draft?.available || draft.text === draft.stagedText) return true;
    if (!draft.sha256) throw new Error('缺少工程文件校验信息，请刷新工程后重试');
    const text = draft.text;
    let result;
    try {
      result = await api.saveText(draft.entryId ?? id, text, draft.sha256);
    } catch (error) {
      if (isProjectConflict(error)) draft.conflict = true;
      throw error;
    }
    if (!result || !Array.isArray(result.staged) || typeof result.sha256 !== 'string') {
      throw new Error('工程保存返回了无效结果');
    }
    state.staged = new Map(result.staged.map((item) => [String(item.id), item]));
    draft.stagedText = text;
    draft.originalText = text;
    draft.sha256 = result.sha256;
    draft.conflict = false;
    syncDirty();
    renderStagedSummary();
    return true;
  }

  function invalidatePreviewCache(id) {
    if (!state.current || String(state.current.id) !== String(id)) return;
    destroyMapScene();
    destroyEffectScene();
    stopAnimation();
    state.animation = null;
    state.previewRequest += 1;
    state.mapPage = null;
    state.previewMode = '';
    elements.previewControls.replaceChildren();
    elements.previewControls.classList.add('hidden');
  }

  function selectEntry(entry) {
    openEntry(entry, false);
  }

  function loadProjectPreview(entry) {
    destroyMapScene();
    destroyEffectScene();
    stopAnimation();
    state.animation = null;
    state.mapPage = null;
    state.previewMode = '';
    elements.tableViewTabs.classList.add('hidden');
    elements.previewStage.classList.remove('table-preview');
    elements.previewStage.classList.remove('solid');
    elements.previewStage.classList.remove('map-scene-preview');
    elements.previewStage.classList.remove('resource-records-preview');
    elements.previewStage.classList.remove('effect-scene-preview');
    state.previewRequest += 1;
    elements.previewControls.replaceChildren();
    elements.previewControls.classList.add('hidden');
    const placeholder = document.createElement('div');
    placeholder.className = 'preview-placeholder';
    const mark = document.createElement('span');
    mark.className = 'placeholder-mark';
    mark.textContent = '◇';
    const text = document.createElement('span');
    text.textContent = '正在读取工程文件预览…';
    placeholder.append(mark, text);
    elements.previewStage.replaceChildren(placeholder);
    renderMetadata(entry, null);
    const request = ++state.previewRequest;
    const options = { page: 0 };
    const tab = getTab(entry.id);
    if (tab?.recordSource || tab?.effectSource) options.view = 'source';
    else if (tab?.effectView === 'structure') options.view = 'structure';
    api.previewEntry(entry.id, options).then((result) => {
      if (request !== state.previewRequest || !state.current || String(state.current.id) !== String(entry.id)) return;
      state.previewData = result;
      renderPreview(result);
      renderMetadata(entry, result);
    }).catch((error) => {
      if (request !== state.previewRequest || !state.current || String(state.current.id) !== String(entry.id)) return;
      const message = error?.message || String(error);
      showPreviewError(`无法预览此资源：${message}`);
      elements.formatInfo.textContent = '不可预览';
      state.previewData = null;
      renderMetadata(entry, null);
    });
  }

  function renderPreview(result) {
    if (result?.kind !== 'map-scene') destroyMapScene();
    if (result?.kind !== 'effect-scene') destroyEffectScene();
    state.previewData = result;
    elements.cursorState.textContent = '';
    elements.encodingInfo.textContent = result?.encoding || '';
    const isTable = result?.kind === 'table';
    const isResourceRecords = result?.kind === 'resource-records';
    const isMapScene = result?.kind === 'map-scene';
    const isEffectScene = result?.kind === 'effect-scene';
    if (isTable) {
      try {
        validateTablePreview(result);
      } catch (error) {
        showPreviewError(error?.message || String(error));
        return;
      }
    }
    if (isResourceRecords) {
      try {
        validateResourceRecordsPreview(result);
      } catch (error) {
        showPreviewError(error?.message || String(error));
        return;
      }
    }
    elements.tableViewTabs.classList.toggle('hidden', !isTable);
    elements.previewStage.classList.toggle('table-preview', isTable);
    elements.previewStage.classList.toggle('map-scene-preview', isMapScene);
    elements.previewStage.classList.toggle('resource-records-preview', isResourceRecords);
    elements.previewStage.classList.toggle('effect-scene-preview', isEffectScene);
    elements.previewStage.classList.toggle('solid', ['audio', 'text', 'hex', 'table'].includes(result?.kind));
    if (isEffectScene) {
      try {
        validateEffectScene(result);
      } catch (error) {
        showPreviewError(error?.message || String(error));
        return;
      }
      elements.tableViewTabs.classList.add('hidden');
      renderEffectScenePreview(result);
      elements.formatInfo.textContent = '特效合成';
      elements.previewControls.replaceChildren();
      elements.previewControls.classList.add('hidden');
      state.mapPage = null;
      state.previewMode = '';
      return;
    }
    if (result?.kind === 'animation') {
      renderAnimationPreview(result);
      return;
    }
    stopAnimation();
    state.animation = null;
    elements.previewStage.replaceChildren();
    const keepPager = state.previewMode.startsWith('page:') && result &&
      (Number(result.pageCount) > 1 || Number(result.columnPageCount) > 1);
    if (!keepPager) {
      elements.previewControls.replaceChildren();
      elements.previewControls.classList.add('hidden');
      state.mapPage = null;
    }
    if (!keepPager) state.previewMode = '';
    if (result.kind === 'image' && result.base64) {
      const image = document.createElement('img');
      image.alt = '工程文件预览';
      image.src = `data:${result.mime || 'image/png'};base64,${result.base64}`;
      elements.previewStage.append(image);
      elements.formatInfo.textContent = '图像';
    } else if (result.kind === 'audio' && result.base64) {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = `data:${result.mime || 'audio/wav'};base64,${result.base64}`;
      elements.previewStage.append(audio);
      elements.formatInfo.textContent = '音频';
    } else if (result.kind === 'text' || result.kind === 'hex') {
      const pre = document.createElement('pre');
      pre.textContent = String(result.text ?? '');
      elements.previewStage.append(pre);
      elements.formatInfo.textContent = result.kind === 'hex' ? '十六进制' : '文本';
    } else if (isTable) {
      renderTablePreview(result);
      elements.formatInfo.textContent = '数据表';
    } else if (isResourceRecords) {
      renderResourceRecordsPreview(result);
      elements.formatInfo.textContent = '资源记录';
    } else if (isMapScene) {
      createMapScene(result);
      elements.formatInfo.textContent = '地图场景';
      return;
    } else {
      const box = document.createElement('div');
      box.className = 'preview-placeholder';
      box.textContent = '此资源类型没有可用的预览';
      elements.previewStage.append(box);
      elements.formatInfo.textContent = '资源';
    }
    if (keepPager) updateMapPage(result);
    else setupMapPage(result);
    if (currentDraft()?.available === false) elements.previewArea.classList.remove('hidden');
  }

  function renderTablePreview(result) {
    const tab = state.current && getTab(state.current.id);
    const view = tab?.tableView === 'schema' ? 'schema' : 'data';
    for (const button of elements.tableViewTabs.querySelectorAll('[data-table-view]')) {
      const active = button.dataset.tableView === view;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
      if (button.dataset.tableView === 'data') {
        const decoded = ['matched', 'loader', 'partial'].includes(result.schema?.status);
        button.textContent = decoded ? '数据查看' : '原始字节（未解析）';
        button.title = decoded ? '' : String(result.schema?.message || '缺少可用字段定义');
      }
    }
    elements.previewStage.replaceChildren();
    if (view === 'schema') renderTableDefinition(result);
    else renderTableData(result);
  }

  function validateResourceRecordsPreview(result) {
    const columns = result?.columns;
    const rows = result?.rows;
    if (!Array.isArray(columns) || columns.length > 4096 ||
        columns.some((column) => !column || typeof column.key !== 'string' || column.key.length > 4096 ||
          typeof column.label !== 'string' || column.label.length > 4096)) {
      throw new Error('资源记录字段定义无效');
    }
    if (!Number.isSafeInteger(result.rowCount) || result.rowCount < 0 || result.rowCount > 67108864 ||
        !Number.isSafeInteger(result.pageCount) || result.pageCount < 1 || result.pageCount > 1342178 ||
        !Number.isSafeInteger(result.page) || result.page < 0 || result.page >= result.pageCount ||
        result.pageCount !== Math.max(1, Math.ceil(result.rowCount / 50))) {
      throw new Error('资源记录分页元数据无效');
    }
    const expectedRows = Math.min(50, Math.max(0, result.rowCount - result.page * 50));
    if (!Array.isArray(rows) || rows.length !== expectedRows ||
        rows.some((row) => !row || !(typeof row.id === 'string' || typeof row.id === 'number') ||
          !Number.isFinite(typeof row.id === 'number' ? row.id : 0) ||
          !Array.isArray(row.cells) || row.cells.length !== columns.length || row.cells.some((cell) => typeof cell !== 'string') ||
          !Array.isArray(row.links) || row.links.length > 128 ||
          row.links.some((link) => !link || typeof link.label !== 'string' || link.label.length > 4096 ||
            typeof link.path !== 'string' || link.path.length > 4096))) {
      throw new Error('资源记录行数据与字段定义不匹配');
    }
    if (result.image !== undefined) {
      const image = result.image;
      if (!image || image.mime !== 'image/png' || !Number.isSafeInteger(image.width) || image.width < 1 || image.width > 8192 ||
          !Number.isSafeInteger(image.height) || image.height < 1 || image.height > 8192 || image.width * image.height > 16777216 ||
          !sceneDataUrl(image)) throw new Error('资源记录示意图数据无效');
    }
  }

  function renderResourceRecordsPreview(result) {
    const layout = document.createElement('div');
    layout.className = `resource-records-layout${result.image ? ' has-image' : ''}`;
    const tableWrap = document.createElement('div');
    tableWrap.className = 'resource-records-table-wrap';
    if (!result.rows.length) {
      const empty = document.createElement('div');
      empty.className = 'resource-records-empty';
      empty.textContent = '没有记录';
      tableWrap.append(empty);
    } else {
      const table = document.createElement('table');
      table.className = 'resource-records-table';
      const head = document.createElement('thead');
      const headerRow = document.createElement('tr');
      for (const column of result.columns) {
        const cell = document.createElement('th');
        cell.textContent = column.label;
        cell.title = column.label;
        headerRow.append(cell);
      }
      const hasLinks = result.rows.some((row) => row.links.length > 0);
      const resourceIndex = new Map();
      for (const entry of state.entries) {
        const key = normalizeScenePath(entry.name);
        if (!resourceIndex.has(key)) resourceIndex.set(key, []);
        resourceIndex.get(key).push(entry);
      }
      if (hasLinks) {
        const linksHeader = document.createElement('th');
        linksHeader.textContent = '资源';
        headerRow.append(linksHeader);
      }
      head.append(headerRow);
      table.append(head);
      const body = document.createElement('tbody');
      for (const rowData of result.rows) {
        const row = document.createElement('tr');
        for (const value of rowData.cells) {
          const cell = document.createElement('td');
          cell.textContent = value;
          cell.title = value;
          row.append(cell);
        }
        if (hasLinks) {
          const linksCell = document.createElement('td');
          linksCell.className = 'resource-records-links';
          for (const link of rowData.links) {
            const resolution = resolveProjectResourcePath(link.path, resourceIndex);
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'resource-record-link';
            button.textContent = `${link.label}${resolution.status === 'ambiguous' ? ' · 重名' : resolution.status === 'missing' ? ' · 缺失' : ''}`;
            button.title = link.path;
            button.disabled = resolution.status !== 'found';
            if (resolution.status === 'found') {
              button.addEventListener('click', () => openEntry(resolution.entry, true));
            }
            linksCell.append(button);
          }
          row.append(linksCell);
        }
        body.append(row);
      }
      table.append(body);
      tableWrap.append(table);
    }
    layout.append(tableWrap);
    if (result.image) {
      const imagePane = document.createElement('div');
      imagePane.className = 'resource-records-image-pane';
      const image = document.createElement('img');
      image.alt = '当前页多边形示意图';
      image.draggable = false;
      image.src = sceneDataUrl(result.image);
      image.onerror = () => {
        if (state.current && state.previewData === result) imagePane.textContent = '本页示意图无法显示';
      };
      imagePane.append(image);
      layout.append(imagePane);
    }
    elements.previewStage.replaceChildren(layout);
  }

  function resolveProjectResourcePath(path, resourceIndex) {
    const normalized = normalizeScenePath(path);
    if (!normalized) return { status: 'missing', entry: null };
    const matches = resourceIndex.get(normalized) || [];
    if (matches.length > 1) return { status: 'ambiguous', entry: null };
    const entry = matches.length === 1 ? state.entryById.get(String(matches[0].id)) : null;
    return entry ? { status: 'found', entry } : { status: 'missing', entry: null };
  }

  function validateEffectScene(result) {
    const bounds = result?.canvas?.bounds;
    const validLife = Number.isFinite(result?.lifeMs) && result.lifeMs > 0 && result.lifeMs <= 86400000;
    const validBounds = bounds && ['minX', 'minY', 'width', 'height'].every((key) => Number.isFinite(bounds[key])) &&
      bounds.width > 0 && bounds.height > 0 && bounds.width <= 10000000 && bounds.height <= 10000000;
    if (result?.sampleRateHz !== 30 || (!validLife && result?.timelineComplete) ||
        (!validBounds && result?.timelineComplete) ||
        !Array.isArray(result.layers) || result.layers.length > 128 ||
        !Array.isArray(result.assets) || result.assets.length > 128 ||
        typeof result.timelineComplete !== 'boolean' || typeof result.partial !== 'boolean' ||
        (result.issues !== undefined && (!Array.isArray(result.issues) || result.issues.length > 10000))) {
      throw new Error('特效合成场景元数据无效');
    }
    const assetIds = new Set();
    for (const asset of result.assets) {
      if (!asset || !Number.isSafeInteger(asset.id) || asset.id < 0 || assetIds.has(asset.id) ||
          !Number.isFinite(asset.tier) || asset.tier <= 0 || asset.tier > 4096 ||
          !Array.isArray(asset.frames) || asset.frames.length > 4096) throw new Error('特效素材元数据无效');
      assetIds.add(asset.id);
      for (let index = 0; index < asset.frames.length; index += 1) {
        const frame = asset.frames[index];
        if (!frame || frame.frameIndex !== index || !Number.isSafeInteger(frame.sourceFrameIndex) ||
            frame.mime !== 'image/png' || !Number.isSafeInteger(frame.width) || frame.width < 1 || frame.width > 8192 ||
            !Number.isSafeInteger(frame.height) || frame.height < 1 || frame.height > 8192 || frame.width * frame.height > 16777216 ||
            !Array.isArray(frame.anchor) || frame.anchor.length !== 2 || !frame.anchor.every((value) => Number.isFinite(value) && Math.abs(value) <= 1000000) ||
            !sceneDataUrl(frame)) throw new Error('特效帧图像或锚点数据无效');
      }
    }
    if (result.timelineComplete && result.lifeMs > 60000) throw new Error('特效轨迹标记与生命周期不匹配');
    for (const layer of result.layers) {
      if (!layer || !Number.isSafeInteger(layer.sourceIndex) || layer.sourceIndex < 0 ||
          typeof layer.sprite !== 'string' || !Number.isFinite(layer.speedMs) || layer.speedMs < 0 ||
          !Array.isArray(layer.offset) || layer.offset.length !== 2 || !layer.offset.every(Number.isFinite) ||
          !['alpha', 'additive', 'max'].includes(layer.resolvedBlend) ||
          !Number.isFinite(layer.frameMs) || layer.frameMs <= 0 || layer.frameMs > 86400000 ||
          !Array.isArray(layer.poses) || layer.poses.length > 1801 ||
          (layer.assetId !== null && !assetIds.has(layer.assetId))) throw new Error('特效图层元数据无效');
      let previousTime = -Infinity;
      const asset = result.assets.find((item) => item.id === layer.assetId);
      for (const pose of layer.poses) {
        if (!pose || !Number.isFinite(pose.timeMs) || pose.timeMs < 0 || pose.timeMs > result.lifeMs ||
            pose.timeMs <= previousTime || typeof pose.visible !== 'boolean' ||
            !(pose.assetFrameIndex === null || (Number.isSafeInteger(pose.assetFrameIndex) && pose.assetFrameIndex >= 0)) ||
            !Array.isArray(pose.position) || pose.position.length !== 3 || !pose.position.every((value) => Number.isFinite(value) && Math.abs(value) <= 10000000) ||
            !Array.isArray(pose.scale) || pose.scale.length !== 2 || !pose.scale.every((value) => Number.isFinite(value) && Math.abs(value) <= 10000) ||
            !Number.isFinite(pose.rotation) || Math.abs(pose.rotation) > 10000000 || !Array.isArray(pose.color) || pose.color.length !== 3 ||
            !pose.color.every((value) => Number.isFinite(value) && Math.abs(value) <= 10000) ||
            !Number.isFinite(pose.alpha) || Math.abs(pose.alpha) > 1000 ||
            (asset && pose.assetFrameIndex !== null && pose.assetFrameIndex >= asset.frames.length)) throw new Error('特效姿态轨迹数据无效');
        previousTime = pose.timeMs;
      }
    }
  }

  function renderEffectScenePreview(result) {
    destroyEffectScene();
    stopAnimation();
    elements.previewStage.replaceChildren();
    const scene = {
      id: String(state.current?.id ?? ''), result,
      bounds: result.canvas?.bounds && Number.isFinite(result.canvas.bounds.minX) && Number.isFinite(result.canvas.bounds.minY) &&
        Number.isFinite(result.canvas.bounds.width) && Number.isFinite(result.canvas.bounds.height) &&
        result.canvas.bounds.width > 0 && result.canvas.bounds.height > 0
        ? result.canvas.bounds : { minX: 0, minY: 0, width: 1, height: 1 },
      abort: new AbortController(), images: [], textures: [], assets: new Map(), layers: [],
      issues: [], issueKeys: new Set(), partial: !!result.partial || !result.timelineComplete,
      timelineComplete: result.timelineComplete, lifeMs: Number.isFinite(result.lifeMs) && result.lifeMs > 0 ? result.lifeMs : 0,
      currentTime: 0, playing: false, raf: 0, lastDrawAt: 0,
      scale: 1, panX: 0, panY: 0, fitMode: true,
      gl: null, renderer: null, resizeObserver: null,
    };
    state.effectScene = scene;
    scene.listen = (target, type, listener, options = {}) => {
      target.addEventListener(type, listener, { ...options, signal: scene.abort.signal });
    };
    for (const issue of Array.isArray(result.issues) ? result.issues : []) addEffectIssue(scene, issue);
    if (!scene.lifeMs) addEffectIssue(scene, '', '生命周期无效，无法播放合成轨迹');
    if (!result.timelineComplete) addEffectIssue(scene, '', '合成轨迹未完整生成，不能播放');
    const root = document.createElement('div');
    root.className = 'effect-scene-view';
    scene.root = root;
    const canvas = document.createElement('canvas');
    canvas.className = 'effect-scene-canvas';
    canvas.setAttribute('aria-label', 'EFF 特效合成预览');
    scene.canvas = canvas;
    const toolbar = document.createElement('div');
    toolbar.className = 'effect-scene-toolbar';
    const resourcesButton = makeSceneButton('图层', 'effect-scene-resources-button');
    resourcesButton.setAttribute('aria-expanded', 'false');
    const resourcesPanel = document.createElement('div');
    resourcesPanel.className = 'effect-scene-panel hidden';
    scene.resourcesButton = resourcesButton;
    scene.resourcesPanel = resourcesPanel;
    const issuesButton = makeSceneButton('问题 0', 'effect-scene-issues-button hidden');
    const issuesPanel = document.createElement('div');
    issuesPanel.className = 'effect-scene-panel effect-scene-issues hidden';
    scene.issuesButton = issuesButton;
    scene.issuesPanel = issuesPanel;
    const partial = document.createElement('span');
    partial.className = 'effect-scene-partial hidden';
    partial.textContent = '部分预览';
    scene.partialLabel = partial;
    toolbar.append(resourcesButton, issuesButton, partial);
    const controls = document.createElement('div');
    controls.className = 'effect-scene-controls';
    const replay = makeSceneButton('重播', 'effect-scene-action');
    const play = makeSceneButton('播放', 'effect-scene-action');
    const progress = document.createElement('input');
    progress.type = 'range';
    progress.min = '0';
    progress.max = String(scene.lifeMs);
    progress.step = 'any';
    progress.value = '0';
    progress.setAttribute('aria-label', '特效预览进度');
    const timeLabel = document.createElement('span');
    timeLabel.className = 'effect-scene-time';
    scene.playButton = play;
    scene.replayButton = replay;
    scene.progress = progress;
    scene.timeLabel = timeLabel;
    const fit = makeSceneButton('适应', 'effect-scene-action');
    controls.append(replay, play, progress, timeLabel, fit);
    root.append(canvas, toolbar, resourcesPanel, issuesPanel, controls);
    elements.previewStage.append(root);
    try {
      scene.renderer = createEffectRenderer(canvas);
      scene.gl = scene.renderer.gl;
    } catch (error) {
      destroyEffectScene();
      showPreviewError(error?.message || String(error));
      return;
    }
    for (const asset of result.assets) scene.assets.set(asset.id, { source: asset, frames: new Map() });
    const resourceIndex = new Map();
    for (const entry of state.entries) {
      const key = normalizeScenePath(entry.name);
      if (!resourceIndex.has(key)) resourceIndex.set(key, []);
      resourceIndex.get(key).push(entry);
    }
    for (const [index, layerData] of result.layers.entries()) {
      const layer = {
        source: layerData, visible: true,
        asset: layerData.assetId === null ? null : scene.assets.get(layerData.assetId),
      };
      layer.unsupported = layerData.resolvedBlend === 'max' && scene.renderer.maxBlend == null;
      scene.layers.push(layer);
      if (!layerData.poses.length && result.timelineComplete) addEffectIssue(scene, layerData.spritePath || '', '此图层没有可用的姿态轨迹');
      if (layer.unsupported) addEffectIssue(scene, layerData.spritePath || '', '当前 WebGL 缺少 MAX 混合支持，已跳过此图层');
      if (layerData.assetId !== null && !layer.asset) addEffectIssue(scene, layerData.spritePath || '', '图层素材未包含在场景中');
      if (layer.asset && !layer.asset.source.frames.length) addEffectIssue(scene, layer.asset.source.path || layerData.spritePath || '', '引用素材没有可用帧');
      const layerRow = document.createElement('div');
      layerRow.className = 'effect-scene-layer-row';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.disabled = !layer.asset || !layer.asset.source.frames.length || layer.unsupported;
      const title = document.createElement('span');
      title.className = 'effect-scene-layer-name';
      title.textContent = `层 ${layerData.sourceIndex || index + 1} · ${layerData.sprite || '未知素材'}`;
      title.title = title.textContent;
      layerRow.append(checkbox, title);
      if (layer.asset?.source.path) {
        const resolved = resolveProjectResourcePath(layer.asset.source.path, resourceIndex);
        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'effect-scene-resource-link';
        link.textContent = resolved.status === 'found' ? '打开素材' : resolved.status === 'ambiguous' ? '路径重名' : '工程中缺失';
        link.title = layer.asset.source.path;
        link.disabled = resolved.status !== 'found';
        if (resolved.status === 'found') scene.listen(link, 'click', () => openEntry(resolved.entry, true));
        layerRow.append(link);
        if (resolved.status !== 'found') addEffectIssue(scene, layer.asset.source.path,
          resolved.status === 'ambiguous' ? '素材路径存在重名，无法跳转' : '素材路径不在当前工程');
      } else {
        const missing = document.createElement('span');
        missing.className = 'effect-scene-resource-missing';
        missing.textContent = '素材缺失';
        layerRow.append(missing);
      }
      resourcesPanel.append(layerRow);
      scene.listen(checkbox, 'change', () => {
        layer.visible = checkbox.checked;
        requestEffectDraw(scene, true);
      });
    }
    scene.partial = scene.partial || scene.issues.length > 0;
    scene.partialLabel.classList.toggle('hidden', !scene.partial);
    bindEffectSceneEvents(scene, resourcesButton, issuesButton, play, replay, progress, fit);
    try {
      loadEffectTextures(scene);
    } catch (error) {
      addEffectIssue(scene, '', error?.message || String(error));
      scene.partial = true;
      scene.partialLabel.classList.remove('hidden');
    }
    const ResizeObserverClass = window.ResizeObserver;
    if (ResizeObserverClass) {
      scene.resizeObserver = new ResizeObserverClass(() => {
        if (state.effectScene !== scene) return;
        resizeEffectCanvas(scene);
        if (scene.fitMode) fitEffectScene(scene);
        else requestEffectDraw(scene, true);
      });
      scene.resizeObserver.observe(root);
    }
    resizeEffectCanvas(scene);
    fitEffectScene(scene);
    syncEffectControls(scene);
    updateEffectIssues(scene);
  }

  function addEffectIssue(scene, issueOrPath, reason = '') {
    const issue = typeof issueOrPath === 'object' && issueOrPath
      ? { path: String(issueOrPath.path || ''), reason: String(issueOrPath.reason || '') }
      : { path: String(issueOrPath || ''), reason: String(reason || '') };
    const key = `${issue.path}\u0000${issue.reason}`;
    if (scene.issueKeys.has(key) || scene.issues.length >= 501) return;
    scene.issueKeys.add(key);
    scene.issues.push(issue);
    scene.partial = true;
    if (scene.partialLabel) scene.partialLabel.classList.remove('hidden');
    updateEffectIssues(scene);
  }

  function updateEffectIssues(scene) {
    if (state.effectScene !== scene || !scene.issuesButton || !scene.issuesPanel) return;
    scene.issuesButton.textContent = `问题 ${scene.issues.length}`;
    scene.issuesButton.classList.toggle('hidden', scene.issues.length === 0);
    scene.issuesPanel.replaceChildren();
    for (const issue of scene.issues) {
      const row = document.createElement('div');
      row.className = 'effect-scene-issue';
      if (issue.path) {
        const path = document.createElement('span');
        path.className = 'effect-scene-issue-path';
        path.textContent = issue.path;
        row.append(path);
      }
      const reason = document.createElement('span');
      reason.textContent = issue.reason || '特效预览异常';
      row.append(reason);
      scene.issuesPanel.append(row);
    }
  }

  function createEffectRenderer(canvas) {
    const options = { alpha: false, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: false };
    let gl = canvas.getContext('webgl2', options);
    const webgl2 = !!gl;
    if (!gl) gl = canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
    if (!gl) throw new Error('此设备无法创建 WebGL 特效预览');
    const blendExtension = webgl2 ? null : gl.getExtension('EXT_blend_minmax');
    const maxBlend = webgl2 ? gl.MAX : blendExtension?.MAX_EXT;
    const vertexSource = webgl2
      ? '#version 300 es\nin vec2 a_position;\nin vec2 a_uv;\nout vec2 v_uv;\nvoid main(){gl_Position=vec4(a_position,0.0,1.0);v_uv=a_uv;}'
      : 'attribute vec2 a_position;\nattribute vec2 a_uv;\nvarying vec2 v_uv;\nvoid main(){gl_Position=vec4(a_position,0.0,1.0);v_uv=a_uv;}';
    const fragmentSource = webgl2
      ? '#version 300 es\nprecision mediump float;\nin vec2 v_uv;\nuniform sampler2D u_texture;\nuniform vec4 u_color;\nout vec4 outColor;\nvoid main(){vec4 sampled=texture(u_texture,v_uv);outColor=vec4(sampled.rgb*u_color.rgb,sampled.a*u_color.a);}'
      : 'precision mediump float;\nvarying vec2 v_uv;\nuniform sampler2D u_texture;\nuniform vec4 u_color;\nvoid main(){vec4 sampled=texture2D(u_texture,v_uv);gl_FragColor=vec4(sampled.rgb*u_color.rgb,sampled.a*u_color.a);}';
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const message = gl.getShaderInfoLog(shader) || 'WebGL shader 编译失败';
        gl.deleteShader(shader);
        throw new Error(message);
      }
      return shader;
    };
    let vertexShader;
    let fragmentShader;
    let program;
    try {
      vertexShader = compile(gl.VERTEX_SHADER, vertexSource);
      fragmentShader = compile(gl.FRAGMENT_SHADER, fragmentSource);
      program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || 'WebGL shader 链接失败');
    } catch (error) {
      if (program) gl.deleteProgram(program);
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      throw error;
    }
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    const buffer = gl.createBuffer();
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const uvLocation = gl.getAttribLocation(program, 'a_uv');
    const colorLocation = gl.getUniformLocation(program, 'u_color');
    const textureLocation = gl.getUniformLocation(program, 'u_texture');
    if (positionLocation < 0 || uvLocation < 0 || !colorLocation || !textureLocation || !buffer) {
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      throw new Error('WebGL 特效预览初始化失败');
    }
    gl.enable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    return {
      gl, webgl2, blendExtension, maxBlend, program, buffer,
      positionLocation, uvLocation, colorLocation, textureLocation,
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  }

  function destroyEffectScene() {
    const scene = state.effectScene;
    if (!scene) return;
    scene.playing = false;
    if (scene.raf) cancelAnimationFrame(scene.raf);
    if (scene.drawTimer) clearTimeout(scene.drawTimer);
    scene.abort.abort();
    scene.resizeObserver?.disconnect();
    for (const image of scene.images) {
      image.onload = null;
      image.onerror = null;
      image.src = '';
    }
    if (scene.gl && !scene.contextLost) {
      for (const texture of scene.textures) scene.gl.deleteTexture(texture);
      if (scene.renderer?.buffer) scene.gl.deleteBuffer(scene.renderer.buffer);
      if (scene.renderer?.program) scene.gl.deleteProgram(scene.renderer.program);
    }
    scene.assets?.clear();
    scene.textures?.splice(0);
    scene.root?.remove();
    state.effectScene = null;
  }

  function loadEffectTextures(scene) {
    let frameCount = 0;
    let pixelCount = 0;
    let encodedBytes = 0;
    for (const asset of scene.assets.values()) {
      const source = asset.source;
      if (!Number.isFinite(source.tier) || source.tier <= 0 || source.tier > 4096 || !Array.isArray(source.frames)) {
        addEffectIssue(scene, source.path || '', '素材尺寸比例无效');
        continue;
      }
      for (const frame of source.frames) {
        const pixels = frame.width * frame.height;
        if (frameCount >= 512 || pixelCount + pixels > 16777216 || encodedBytes + frame.base64.length > 67108864 ||
            frame.width > scene.renderer.maxTextureSize || frame.height > scene.renderer.maxTextureSize) {
          addEffectIssue(scene, source.path || '', '素材超出特效预览纹理预算，已跳过后续帧');
          break;
        }
        frameCount += 1;
        pixelCount += pixels;
        encodedBytes += frame.base64.length;
        const cachedFrame = { metadata: frame, texture: null, image: null };
        asset.frames.set(frame.frameIndex, cachedFrame);
        const image = new Image();
        cachedFrame.image = image;
        scene.images.push(image);
        image.onload = () => {
          if (state.effectScene !== scene || scene.abort.signal.aborted) return;
          if (image.naturalWidth !== frame.width || image.naturalHeight !== frame.height) {
            cachedFrame.image = null;
            image.onload = null;
            image.onerror = null;
            image.src = '';
            addEffectIssue(scene, source.path || '', '素材帧解码尺寸与声明不一致');
            syncEffectControls(scene);
            return;
          }
          try {
            const gl = scene.gl;
            const texture = gl.createTexture();
            if (!texture) throw new Error('无法分配 WebGL 纹理');
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
            if (gl.UNPACK_COLORSPACE_CONVERSION_WEBGL !== undefined) gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
            const uploadError = gl.getError();
            if (uploadError !== gl.NO_ERROR) {
              gl.deleteTexture(texture);
              throw new Error(`WebGL 纹理上传失败（${uploadError}）`);
            }
            cachedFrame.texture = texture;
            cachedFrame.image = null;
            scene.textures.push(texture);
          } catch (error) {
            addEffectIssue(scene, source.path || '', error?.message || String(error));
          } finally {
            image.onload = null;
            image.onerror = null;
            image.src = '';
            cachedFrame.image = null;
            syncEffectControls(scene);
            requestEffectDraw(scene, true);
          }
        };
        image.onerror = () => {
          if (state.effectScene !== scene) return;
          cachedFrame.image = null;
          image.onload = null;
          image.onerror = null;
          image.src = '';
          addEffectIssue(scene, source.path || '', '素材 PNG 无法解码');
          syncEffectControls(scene);
          requestEffectDraw(scene, true);
        };
        image.src = sceneDataUrl(frame);
      }
    }
    scene.resourcePixels = pixelCount;
    scene.resourceFrames = frameCount;
  }

  function bindEffectSceneEvents(scene, resourcesButton, issuesButton, playButton, replayButton, progress, fitButton) {
    const togglePanel = (panel, button) => {
      const open = panel.classList.contains('hidden');
      scene.resourcesPanel.classList.add('hidden');
      scene.issuesPanel.classList.add('hidden');
      scene.resourcesButton.setAttribute('aria-expanded', 'false');
      scene.issuesButton.setAttribute('aria-expanded', 'false');
      panel.classList.toggle('hidden', !open);
      button.setAttribute('aria-expanded', String(open));
    };
    scene.listen(resourcesButton, 'click', () => togglePanel(scene.resourcesPanel, resourcesButton));
    scene.listen(issuesButton, 'click', () => togglePanel(scene.issuesPanel, issuesButton));
    scene.listen(playButton, 'click', () => {
      if (scene.playing) pauseEffectScene(scene);
      else playEffectScene(scene);
    });
    scene.listen(replayButton, 'click', () => {
      pauseEffectScene(scene);
      scene.currentTime = 0;
      progress.value = '0';
      requestEffectDraw(scene, true);
      syncEffectControls(scene);
      playEffectScene(scene);
    });
    scene.listen(progress, 'input', () => {
      pauseEffectScene(scene);
      scene.currentTime = Math.max(0, Math.min(scene.lifeMs, Number(progress.value) || 0));
      syncEffectControls(scene);
      requestEffectDraw(scene);
    });
    scene.listen(fitButton, 'click', () => fitEffectScene(scene));
    scene.listen(scene.root, 'click', (event) => {
      if (!scene.resourcesPanel.contains(event.target) && event.target !== resourcesButton) {
        scene.resourcesPanel.classList.add('hidden');
        resourcesButton.setAttribute('aria-expanded', 'false');
      }
      if (!scene.issuesPanel.contains(event.target) && event.target !== issuesButton) {
        scene.issuesPanel.classList.add('hidden');
        issuesButton.setAttribute('aria-expanded', 'false');
      }
    });
    scene.listen(document, 'keydown', (event) => {
      if (event.key !== 'Escape' || state.effectScene !== scene) return;
      scene.resourcesPanel.classList.add('hidden');
      scene.issuesPanel.classList.add('hidden');
      resourcesButton.setAttribute('aria-expanded', 'false');
      issuesButton.setAttribute('aria-expanded', 'false');
    });
    scene.listen(scene.canvas, 'webglcontextlost', (event) => {
      event.preventDefault();
      scene.contextLost = true;
      pauseEffectScene(scene);
      addEffectIssue(scene, '', 'WebGL 上下文已丢失，请重新打开预览');
      syncEffectControls(scene);
    });
  }

  function effectPoseAt(layer, timeMs) {
    const poses = layer.source.poses;
    if (!poses.length) return null;
    let low = 0;
    let high = poses.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (poses[mid].timeMs <= timeMs) low = mid;
      else high = mid - 1;
    }
    if (low + 1 < poses.length && Math.abs(poses[low + 1].timeMs - timeMs) < Math.abs(poses[low].timeMs - timeMs)) return poses[low + 1];
    return poses[low];
  }

  function requestEffectDraw(scene, force = false) {
    if (state.effectScene !== scene) return;
    const now = performance.now();
    const delay = 1000 / 30 - (now - scene.lastDrawAt);
    if (!force && delay > 1) {
      if (!scene.drawTimer) {
        scene.drawTimer = setTimeout(() => {
          scene.drawTimer = null;
          drawEffectScene(scene);
        }, delay);
      }
      return;
    }
    if (scene.drawTimer) {
      clearTimeout(scene.drawTimer);
      scene.drawTimer = null;
    }
    drawEffectScene(scene);
  }

  function drawEffectScene(scene) {
    if (state.effectScene !== scene || !scene.gl || scene.contextLost) return;
    const gl = scene.gl;
    const renderer = scene.renderer;
    const dpr = scene.dpr || 1;
    const width = scene.canvas.width;
    const height = scene.canvas.height;
    scene.lastDrawAt = performance.now();
    gl.viewport(0, 0, width, height);
    gl.clearColor(0.075, 0.082, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(renderer.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, renderer.buffer);
    gl.enableVertexAttribArray(renderer.positionLocation);
    gl.enableVertexAttribArray(renderer.uvLocation);
    gl.vertexAttribPointer(renderer.positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(renderer.uvLocation, 2, gl.FLOAT, false, 16, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(renderer.textureLocation, 0);
    for (const layer of scene.layers) {
      if (!layer.visible || layer.unsupported) continue;
      const pose = effectPoseAt(layer, scene.currentTime);
      const asset = layer.asset;
      const frame = pose && asset?.frames.get(pose.assetFrameIndex);
      if (!pose || !pose.visible || !frame?.texture) continue;
      const tier = asset.source.tier;
      const scaleX = pose.scale[0];
      const scaleY = pose.scale[1];
      const widthWorld = frame.metadata.width / tier;
      const heightWorld = frame.metadata.height / tier;
      const anchorX = frame.metadata.anchor[0] / tier;
      const anchorY = frame.metadata.anchor[1] / tier;
      const originX = pose.position[0] + layer.source.offset[0];
      const originY = pose.position[1] * 0.5 + layer.source.offset[1] - pose.position[2];
      const angle = -pose.rotation * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const localCorners = [
        [-anchorX * scaleX, -anchorY * scaleY, 0, 0],
        [(widthWorld - anchorX) * scaleX, -anchorY * scaleY, 1, 0],
        [(widthWorld - anchorX) * scaleX, (heightWorld - anchorY) * scaleY, 1, 1],
        [-anchorX * scaleX, (heightWorld - anchorY) * scaleY, 0, 1],
      ];
      const clip = localCorners.map(([localX, localY, u, v]) => {
        const worldX = originX + localX * cos - localY * sin;
        const worldY = originY + localX * sin + localY * cos;
        const screenX = (worldX * scene.scale + scene.panX) * dpr;
        const screenY = (worldY * scene.scale + scene.panY) * dpr;
        return [screenX / width * 2 - 1, 1 - screenY / height * 2, u, v];
      });
      const vertices = new Float32Array([...clip[0], ...clip[1], ...clip[2], ...clip[0], ...clip[2], ...clip[3]]);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STREAM_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, frame.texture);
      gl.uniform4f(renderer.colorLocation, pose.color[0], pose.color[1], pose.color[2], pose.alpha);
      if (layer.source.resolvedBlend === 'max') {
        if (renderer.maxBlend === null || renderer.maxBlend === undefined) continue;
        gl.blendEquation(renderer.maxBlend);
        gl.blendFunc(gl.ONE, gl.ONE);
      } else if (layer.source.resolvedBlend === 'additive') {
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      } else {
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  function resizeEffectCanvas(scene) {
    if (state.effectScene !== scene) return;
    const rect = scene.root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.min(4096, Math.round(rect.width * dpr)));
    const height = Math.max(1, Math.min(4096, Math.round(rect.height * dpr)));
    scene.dpr = dpr;
    if (scene.canvas.width !== width || scene.canvas.height !== height) {
      scene.canvas.width = width;
      scene.canvas.height = height;
    }
    if (scene.gl) scene.gl.viewport(0, 0, width, height);
    requestEffectDraw(scene, true);
  }

  function fitEffectScene(scene) {
    if (state.effectScene !== scene) return;
    const rect = scene.root.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const toolbarHeight = scene.toolbarHeight || 34;
    const controlsHeight = scene.controlsHeight || 42;
    const fitWidth = Math.max(1, rect.width - 32);
    const fitHeight = Math.max(1, rect.height - toolbarHeight - controlsHeight - 28);
    scene.scale = Math.max(0.001, Math.min(64, Math.min(fitWidth / scene.bounds.width, fitHeight / scene.bounds.height)));
    scene.panX = (rect.width - scene.bounds.width * scene.scale) / 2 - scene.bounds.minX * scene.scale;
    const contentTop = toolbarHeight + 8;
    scene.panY = contentTop + fitHeight / 2 - (scene.bounds.minY + scene.bounds.height / 2) * scene.scale;
    scene.fitMode = true;
    requestEffectDraw(scene, true);
  }

  function updateEffectTimeline(scene) {
    scene.progress.value = String(scene.currentTime);
    scene.timeLabel.textContent = `${Math.round(scene.currentTime)} / ${Math.round(scene.lifeMs)} ms`;
  }

  function syncEffectControls(scene) {
    if (state.effectScene !== scene) return;
    const ready = scene.timelineComplete && scene.layers.some((layer) => !layer.unsupported && layer.asset &&
      [...layer.asset.frames.values()].some((frame) => !!frame.texture));
    scene.playButton.disabled = !ready;
    scene.replayButton.disabled = !ready;
    scene.progress.disabled = !scene.timelineComplete;
    scene.playButton.textContent = scene.playing ? '暂停' : '播放';
    updateEffectTimeline(scene);
  }

  function playEffectScene(scene) {
    if (state.effectScene !== scene || !scene.timelineComplete || scene.playing ||
        !scene.layers.some((layer) => !layer.unsupported && layer.asset && [...layer.asset.frames.values()].some((frame) => !!frame.texture))) return;
    if (scene.currentTime >= scene.lifeMs) scene.currentTime = 0;
    scene.playing = true;
    scene.lastTimestamp = performance.now();
    syncEffectControls(scene);
    const tick = (timestamp) => {
      if (state.effectScene !== scene || !scene.playing) return;
      const elapsed = Math.max(0, timestamp - scene.lastTimestamp);
      scene.lastTimestamp = timestamp;
      scene.currentTime = Math.min(scene.lifeMs, scene.currentTime + elapsed);
      updateEffectTimeline(scene);
      if (timestamp - scene.lastDrawAt >= 1000 / 30) drawEffectScene(scene);
      if (scene.currentTime >= scene.lifeMs) {
        scene.playing = false;
        drawEffectScene(scene);
        syncEffectControls(scene);
        scene.raf = 0;
        return;
      }
      scene.raf = requestAnimationFrame(tick);
    };
    scene.raf = requestAnimationFrame(tick);
  }

  function pauseEffectScene(scene) {
    if (!scene) return;
    scene.playing = false;
    if (scene.raf) cancelAnimationFrame(scene.raf);
    scene.raf = 0;
    syncEffectControls(scene);
  }

  function appendTableCell(row, value, options = {}) {
    const cell = document.createElement(options.header ? 'th' : 'td');
    if (options.header) cell.setAttribute('scope', 'col');
    if (options.rowIndex) {
      cell.className = 'table-row-index';
      if (!options.header) cell.setAttribute('scope', 'row');
    }
    const text = String(value ?? '');
    cell.textContent = text;
    cell.title = text;
    row.append(cell);
    return cell;
  }

  function renderTableData(result) {
    const columns = Array.isArray(result.columns) ? result.columns : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const table = document.createElement('table');
    table.className = 'bin-table bin-data-table';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    appendTableCell(headerRow, '#', { header: true, rowIndex: true });
    for (const column of columns) {
      const cell = appendTableCell(headerRow, column?.name || column?.key || '', { header: true });
      cell.title = [column?.name, column?.type, column?.description].filter(Boolean).join(' · ');
    }
    head.append(headerRow);
    table.append(head);
    const body = document.createElement('tbody');
    for (const rowData of rows) {
      const row = document.createElement('tr');
      appendTableCell(row, rowData?.index ?? '', { rowIndex: true });
      const cells = Array.isArray(rowData?.cells) ? rowData.cells : [];
      for (let index = 0; index < columns.length; index += 1) appendTableCell(row, cells[index] ?? '');
      body.append(row);
    }
    table.append(body);
    elements.previewStage.append(table);
  }

  function renderTableDefinition(result) {
    const schema = result.schema && typeof result.schema === 'object' ? result.schema : {};
    const status = String(schema.status || 'invalid');
    const statusLabels = {
      matched: '结构已匹配', missing: '结构缺失 · 原始字节列',
      unmatched: '结构不匹配 · 原始字节列', invalid: '结构无效',
      loader: '资源加载器定义', partial: '部分字段已解析',
    };
    const summary = document.createElement('div');
    summary.className = 'table-schema-summary';
    const details = [statusLabels[status] || '结构状态未知', schema.source, schema.structName]
      .filter((part) => typeof part === 'string' && part.trim());
    summary.textContent = details.join(' · ');
    summary.title = String(schema.message || '');

    const table = document.createElement('table');
    table.className = 'bin-table bin-definition-table';
    const head = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const title of ['字段名', '说明', '类型', '偏移', '长度']) appendTableCell(headerRow, title, { header: true });
    head.append(headerRow);
    table.append(head);
    const body = document.createElement('tbody');
    const columns = Array.isArray(result.columns) ? result.columns : [];
    for (const column of columns) {
      const row = document.createElement('tr');
      for (const value of [column?.name || column?.key || '', column?.description || '', column?.type || '', column?.offset ?? '', column?.size ?? '']) {
        appendTableCell(row, value);
      }
      body.append(row);
    }
    if (!columns.length) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 5;
      cell.className = 'table-empty-cell';
      cell.textContent = status === 'missing' || status === 'unmatched' ? '原始字节列暂无字段定义' : '没有字段定义';
      row.append(cell);
      body.append(row);
    }
    table.append(body);
    elements.previewStage.append(summary, table);
  }

  function validateTablePreview(result) {
    if (!Array.isArray(result.columns) || !Array.isArray(result.rows)) throw new Error('表格预览数据格式无效');
    const page = result.columnPage;
    const pageCount = result.columnPageCount;
    const pageSize = result.columnPageSize;
    const total = result.totalColumnCount;
    const expectedColumns = Math.max(0, Math.min(pageSize, total - page * pageSize));
    const rowCount = result.rowCount;
    const rowPageCount = result.pageCount;
    if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageCount) || pageCount < 1 ||
        !Number.isSafeInteger(pageSize) || pageSize !== 64 || !Number.isSafeInteger(total) || total < 0 ||
        page >= pageCount || pageCount !== Math.max(1, Math.ceil(total / pageSize)) || result.columns.length !== expectedColumns ||
        !Number.isSafeInteger(rowCount) || rowCount < 0 || !Number.isSafeInteger(rowPageCount) || rowPageCount < 1 ||
        rowPageCount > 67108864 || !Number.isSafeInteger(result.page) || result.page < 0 || result.page >= rowPageCount ||
        rowPageCount > Math.max(1, rowCount)) {
      throw new Error('表格字段分页元数据无效');
    }
    if (result.columns.some((column) => !column || typeof column !== 'object' ||
        ['key', 'name', 'description', 'type'].some((key) => typeof column[key] !== 'string') ||
        !Number.isSafeInteger(column.offset) || column.offset < 0 ||
        !Number.isSafeInteger(column.size) || column.size < 0) ||
        result.rows.some((row) => !row || !Array.isArray(row.cells) || row.cells.length !== result.columns.length ||
          !['string', 'number'].includes(typeof row.index) || row.cells.some((cell) => typeof cell !== 'string'))) {
      throw new Error('表格字段或行数据与当前分页不匹配');
    }
  }

  function destroyMapScene() {
    const scene = state.mapScene;
    if (!scene) return;
    const tab = getTab(scene.id);
    if (tab) {
      tab.mapSceneView = {
        width: scene.width,
        height: scene.height,
        scale: scene.scale,
        panX: scene.panX,
        panY: scene.panY,
        fitMode: scene.fitMode,
        visible: { ...scene.visible },
      };
    }
    if (scene.dragging && scene.pointerId !== undefined) {
      try { if (scene.viewport.hasPointerCapture(scene.pointerId)) scene.viewport.releasePointerCapture(scene.pointerId); } catch (_) { /* capture already ended */ }
    }
    scene.abort.abort();
    scene.resizeObserver?.disconnect();
    if (scene.fitFrame) cancelAnimationFrame(scene.fitFrame);
    for (const image of scene.images) {
      image.onload = null;
      image.onerror = null;
    }
    scene.root?.remove();
    state.mapScene = null;
  }

  function sceneDataUrl(layer) {
    if (!layer || typeof layer.base64 !== 'string' || !layer.base64.length ||
        layer.base64.length > 134217728 || layer.base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(layer.base64) ||
        !/^image\/(?:png|jpeg|webp|gif|bmp)$/i.test(String(layer.mime || ''))) return '';
    return `data:${layer.mime};base64,${layer.base64}`;
  }

  function sceneNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function addSceneIssue(scene, issueOrPath, reason = '') {
    const issue = typeof issueOrPath === 'object' && issueOrPath
      ? { path: String(issueOrPath.path || ''), reason: String(issueOrPath.reason || '') }
      : { path: String(issueOrPath || ''), reason: String(reason || '') };
    const key = `${issue.path}\u0000${issue.reason}`;
    if (scene.issueKeys.has(key) || scene.issues.length >= 501) return;
    scene.issueKeys.add(key);
    scene.issues.push(issue);
    updateSceneIssues(scene);
  }

  function updateSceneIssues(scene) {
    if (state.mapScene !== scene || !scene.ready || !scene.issueButton || !scene.issuePanel) return;
    scene.issueButton.textContent = `问题 ${scene.issues.length}`;
    scene.issueButton.classList.toggle('hidden', scene.issues.length === 0);
    scene.issueButton.setAttribute('aria-expanded', String(!scene.issuePanel.classList.contains('hidden')));
    scene.issuePanel.replaceChildren();
    for (const issue of scene.issues) {
      const row = document.createElement('div');
      row.className = 'map-scene-issue';
      if (issue.path) {
        const path = document.createElement('span');
        path.className = 'map-scene-issue-path';
        path.textContent = issue.path;
        row.append(path);
      }
      const reason = document.createElement('span');
      reason.textContent = issue.reason || '场景数据异常';
      row.append(reason);
      scene.issuePanel.append(row);
    }
  }

  function createMapScene(result) {
    destroyMapScene();
    const width = result?.width;
    const height = result?.height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 ||
        width > 32768 || height > 32768 || width * height > 268435456) {
      showPreviewError('地图场景尺寸无效，无法显示');
      return;
    }
    const groundSrc = sceneDataUrl({ base64: result.base64, mime: result.mime });
    if (!groundSrc) {
      showPreviewError('地图地面图像缺失或格式不可用');
      return;
    }
    const scene = {
      id: String(state.current?.id ?? ''), width, height, result,
      abort: new AbortController(), images: [], resizeObserver: null, fitFrame: 0,
      scale: 1, panX: 0, panY: 0, fitMode: true, dragging: false,
      pointerStart: null, suppressClickUntil: 0, issues: [], issueKeys: new Set(), ready: false,
      visible: { ground: true, objects: true, collision: false, transfer: false, npc: false, spawn: false, trigger: false, unknown: false },
      layers: {}, hitObjects: [], markerItems: [], resourceIndex: new Map(),
    };
    state.mapScene = scene;
    scene.listen = (target, type, listener, options = {}) => {
      target.addEventListener(type, listener, { ...options, signal: scene.abort.signal });
    };
    for (const issue of Array.isArray(result.issues) ? result.issues : []) addSceneIssue(scene, issue);
    for (const entry of state.entries) {
      const key = normalizeScenePath(entry.name);
      if (!scene.resourceIndex.has(key)) scene.resourceIndex.set(key, []);
      scene.resourceIndex.get(key).push(entry);
    }

    const root = document.createElement('div');
    root.className = 'map-scene-view';
    scene.root = root;
    const toolbar = document.createElement('div');
    toolbar.className = 'map-scene-toolbar';
    const layersButton = makeSceneButton('图层', 'map-scene-layers-button');
    layersButton.setAttribute('aria-expanded', 'false');
    const layersMenu = document.createElement('div');
    layersMenu.className = 'map-scene-layers hidden';
    scene.layersMenu = layersMenu;
    const issueButton = makeSceneButton('问题 0', 'map-scene-issues-button hidden');
    const issuePanel = document.createElement('div');
    issuePanel.className = 'map-scene-issues hidden';
    scene.issueButton = issueButton;
    scene.issuePanel = issuePanel;
    const zoomOut = makeSceneButton('−', 'map-scene-zoom-button');
    zoomOut.title = '缩小';
    const zoomValue = document.createElement('span');
    zoomValue.className = 'map-scene-zoom-value';
    zoomValue.textContent = '100%';
    scene.zoomValue = zoomValue;
    const zoomIn = makeSceneButton('+', 'map-scene-zoom-button');
    zoomIn.title = '放大';
    const fitButton = makeSceneButton('适应', 'map-scene-fit-button');
    toolbar.append(layersButton, issueButton, zoomOut, zoomValue, zoomIn, fitButton);
    root.append(toolbar, layersMenu, issuePanel);

    const viewport = document.createElement('div');
    viewport.className = 'map-scene-viewport';
    viewport.setAttribute('aria-label', '地图场景，可拖动平移并滚轮缩放');
    scene.viewport = viewport;
    const world = document.createElement('div');
    world.className = 'map-scene-world';
    world.style.width = `${width}px`;
    world.style.height = `${height}px`;
    scene.world = world;
    viewport.append(world);
    root.append(viewport);
    const popover = document.createElement('div');
    popover.className = 'map-scene-popover hidden';
    scene.popover = popover;
    viewport.append(popover);

    const ground = makeSceneImage(scene, groundSrc, width, height, 'map-scene-ground', '地图地面层');
    world.append(ground);
    scene.layers.ground = { elements: [ground], present: true };
    const objectSrc = sceneDataUrl(result.objectLayer);
    if (result.objectLayer && !objectSrc) addSceneIssue(scene, '', '物件层图像格式无效');
    const objectImage = objectSrc ? makeSceneImage(scene, objectSrc, width, height, 'map-scene-object-image', '地图物件层') : null;
    const objectsGroup = document.createElement('div');
    objectsGroup.className = 'map-scene-object-hits';
    scene.objectGroup = objectsGroup;
    const validObjects = Array.isArray(result.objects) ? result.objects : [];
    if (result.objects !== undefined && !Array.isArray(result.objects)) {
      addSceneIssue(scene, '', '物件列表格式无效');
    }
    for (const object of validObjects) {
      collectSceneReferenceIssues(scene, object);
      if (!isSceneRect(object)) {
        addSceneIssue(scene, object?.path || '', '物件坐标无效');
        continue;
      }
      const hit = makeSceneHit(scene, object, 'object');
      hit.style.left = `${object.x}px`;
      hit.style.top = `${object.y}px`;
      hit.style.width = `${Math.max(1, object.width)}px`;
      hit.style.height = `${Math.max(1, object.height)}px`;
      objectsGroup.append(hit);
      scene.hitObjects.push(object);
    }
    if (objectImage) world.append(objectImage);
    else if (validObjects.length) addSceneIssue(scene, '', '物件层图像缺失');
    world.append(objectsGroup);
    scene.layers.objects = { elements: [objectImage, objectsGroup].filter(Boolean), present: !!objectImage || validObjects.length > 0 };

    const collision = result.collision;
    const collisionSrc = sceneDataUrl(collision);
    const validTransform = Array.isArray(collision?.transform) && collision.transform.length === 6 &&
      collision.transform.every((value) => sceneNumber(value) && Math.abs(value) < 1000000);
    let collisionImage = null;
    if (collision) {
      if (collisionSrc && Number.isSafeInteger(collision.width) && collision.width > 0 && collision.width <= 32768 &&
          Number.isSafeInteger(collision.height) && collision.height > 0 && collision.height <= 32768 &&
          collision.width * collision.height <= 268435456 && validTransform) {
        collisionImage = makeSceneImage(scene, collisionSrc, collision.width, collision.height, 'map-scene-collision', '碰撞层');
        collisionImage.style.transform = `matrix(${collision.transform.join(',')})`;
        collisionImage.style.transformOrigin = '0 0';
        scene.visible.collision = false;
        world.append(collisionImage);
      } else addSceneIssue(scene, '', '碰撞图层数据无效');
    }
    scene.layers.collision = { elements: collisionImage ? [collisionImage] : [], present: !!collisionImage };

    const markers = Array.isArray(result.markers) ? result.markers : [];
    if (result.markers !== undefined && !Array.isArray(result.markers)) {
      addSceneIssue(scene, '', '逻辑标记列表格式无效');
    }
    const unknownKinds = new Set();
    const recognizedKinds = new Set(['transfer', 'npc', 'spawn', 'trigger']);
    const polygonSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    polygonSvg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    polygonSvg.setAttribute('width', String(width));
    polygonSvg.setAttribute('height', String(height));
    polygonSvg.setAttribute('aria-hidden', 'true');
    polygonSvg.classList.add('map-scene-polygons');
    const polygonGroups = new Map();
    for (const marker of markers) {
      collectSceneReferenceIssues(scene, marker);
      const kind = recognizedKinds.has(marker?.kind) ? marker.kind : 'unknown';
      if (kind === 'unknown') {
        unknownKinds.add(String(marker?.kind || 'unknown'));
        addSceneIssue(scene, marker?.path || '', `未识别的逻辑图层：${String(marker?.kind || 'unknown')}`);
      }
      if (!scene.markerGroups?.[kind]) {
        if (!scene.markerGroups) scene.markerGroups = {};
        const group = document.createElement('div');
        group.className = `map-scene-markers scene-kind-${kind}`;
        scene.markerGroups[kind] = group;
        scene.markerItems.push(group);
        world.append(group);
        const svgGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        svgGroup.classList.add(`scene-kind-${kind}`);
        polygonGroups.set(kind, svgGroup);
        polygonSvg.append(svgGroup);
      }
      const polygon = normalizeScenePolygon(marker?.polygon, width, height);
      if (Array.isArray(marker?.polygon) && marker.polygon.length && !polygon) addSceneIssue(scene, marker?.path || '', '标记区域坐标无效');
      if (polygon) {
        const shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        shape.setAttribute('points', polygon.points);
        shape.classList.add('map-scene-polygon');
        polygonGroups.get(kind).append(shape);
      }
      const hit = makeSceneHit(scene, marker, kind);
      const bounds = polygon?.bounds;
      if (bounds) {
        hit.style.left = `${bounds.left}px`;
        hit.style.top = `${bounds.top}px`;
        hit.style.width = `${Math.max(18, bounds.width)}px`;
        hit.style.height = `${Math.max(18, bounds.height)}px`;
      } else if (sceneNumber(marker?.x) && sceneNumber(marker?.y)) {
        hit.style.left = `${marker.x - 11}px`;
        hit.style.top = `${marker.y - 11}px`;
        hit.style.width = '22px';
        hit.style.height = '22px';
      } else {
        addSceneIssue(scene, marker?.path || '', '逻辑标记坐标无效');
        continue;
      }
      hit.append(makeMarkerBadge(kind));
      scene.markerGroups[kind].append(hit);
      scene.markerItems.push(marker);
    }
    if (polygonGroups.size) world.append(polygonSvg);
    scene.layers.markers = {};
    for (const kind of recognizedKinds) {
      const group = scene.markerGroups?.[kind];
      if (!group) continue;
      const shapeGroup = polygonGroups.get(kind);
      scene.layers.markers[kind] = { elements: [group, shapeGroup].filter(Boolean), present: true };
    }
    if (unknownKinds.size) {
      scene.layers.markers.unknown = {
        elements: [scene.markerGroups.unknown, polygonGroups.get('unknown')].filter(Boolean), present: true,
      };
    }

    buildSceneLayerMenu(scene);
    restoreMapSceneView(scene);
    bindSceneEvents(scene, layersButton, zoomOut, zoomIn, fitButton);
    scene.listen(issueButton, 'click', () => {
      scene.issuePanel.classList.toggle('hidden');
      scene.issueButton.setAttribute('aria-expanded', String(!scene.issuePanel.classList.contains('hidden')));
      scene.layersMenu.classList.add('hidden');
      layersButton.setAttribute('aria-expanded', 'false');
    });
    scene.ready = true;
    updateSceneIssues(scene);
    elements.previewStage.replaceChildren(root);
    const ResizeObserverClass = window.ResizeObserver;
    if (ResizeObserverClass) {
      scene.resizeObserver = new ResizeObserverClass(() => {
        if (state.mapScene !== scene) return;
        if (scene.fitMode) fitMapScene(scene);
        else closeScenePopover(scene);
      });
      scene.resizeObserver.observe(viewport);
    }
    scene.fitFrame = requestAnimationFrame(() => {
      scene.fitFrame = 0;
      if (state.mapScene !== scene) return;
      if (scene.restoredView && !scene.fitMode) updateSceneTransform(scene);
      else fitMapScene(scene);
    });
  }

  function restoreMapSceneView(scene) {
    const tab = getTab(scene.id);
    const view = tab?.mapSceneView;
    if (!view || view.width !== scene.width || view.height !== scene.height) {
      if (view) delete tab.mapSceneView;
      return;
    }
    if (sceneNumber(view.scale) && view.scale >= 0.02 && view.scale <= 8 &&
        sceneNumber(view.panX) && Math.abs(view.panX) <= 10000000 &&
        sceneNumber(view.panY) && Math.abs(view.panY) <= 10000000 &&
        typeof view.fitMode === 'boolean') {
      scene.scale = view.scale;
      scene.panX = view.panX;
      scene.panY = view.panY;
      scene.fitMode = view.fitMode;
      scene.restoredView = true;
    } else {
      delete tab.mapSceneView;
    }
    if (!view.visible || typeof view.visible !== 'object') return;
    const available = new Set(['ground']);
    if (scene.layers.objects.present) available.add('objects');
    if (scene.layers.collision.present) available.add('collision');
    for (const kind of Object.keys(scene.layers.markers || {})) available.add(kind);
    for (const key of available) {
      if (typeof view.visible[key] !== 'boolean') continue;
      scene.visible[key] = view.visible[key];
      const control = scene.layerControls?.[key];
      if (control && !control.input.disabled) control.input.checked = view.visible[key];
    }
    applySceneVisibility(scene);
  }

  function makeSceneButton(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  }

  function makeSceneImage(scene, src, width, height, className, label) {
    const image = document.createElement('img');
    image.className = className;
    image.alt = '';
    image.draggable = false;
    image.setAttribute('aria-hidden', 'true');
    image.style.width = `${width}px`;
    image.style.height = `${height}px`;
    image.src = src;
    scene.images.push(image);
    image.onerror = () => {
      if (state.mapScene !== scene) return;
      image.dataset.failed = 'true';
      image.hidden = true;
      addSceneIssue(scene, '', `${label}图像加载失败`);
      if (className === 'map-scene-ground' && !scene.backgroundError) {
        const error = document.createElement('div');
        error.className = 'map-scene-background-error';
        error.textContent = '地面图像缺失';
        scene.viewport.append(error);
        scene.backgroundError = error;
      }
      if (className === 'map-scene-collision') {
        const control = scene.layerControls?.collision;
        if (control) control.input.disabled = true;
      }
    };
    return image;
  }

  function isSceneRect(item) {
    return item && sceneNumber(item.x) && sceneNumber(item.y) &&
      sceneNumber(item.width) && sceneNumber(item.height) && item.width > 0 && item.height > 0 &&
      Math.abs(item.x) < 1000000 && Math.abs(item.y) < 1000000 && item.width < 1000000 && item.height < 1000000;
  }

  function normalizeScenePolygon(polygon, sceneWidth, sceneHeight) {
    if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 4096) return null;
    const points = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of polygon) {
      if (!Array.isArray(point) || point.length < 2 || !sceneNumber(point[0]) || !sceneNumber(point[1]) ||
          Math.abs(point[0]) > sceneWidth * 4 || Math.abs(point[1]) > sceneHeight * 4) return null;
      points.push(`${point[0]},${point[1]}`);
      minX = Math.min(minX, point[0]);
      minY = Math.min(minY, point[1]);
      maxX = Math.max(maxX, point[0]);
      maxY = Math.max(maxY, point[1]);
    }
    return { points: points.join(' '), bounds: { left: minX, top: minY, width: maxX - minX, height: maxY - minY } };
  }

  function normalizeScenePath(path) {
    return String(path ?? '').replace(/\\/g, '/').toLocaleLowerCase('en-US');
  }

  function resolveScenePath(scene, path) {
    const normalized = normalizeScenePath(path);
    if (!normalized) return { status: 'missing', entry: null };
    const matches = scene.resourceIndex.get(normalized) || [];
    if (!matches.length) return { status: 'missing', entry: null };
    if (matches.length > 1) return { status: 'ambiguous', entry: null };
    const entry = state.entryById.get(String(matches[0].id));
    return entry ? { status: 'found', entry } : { status: 'missing', entry: null };
  }

  function collectSceneReferenceIssues(scene, item) {
    const refs = [];
    if (item?.path) refs.push(item.path);
    if (Array.isArray(item?.links)) for (const link of item.links) if (link?.path) refs.push(link.path);
    for (const path of refs) {
      const resolved = resolveScenePath(scene, path);
      if (resolved.status === 'missing') addSceneIssue(scene, path, '引用资源不存在');
      else if (resolved.status === 'ambiguous') addSceneIssue(scene, path, '引用路径有重名，无法确定目标');
    }
  }

  function makeSceneHit(scene, item, category) {
    const hit = document.createElement('button');
    hit.type = 'button';
    hit.className = `map-scene-hit map-scene-hit-${category}`;
    hit.setAttribute('aria-label', String(item?.label || `地图${category}`));
    hit.title = String(item?.label || '');
    scene.listen(hit, 'click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.mapScene !== scene || performance.now() < scene.suppressClickUntil) return;
      showMapScenePopover(scene, item, hit);
    });
    return hit;
  }

  function makeMarkerBadge(kind) {
    const badge = document.createElement('span');
    badge.className = 'map-scene-marker-badge';
    badge.textContent = ({ transfer: '↗', npc: 'N', spawn: 'S', trigger: '!', unknown: '?' })[kind] || '?';
    badge.setAttribute('aria-hidden', 'true');
    return badge;
  }

  function buildSceneLayerMenu(scene) {
    scene.layerControls = {};
    addSceneLayerControl(scene, 'ground', '地面', true, true);
    addSceneLayerControl(scene, 'objects', '物件', scene.layers.objects.present, true, scene.layers.objects.present ? '' : '无');
    addSceneLayerControl(scene, 'collision', '碰撞', scene.layers.collision.present, false, scene.layers.collision.present ? '' : '无');
    for (const kind of ['transfer', 'npc', 'spawn', 'trigger', 'unknown']) {
      const layer = scene.layers.markers?.[kind];
      if (!layer?.present) continue;
      const names = { transfer: '传送', npc: 'NPC', spawn: '刷怪', trigger: '触发', unknown: '未知逻辑' };
      addSceneLayerControl(scene, kind, names[kind], true, false);
    }
    applySceneVisibility(scene);
  }

  function addSceneLayerControl(scene, key, labelText, available, defaultChecked, unavailableText = '') {
    const label = document.createElement('label');
    label.className = 'map-scene-layer-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!defaultChecked;
    input.disabled = !available;
    const name = document.createElement('span');
    name.textContent = labelText;
    label.append(input, name);
    if (unavailableText) {
      const stateText = document.createElement('small');
      stateText.textContent = unavailableText;
      label.append(stateText);
    }
    scene.layersMenu.append(label);
    scene.layerControls[key] = { input, label };
    scene.visible[key] = !!defaultChecked;
    scene.listen(input, 'change', () => {
      scene.visible[key] = input.checked;
      applySceneVisibility(scene);
    });
  }

  function applySceneVisibility(scene) {
    if (state.mapScene !== scene) return;
    const setVisible = (elementsToToggle, visible) => {
      for (const element of elementsToToggle || []) {
        const show = visible && element.dataset.failed !== 'true';
        element.hidden = !show;
        element.style.display = show ? '' : 'none';
      }
    };
    setVisible(scene.layers.ground?.elements, scene.visible.ground);
    setVisible(scene.layers.objects?.elements, scene.visible.objects);
    setVisible(scene.layers.collision?.elements, scene.visible.collision);
    for (const [kind, layer] of Object.entries(scene.layers.markers || {})) {
      setVisible(layer.elements, scene.visible[kind]);
    }
  }

  function bindSceneEvents(scene, layersButton, zoomOut, zoomIn, fitButton) {
    const { viewport, root, layersMenu } = scene;
    scene.listen(layersButton, 'click', () => {
      const open = layersMenu.classList.contains('hidden');
      layersMenu.classList.toggle('hidden', !open);
      layersButton.setAttribute('aria-expanded', String(open));
      scene.issuePanel.classList.add('hidden');
      scene.issueButton.setAttribute('aria-expanded', 'false');
    });
    scene.listen(zoomOut, 'click', () => zoomMapScene(scene, 1 / 1.2));
    scene.listen(zoomIn, 'click', () => zoomMapScene(scene, 1.2));
    scene.listen(fitButton, 'click', () => fitMapScene(scene));
    scene.listen(document, 'keydown', (event) => {
      if (event.key !== 'Escape' || state.mapScene !== scene) return;
      closeScenePopover(scene);
      layersMenu.classList.add('hidden');
      scene.issuePanel.classList.add('hidden');
      layersButton.setAttribute('aria-expanded', 'false');
      scene.issueButton.setAttribute('aria-expanded', 'false');
    });
    scene.listen(root, 'click', (event) => {
      if (!layersMenu.contains(event.target) && event.target !== layersButton) {
        layersMenu.classList.add('hidden');
        layersButton.setAttribute('aria-expanded', 'false');
      }
      if (!scene.issuePanel.contains(event.target) && event.target !== scene.issueButton) {
        scene.issuePanel.classList.add('hidden');
        scene.issueButton.setAttribute('aria-expanded', 'false');
      }
      if (!scene.popover.contains(event.target) && !event.target.closest('.map-scene-hit')) closeScenePopover(scene);
    });
    scene.listen(viewport, 'pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.map-scene-popover')) return;
      scene.dragging = true;
      scene.pointerId = event.pointerId;
      scene.hasPointerCapture = false;
      scene.pointerStart = { x: event.clientX, y: event.clientY, panX: scene.panX, panY: scene.panY, moved: false };
    });
    scene.listen(document, 'pointermove', (event) => {
      if (!scene.dragging || !scene.pointerStart || event.pointerId !== scene.pointerId) return;
      const dx = event.clientX - scene.pointerStart.x;
      const dy = event.clientY - scene.pointerStart.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) {
        scene.pointerStart.moved = true;
        viewport.classList.add('dragging');
        if (!scene.hasPointerCapture) {
          try {
            viewport.setPointerCapture(event.pointerId);
            scene.hasPointerCapture = true;
          } catch (_) { /* detached during navigation */ }
        }
      }
      if (!scene.pointerStart.moved) return;
      closeScenePopover(scene);
      scene.panX = scene.pointerStart.panX + dx;
      scene.panY = scene.pointerStart.panY + dy;
      scene.fitMode = false;
      updateSceneTransform(scene);
    });
    const finishPan = (event) => {
      if (!scene.dragging || event.pointerId !== scene.pointerId) return;
      if (scene.pointerStart?.moved) scene.suppressClickUntil = performance.now() + 300;
      scene.dragging = false;
      scene.pointerStart = null;
      scene.pointerId = undefined;
      viewport.classList.remove('dragging');
      try { if (scene.hasPointerCapture && viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId); } catch (_) { /* already released */ }
      scene.hasPointerCapture = false;
    };
    scene.listen(document, 'pointerup', finishPan);
    scene.listen(document, 'pointercancel', finishPan);
    scene.listen(viewport, 'wheel', (event) => {
      if (event.target.closest('.map-scene-popover, .map-scene-toolbar, .map-scene-layers, .map-scene-issues')) return;
      event.preventDefault();
      zoomMapScene(scene, Math.exp(-event.deltaY * 0.0015), event.clientX, event.clientY);
    }, { passive: false });
  }

  function updateSceneTransform(scene) {
    if (state.mapScene !== scene) return;
    scene.world.style.transform = `translate(${scene.panX}px, ${scene.panY}px) scale(${scene.scale})`;
    scene.zoomValue.textContent = `${Math.round(scene.scale * 100)}%`;
  }

  function fitMapScene(scene) {
    if (state.mapScene !== scene) return;
    const rect = scene.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    scene.scale = Math.max(0.02, Math.min(8, Math.min((rect.width - 36) / scene.width, (rect.height - 36) / scene.height)));
    scene.panX = (rect.width - scene.width * scene.scale) / 2;
    scene.panY = (rect.height - scene.height * scene.scale) / 2;
    scene.fitMode = true;
    closeScenePopover(scene);
    updateSceneTransform(scene);
  }

  function zoomMapScene(scene, factor, clientX, clientY) {
    if (state.mapScene !== scene) return;
    const rect = scene.viewport.getBoundingClientRect();
    const x = clientX === undefined ? rect.width / 2 : clientX - rect.left;
    const y = clientY === undefined ? rect.height / 2 : clientY - rect.top;
    const scale = Math.max(0.02, Math.min(8, scene.scale * factor));
    const worldX = (x - scene.panX) / scene.scale;
    const worldY = (y - scene.panY) / scene.scale;
    scene.scale = scale;
    scene.panX = x - worldX * scale;
    scene.panY = y - worldY * scale;
    scene.fitMode = false;
    closeScenePopover(scene);
    updateSceneTransform(scene);
  }

  function sceneDetailsText(details) {
    if (typeof details === 'string') return details;
    if (details === null || details === undefined) return '';
    try { return JSON.stringify(details, null, 2); } catch (_) { return String(details); }
  }

  function closeScenePopover(scene) {
    if (scene?.popover) {
      scene.popover.classList.add('hidden');
      scene.popover.replaceChildren();
    }
  }

  function showMapScenePopover(scene, item, anchor) {
    if (state.mapScene !== scene) return;
    closeScenePopover(scene);
    scene.layersMenu.classList.add('hidden');
    scene.issuePanel.classList.add('hidden');
    const title = document.createElement('strong');
    title.className = 'map-scene-popover-title';
    title.textContent = String(item?.label || item?.id || '地图对象');
    scene.popover.append(title);
    const details = sceneDetailsText(item?.details);
    if (details) {
      const pre = document.createElement('pre');
      pre.className = 'map-scene-details';
      pre.textContent = details;
      scene.popover.append(pre);
    }

    const references = [];
    if (item?.path) references.push({ label: '打开资源', path: item.path });
    if (Array.isArray(item?.links)) {
      for (const link of item.links) {
        if (link?.path) references.push({ label: String(link.label || '跳转'), path: String(link.path) });
      }
    }
    if (references.length) {
      const section = document.createElement('div');
      section.className = 'map-scene-resources';
      for (const reference of references) {
        const resolution = resolveScenePath(scene, reference.path);
        const row = document.createElement('div');
        row.className = 'map-scene-resource-row';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'map-scene-resource-link';
        const suffix = resolution.status === 'found' ? '' : resolution.status === 'ambiguous' ? ' · 重名' : ' · 缺失';
        button.textContent = `${reference.label}${suffix}`;
        button.title = reference.path;
        button.disabled = resolution.status !== 'found';
        if (resolution.status === 'found') {
          scene.listen(button, 'click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const target = state.entryById.get(String(resolution.entry.id));
            closeScenePopover(scene);
            if (target && state.mapScene === scene) openEntry(target, true);
          });
        }
        const path = document.createElement('span');
        path.className = 'map-scene-resource-path';
        path.textContent = reference.path;
        row.append(button, path);
        section.append(row);
      }
      scene.popover.append(section);
    }
    scene.popover.classList.remove('hidden');
    const viewportRect = scene.viewport.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const width = scene.popover.offsetWidth;
    const height = scene.popover.offsetHeight;
    let left = anchorRect.left - viewportRect.left;
    let top = anchorRect.bottom - viewportRect.top + 6;
    if (left + width > viewportRect.width - 8) left = viewportRect.width - width - 8;
    if (top + height > viewportRect.height - 8) top = anchorRect.top - viewportRect.top - height - 6;
    scene.popover.style.left = `${Math.max(8, left)}px`;
    scene.popover.style.top = `${Math.max(8, top)}px`;
  }

  function validPositiveInteger(value, maximum) {
    return Number.isSafeInteger(value) && value > 0 && value <= maximum;
  }

  function validateAnimationFrame(result, expectedIndex, animation = null) {
    const directions = result?.directions;
    const framesPerDirection = result?.framesPerDirection;
    const width = result?.width;
    const height = result?.height;
    if (result?.kind !== 'animation' || result?.mime !== 'image/png' ||
        !validPositiveInteger(directions, 4096) || !validPositiveInteger(framesPerDirection, 4096) ||
        directions * framesPerDirection > 4096) throw new Error('动画方向或帧数元数据无效');
    if (!validPositiveInteger(width, 8192) || !validPositiveInteger(height, 8192) ||
        width * height > 16777216) throw new Error('动画画布尺寸超过预览限制');
    if (!Number.isSafeInteger(result.frameIndex) || result.frameIndex !== expectedIndex ||
        expectedIndex < 0 || expectedIndex >= directions * framesPerDirection) throw new Error('动画帧响应与当前请求不匹配');
    if (typeof result.base64 !== 'string' || !result.base64.length || result.base64.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(result.base64)) throw new Error('动画帧图像数据无效');
    if (animation && (animation.id !== String(state.current?.id) ||
        animation.directions !== directions || animation.framesPerDirection !== framesPerDirection ||
        animation.width !== width || animation.height !== height)) throw new Error('动画帧元数据在同一资源内不一致');
  }

  function renderAnimationPreview(result) {
    elements.previewStage.classList.remove('solid');
    try {
      validateAnimationFrame(result, 0);
    } catch (error) {
      showPreviewError(error?.message || String(error));
      return;
    }
    const id = String(state.current?.id);
    if (!state.animation || state.animation.id !== id) {
      stopAnimation();
      const animation = {
        id, token: ++state.animationSequence, directions: result.directions,
        framesPerDirection: result.framesPerDirection, width: result.width, height: result.height,
        targetIndex: result.frameIndex, displayedIndex: result.frameIndex, pendingIndex: null,
        timer: null, active: true, error: '', canvas: null, frameLabel: null,
        directionSelect: null, frameSlider: null, playButton: null, fpsInput: null,
        previousButton: null, nextButton: null, retryButton: null, errorLabel: null, infoLabel: null,
      };
      state.animation = animation;
      state.previewMode = 'animation';
      createAnimationControls(animation);
    }
    const animation = state.animation;
    try {
      validateAnimationFrame(result, result.frameIndex, animation);
      drawAnimationFrame(animation, result, ++state.animationSequence);
      animation.targetIndex = result.frameIndex;
      animation.displayedIndex = result.frameIndex;
      animation.infoLabel.textContent = String(result.info || '');
      animation.error = '';
      animation.errorLabel.classList.add('hidden');
      animation.retryButton.classList.add('hidden');
      elements.formatInfo.textContent = '动画';
      updateAnimationSelection(animation, result.frameIndex);
      syncPreviewControls();
      if (currentDraft()?.available === false) elements.previewArea.classList.remove('hidden');
    } catch (error) {
      showPreviewError(error?.message || String(error));
    }
  }

  function createAnimationControls(animation) {
    elements.previewStage.replaceChildren();
    const canvas = document.createElement('canvas');
    canvas.className = 'animation-canvas';
    canvas.width = animation.width;
    canvas.height = animation.height;
    canvas.setAttribute('aria-label', '动画帧预览');
    elements.previewStage.append(canvas);
    animation.canvas = canvas;

    const controls = document.createElement('div');
    controls.className = 'animation-controls';
    const direction = document.createElement('select');
    direction.setAttribute('aria-label', '动画方向');
    for (let i = 0; i < animation.directions; i += 1) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `方向 ${i + 1}`;
      direction.append(option);
    }
    animation.directionSelect = direction;
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.textContent = '上一帧';
    previous.setAttribute('aria-label', '上一帧');
    animation.previousButton = previous;
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(animation.framesPerDirection - 1);
    slider.step = '1';
    slider.setAttribute('aria-label', '动画帧');
    animation.frameSlider = slider;
    const frameLabel = document.createElement('output');
    animation.frameLabel = frameLabel;
    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = '下一帧';
    next.setAttribute('aria-label', '下一帧');
    animation.nextButton = next;
    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = '播放';
    play.setAttribute('aria-pressed', 'false');
    animation.playButton = play;
    const fpsLabel = document.createElement('label');
    fpsLabel.className = 'animation-fps-label';
    fpsLabel.textContent = 'FPS';
    const fps = document.createElement('input');
    fps.type = 'number';
    fps.min = '1';
    fps.max = '30';
    fps.step = '1';
    fps.value = '8';
    fps.setAttribute('aria-label', '播放帧率');
    animation.fpsInput = fps;
    fpsLabel.append(fps);
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.classList.add('hidden');
    animation.retryButton = retry;
    const info = document.createElement('span');
    info.className = 'animation-info';
    animation.infoLabel = info;
    const error = document.createElement('span');
    error.className = 'animation-error hidden';
    animation.errorLabel = error;
    controls.append(direction, previous, slider, frameLabel, next, play, fpsLabel, retry);
    const panel = document.createElement('div');
    panel.className = 'animation-controls-wrap';
    panel.append(controls, info, error);
    elements.previewControls.replaceChildren(panel);
    elements.previewControls.classList.remove('hidden');

    direction.addEventListener('change', () => {
      const local = animation.targetIndex % animation.framesPerDirection;
      requestAnimationFrameIndex(animation, Number(direction.value) * animation.framesPerDirection + local);
    });
    slider.addEventListener('input', () => {
      requestAnimationFrameIndex(animation, Number(direction.value) * animation.framesPerDirection + Number(slider.value));
    });
    previous.addEventListener('click', () => stepAnimation(animation, -1));
    next.addEventListener('click', () => stepAnimation(animation, 1));
    play.addEventListener('click', () => animation.timer === null ? startAnimation(animation) : stopAnimationPlayback(animation));
    fps.addEventListener('change', () => {
      const value = Math.max(1, Math.min(30, Number(fps.value) || 8));
      fps.value = String(value);
      if (animation.timer !== null) startAnimation(animation);
    });
    retry.addEventListener('click', () => {
      animation.error = '';
      animation.errorLabel.classList.add('hidden');
      retry.classList.add('hidden');
      requestAnimationFrameIndex(animation, animation.targetIndex);
    });
  }

  function drawAnimationFrame(animation, result, sequence) {
    const image = new Image();
    image.onload = () => {
      if (state.animation !== animation || animation.renderSequence !== sequence ||
          state.current?.id === undefined || String(state.current.id) !== animation.id ||
          !state.previewVisible || state.taskBusy) return;
      const context = animation.canvas.getContext('2d');
      context.clearRect(0, 0, animation.width, animation.height);
      context.drawImage(image, 0, 0, animation.width, animation.height);
    };
    image.onerror = () => {
      if (state.animation !== animation || animation.renderSequence !== sequence) return;
      failAnimation(animation, '动画帧 PNG 解码失败');
    };
    animation.renderSequence = sequence;
    image.src = `data:image/png;base64,${result.base64}`;
  }

  function updateAnimationSelection(animation, index) {
    const local = index % animation.framesPerDirection;
    animation.directionSelect.value = String(Math.floor(index / animation.framesPerDirection));
    animation.frameSlider.value = String(local);
    animation.frameLabel.textContent = `${local + 1} / ${animation.framesPerDirection}`;
  }

  function stepAnimation(animation, delta) {
    const direction = Number(animation.directionSelect.value);
    const local = (animation.targetIndex % animation.framesPerDirection + delta + animation.framesPerDirection) % animation.framesPerDirection;
    requestAnimationFrameIndex(animation, direction * animation.framesPerDirection + local);
  }

  function requestAnimationFrameIndex(animation, index) {
    if (state.animation !== animation || state.taskBusy || !state.previewVisible) return;
    animation.active = true;
    if (!animation.token || animation.invalidated) {
      animation.token = ++state.animationSequence;
      animation.invalidated = false;
    }
    if (!Number.isSafeInteger(index) || index < 0 || index >= animation.directions * animation.framesPerDirection) return;
    animation.targetIndex = index;
    animation.pendingIndex = index;
    animation.renderSequence = ++state.animationSequence;
    animation.error = '';
    animation.errorLabel.classList.add('hidden');
    animation.retryButton.classList.add('hidden');
    updateAnimationSelection(animation, index);
    syncPreviewControls();
    pumpAnimationFrames();
  }

  function pumpAnimationFrames() {
    const animation = state.animation;
    if (!animation || !animation.active || state.taskBusy || !state.previewVisible ||
        state.frameInFlight || animation.pendingIndex === null) return;
    const frameIndex = animation.pendingIndex;
    animation.pendingIndex = null;
    const flight = { sequence: ++state.animationSequence, token: animation.token, id: animation.id, frameIndex, animation };
    state.frameInFlight = flight;
    api.previewFrame(animation.id, frameIndex).then((result) => {
      if (state.frameInFlight !== flight) return;
      state.frameInFlight = null;
      const current = state.animation === animation && animation.active && animation.token === flight.token &&
        state.current && String(state.current.id) === flight.id && state.previewVisible && !state.taskBusy;
      if (current && animation.pendingIndex === null) {
        try {
          validateAnimationFrame(result, frameIndex, animation);
          animation.displayedIndex = frameIndex;
          animation.infoLabel.textContent = String(result.info || '');
          drawAnimationFrame(animation, result, flight.sequence);
          syncPreviewControls();
        } catch (error) {
          failAnimation(animation, error?.message || String(error));
        }
      }
      pumpAnimationFrames();
    }).catch((error) => {
      if (state.frameInFlight !== flight) return;
      state.frameInFlight = null;
      const current = state.animation === animation && animation.active && animation.token === flight.token &&
        state.current && String(state.current.id) === flight.id && state.previewVisible && !state.taskBusy;
      if (current && animation.pendingIndex === null) failAnimation(animation, error?.message || String(error));
      pumpAnimationFrames();
    });
  }

  function failAnimation(animation, message) {
    stopAnimationPlayback(animation);
    animation.error = message;
    animation.errorLabel.textContent = message;
    animation.errorLabel.classList.remove('hidden');
    animation.retryButton.classList.remove('hidden');
    syncPreviewControls();
  }

  function startAnimation(animation) {
    stopAnimationPlayback(animation);
    if (animation.framesPerDirection <= 1 || state.taskBusy || !state.previewVisible) return;
    animation.active = true;
    if (!animation.token || animation.invalidated) {
      animation.token = ++state.animationSequence;
      animation.invalidated = false;
    }
    animation.playButton.textContent = '暂停';
    animation.playButton.setAttribute('aria-pressed', 'true');
    const fps = Math.max(1, Math.min(30, Number(animation.fpsInput.value) || 8));
    animation.timer = setInterval(() => {
      if (state.frameInFlight || animation.pendingIndex !== null) return;
      stepAnimation(animation, 1);
    }, Math.max(34, 1000 / fps));
    syncPreviewControls();
  }

  function stopAnimationPlayback(animation) {
    if (animation.timer !== null) clearInterval(animation.timer);
    animation.timer = null;
    if (animation.playButton) {
      animation.playButton.textContent = '播放';
      animation.playButton.setAttribute('aria-pressed', 'false');
    }
    syncPreviewControls();
  }

  function stopAnimation() {
    const animation = state.animation;
    if (!animation) return;
    stopAnimationPlayback(animation);
    animation.active = false;
    animation.pendingIndex = null;
    animation.invalidated = true;
    animation.token = ++state.animationSequence;
    animation.renderSequence = ++state.animationSequence;
    syncPreviewControls();
  }

  function syncPreviewControls() {
    const animation = state.animation;
    if (animation) {
      const singleDirection = animation.directions <= 1;
      const singleFrame = animation.framesPerDirection <= 1;
      const disabled = state.taskBusy || !state.previewVisible;
      animation.directionSelect.disabled = disabled || singleDirection;
      animation.frameSlider.disabled = disabled || singleFrame;
      animation.previousButton.disabled = disabled || singleFrame;
      animation.nextButton.disabled = disabled || singleFrame;
      animation.playButton.disabled = disabled || singleFrame;
      animation.fpsInput.disabled = disabled || singleFrame;
      animation.retryButton.disabled = disabled;
      return;
    }
    const page = state.mapPage;
    if (page) {
      const disabled = state.taskBusy || page.pending;
      if (page.rowControls) {
        page.rowControls.previous.disabled = disabled || page.page <= 0;
        page.rowControls.next.disabled = disabled || page.page >= page.pageCount - 1;
        page.rowControls.label.textContent = `/ ${page.pageCount}`;
        page.rowControls.input.value = String(page.page + 1);
        page.rowControls.input.disabled = disabled;
      }
      if (page.columnControls) {
        page.columnControls.previous.disabled = disabled || page.columnPage <= 0;
        page.columnControls.next.disabled = disabled || page.columnPage >= page.columnPageCount - 1;
        page.columnControls.label.textContent = `/ ${page.columnPageCount}`;
        page.columnControls.input.value = String(page.columnPage + 1);
        page.columnControls.input.disabled = disabled;
      }
    }
  }

  function setupMapPage(result) {
    const count = Number.isSafeInteger(result?.pageCount) ? result.pageCount : 1;
    const currentPage = Number.isSafeInteger(result?.page) ? result.page : 0;
    let columnPage = 0;
    let columnPageCount = 1;
    if (result?.kind === 'table') {
      columnPage = result.columnPage;
      columnPageCount = result.columnPageCount;
    }
    const maxPages = result?.kind === 'table' ? 67108864 : result?.kind === 'resource-records' ? 1342178 : 16384;
    if (!Number.isSafeInteger(count) || count < 1 || count > maxPages ||
        !Number.isSafeInteger(currentPage) || currentPage < 0 || currentPage >= count ||
        !Number.isSafeInteger(columnPage) || columnPage < 0 || !Number.isSafeInteger(columnPageCount) ||
        columnPageCount < 1 || columnPage >= columnPageCount) {
      showPreviewError('预览分页元数据无效');
      return;
    }
    if (count === 1 && columnPageCount === 1) {
      state.mapPage = null;
      state.previewMode = '';
      elements.previewControls.replaceChildren();
      elements.previewControls.classList.add('hidden');
      return;
    }
    const id = String(state.current?.id);
    state.previewMode = `page:${result.kind}`;
    state.mapPage = {
      id, kind: result.kind, page: currentPage, pageCount: count,
      columnPage, columnPageCount, pending: false, token: state.previewRequest,
    };
    createMapPageControls(state.mapPage);
  }

  function createMapPageControls(page) {
    const controls = document.createElement('div');
    controls.className = 'map-page-controls';
    if (page.pageCount > 1) page.rowControls = createPageGroup(page, 'rows');
    if (page.columnPageCount > 1) page.columnControls = createPageGroup(page, 'columns');
    if (page.rowControls) controls.append(page.rowControls.group);
    if (page.columnControls) controls.append(page.columnControls.group);
    elements.previewControls.replaceChildren(controls);
    elements.previewControls.classList.remove('hidden');
    syncPreviewControls();
  }

  function createPageGroup(page, dimension) {
    const isColumns = dimension === 'columns';
    const group = document.createElement('div');
    group.className = `map-page-group${isColumns ? ' column-page-group' : ''}`;
    const labelText = document.createElement('span');
    labelText.className = 'page-dimension';
    labelText.textContent = isColumns ? '字段' : '行';
    const previous = document.createElement('button');
    previous.type = 'button';
    previous.textContent = '‹';
    previous.setAttribute('aria-label', isColumns ? '上一组字段' : '上一页');
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.max = String(isColumns ? page.columnPageCount : page.pageCount);
    input.setAttribute('aria-label', isColumns ? '字段页码' : '预览页码');
    input.title = '输入页码后按 Enter 跳转';
    const total = document.createElement('span');
    const next = document.createElement('button');
    next.type = 'button';
    next.textContent = '›';
    next.setAttribute('aria-label', isColumns ? '下一组字段' : '下一页');
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      const target = Number(input.value) - 1;
      const limit = isColumns ? page.columnPageCount : page.pageCount;
      if (Number.isSafeInteger(target) && target >= 0 && target < limit) {
        if (isColumns) requestMapColumnPage(page, target);
        else requestMapPage(page, target);
      } else syncPreviewControls();
    });
    previous.addEventListener('click', () => {
      if (isColumns) requestMapColumnPage(page, page.columnPage - 1);
      else requestMapPage(page, page.page - 1);
    });
    next.addEventListener('click', () => {
      if (isColumns) requestMapColumnPage(page, page.columnPage + 1);
      else requestMapPage(page, page.page + 1);
    });
    group.append(labelText, previous, input, total, next);
    return { group, previous, next, input, label: total };
  }

  function updateMapPage(result) {
    const page = state.mapPage;
    if (!page || page.id !== String(state.current?.id)) {
      setupMapPage(result);
      return;
    }
    if (!Number.isSafeInteger(result.page) || result.page < 0 || result.page >= page.pageCount ||
        result.pageCount !== page.pageCount ||
        (page.kind === 'table' && (result.columnPageCount !== page.columnPageCount ||
          result.columnPage < 0 || result.columnPage >= page.columnPageCount))) {
      showPreviewError('预览分页响应元数据无效');
      return;
    }
    page.page = result.page;
    if (page.kind === 'table') page.columnPage = result.columnPage;
    page.pending = false;
    page.token = state.previewRequest;
    syncPreviewControls();
  }

  function requestMapPage(page, target) {
    requestPreviewPage(page, target, page.columnPage);
  }

  function requestMapColumnPage(page, target) {
    requestPreviewPage(page, page.page, target);
  }

  function requestPreviewPage(page, target, targetColumnPage) {
    if (state.taskBusy || page.pending || target < 0 || target >= page.pageCount ||
        targetColumnPage < 0 || targetColumnPage >= page.columnPageCount ||
        state.mapPage !== page || page.id !== String(state.current?.id)) return;
    page.pending = true;
    syncPreviewControls();
    const request = state.previewRequest;
    const options = { page: target };
    if (page.kind === 'table') options.columnPage = targetColumnPage;
    const tab = getTab(page.id);
    if (tab?.effectView === 'structure' && /\.eff$/i.test(String(tab.entry?.name || ''))) options.view = 'structure';
    api.previewEntry(page.id, options).then((result) => {
      if (request !== state.previewRequest || state.mapPage !== page || page.id !== String(state.current?.id)) return;
      if (result?.kind !== page.kind || result?.page !== target || result?.pageCount !== page.pageCount ||
          (page.kind === 'table' && (result.columnPage !== targetColumnPage || result.columnPageCount !== page.columnPageCount))) {
        throw new Error('预览分页响应与当前请求不匹配');
      }
      if (page.kind === 'table') validateTablePreview(result);
      page.pending = false;
      renderPreview(result);
      renderMetadata(state.current, result);
    }).catch((error) => {
      if (request !== state.previewRequest || state.mapPage !== page) return;
      page.pending = false;
      showPreviewError(error?.message || String(error));
      syncPreviewControls();
    });
  }

  function showPreviewError(message) {
    destroyMapScene();
    destroyEffectScene();
    elements.previewArea.classList.remove('hidden');
    elements.previewStage.classList.add('solid');
    elements.previewStage.classList.remove('table-preview');
    elements.previewStage.classList.remove('map-scene-preview');
    elements.previewStage.classList.remove('resource-records-preview');
    elements.previewStage.classList.remove('effect-scene-preview');
    elements.tableViewTabs.classList.add('hidden');
    elements.previewStage.replaceChildren();
    const box = document.createElement('div');
    box.className = 'preview-error';
    box.textContent = message;
    elements.previewStage.append(box);
  }

  function addMeta(label, value, title = '') {
    const item = document.createElement('div');
    item.className = 'meta-item';
    const labelNode = document.createElement('span');
    labelNode.className = 'meta-label';
    labelNode.textContent = label;
    const valueNode = document.createElement('span');
    valueNode.className = 'meta-value';
    valueNode.textContent = value;
    if (title) valueNode.title = title;
    item.append(labelNode, valueNode);
    elements.metadataGrid.append(item);
  }

  function renderMetadata(entry, data) {
    elements.metadataGrid.replaceChildren();
    const draft = state.textDrafts.get(String(entry.id));
    elements.infoFormat.textContent = data?.kind ? String(data.kind).toUpperCase() : (draft?.available ? 'UTF-8 文本' : '工程资源');
    addMeta('文件名', entry.name, entry.name);
    addMeta('原始大小', formatBytes(entry.size));
    addMeta('压缩大小', formatBytes(entry.packedSize));
    if (entry.codec) addMeta('压缩方式', entry.codec);
    if (data && Number.isFinite(Number(data.width)) && Number.isFinite(Number(data.height)) && data.width && data.height) addMeta('预览尺寸', `${data.width} × ${data.height}`);
    if (data?.info) renderPreviewInfo(data.info);
  }

  function renderPreviewInfo(info) {
    const section = document.createElement('div');
    section.className = 'meta-item preview-info';
    const label = document.createElement('span');
    label.className = 'meta-label';
    label.textContent = '预览说明';
    section.append(label);
    if (typeof info === 'string') {
      const copy = document.createElement('div');
      copy.className = 'preview-info-copy';
      copy.textContent = info;
      section.append(copy);
    } else if (info && typeof info === 'object') {
      const { note, legend, ...remaining } = info;
      const copy = document.createElement('div');
      copy.className = 'preview-info-copy';
      for (const value of [note, legend]) {
        if (typeof value !== 'string' || !value.trim()) continue;
        const paragraph = document.createElement('p');
        paragraph.textContent = value;
        copy.append(paragraph);
      }
      if (Object.keys(remaining).length) {
        const details = document.createElement('details');
        details.className = 'preview-info-details';
        const summary = document.createElement('summary');
        summary.textContent = '更多预览数据';
        const values = document.createElement('pre');
        values.textContent = JSON.stringify(remaining, null, 2);
        details.append(summary, values);
        copy.append(details);
      }
      if (!copy.childNodes.length) copy.textContent = JSON.stringify(info, null, 2);
      section.append(copy);
    } else {
      const copy = document.createElement('div');
      copy.className = 'preview-info-copy';
      copy.textContent = String(info);
      section.append(copy);
    }
    elements.metadataGrid.append(section);
  }

  function showResourceInfo(entry = state.current) {
    if (!entry) return;
    elements.infoTitle.textContent = entry.name;
    renderMetadata(entry, state.current && String(state.current.id) === String(entry.id) ? state.previewData : null);
    elements.infoDialog.classList.remove('hidden');
    elements.closeInfoButton.focus();
  }

  function closeResourceInfo() {
    elements.infoDialog.classList.add('hidden');
    if (state.current) elements.textEditor.focus({ preventScroll: true });
  }

  async function changeTableSchema(action) {
    if (state.taskBusy || !state.opened || !state.projectMode) return;
    const entry = state.current;
    const wasShowingPreview = !!entry && !elements.previewArea.classList.contains('hidden');
    const importSchema = action === 'import';
    const result = await runTask(importSchema ? '正在导入表结构…' : '正在清除表结构…', () =>
      importSchema ? api.importTableSchema() : api.clearTableSchema());
    if (!result || result.canceled) return;
    if (entry && wasShowingPreview && state.current && String(state.current.id) === String(entry.id)) {
      loadProjectPreview(entry);
    }
    const source = typeof result.source === 'string' && result.source.trim() ? `（${result.source}）` : '';
    notify(importSchema ? `表结构已导入${source}` : '表结构已清除');
  }

  function openQuickOpen() {
    if (state.taskBusy || !state.opened) return;
    state.quickMode = 'open';
    state.quickIndex = 0;
    elements.quickOpenInput.value = '';
    elements.quickOpen.classList.remove('hidden');
    updateQuickOpen();
    elements.quickOpenInput.focus();
  }

  function closeQuickOpen() {
    elements.quickOpen.classList.add('hidden');
    if (state.current) elements.textEditor.focus({ preventScroll: true });
    else elements.entryList.focus({ preventScroll: true });
  }

  function updateQuickOpen() {
    const query = elements.quickOpenInput.value.trim().toLocaleLowerCase();
    state.quickItems = state.entries.map((entry) => ({ entry, path: String(entry.name || '') }))
      .map((item) => ({ ...item, score: query ? item.path.toLocaleLowerCase().indexOf(query) : 0 }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => (a.score - b.score) || a.path.localeCompare(b.path, 'zh-CN', { numeric: true, sensitivity: 'base' }))
      .slice(0, 100);
    state.quickIndex = Math.min(state.quickIndex, Math.max(0, state.quickItems.length - 1));
    elements.quickOpenResults.replaceChildren();
    if (!state.quickItems.length) {
      const empty = document.createElement('div');
      empty.className = 'quick-open-empty';
      empty.textContent = '没有匹配的文件';
      elements.quickOpenResults.append(empty);
      return;
    }
    state.quickItems.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `quick-open-row${index === state.quickIndex ? ' active' : ''}`;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === state.quickIndex));
      const name = document.createElement('span');
      name.textContent = item.path.split(/[\\/]/).pop();
      const path = document.createElement('span');
      path.textContent = item.path;
      row.append(name, path);
      row.addEventListener('click', () => {
        closeQuickOpen();
        openEntry(item.entry, false);
      });
      row.addEventListener('dblclick', () => {
        closeQuickOpen();
        openEntry(item.entry, true);
      });
      elements.quickOpenResults.append(row);
    });
  }

  function handleQuickOpenKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeQuickOpen();
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      state.quickIndex = Math.max(0, Math.min(state.quickItems.length - 1, state.quickIndex + delta));
      updateQuickOpen();
      elements.quickOpenResults.querySelector('.quick-open-row.active')?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = state.quickItems[state.quickIndex];
      if (item) {
        closeQuickOpen();
        openEntry(item.entry, false);
      }
    }
  }

  function toggleSidebar() {
    state.sidebarVisible = !state.sidebarVisible;
    elements.sidebar.classList.toggle('collapsed', !state.sidebarVisible);
    elements.sidebarResizer.classList.toggle('hidden', !state.sidebarVisible);
    elements.sidebar.style.width = `${state.sidebarWidth}px`;
  }

  function applySession(session, resetTextDrafts = false, preserveView = false) {
    destroyMapScene();
    destroyEffectScene();
    const preserved = preserveView ? {
      expandedFolders: new Set(state.expandedFolders),
      searchCollapsed: new Set(state.searchCollapsed),
      focusedKey: state.focusedKey,
      scrollTop: elements.entryList.scrollTop,
      activeTabId: state.activeTabId,
    } : null;
    stopAnimation();
    state.animation = null;
    state.mapPage = null;
    state.previewMode = '';
    state.previewRequest += 1;
    state.textRequest += 1;
    if (resetTextDrafts) {
      stopAnimation();
      state.animation = null;
      state.mapPage = null;
      state.previewMode = '';
      state.textRequest += 1;
      state.previewRequest += 1;
      state.textDrafts.clear();
      state.tabs = [];
      state.activeTabId = null;
    }
    state.opened = !!session?.opened;
    state.projectMode = !!session?.projectMode;
    state.projectName = session?.projectName || '';
    state.projectPath = session?.projectPath || '';
    if (!state.opened) {
      state.entries = [];
      state.entryById.clear();
      state.treeRoot = null;
      state.visibleNodes = [];
      state.matchingEntries = [];
      state.current = null;
      state.staged.clear();
      state.tabs = [];
      state.activeTabId = null;
      state.projectMode = false;
      state.projectName = '';
      state.projectPath = '';
      renderTree();
      renderStagedSummary();
      renderTabs();
      elements.textEditor.value = '';
      elements.textEditor.disabled = true;
      elements.editorWrap.classList.add('hidden');
      elements.previewArea.classList.add('hidden');
      elements.tableViewTabs.classList.add('hidden');
      elements.previewStage.classList.remove('table-preview');
      elements.previewStage.classList.remove('map-scene-preview');
      elements.previewStage.classList.remove('resource-records-preview');
      elements.previewStage.classList.remove('effect-scene-preview');
      elements.welcomeState.classList.remove('hidden');
      elements.editorNotice.textContent = '选择文件以读取完整文本内容';
      elements.editorNotice.classList.remove('hidden');
      syncDirty();
      return;
    }
    state.archiveName = session.projectName || session.pathName || 'PKG 工程';
    state.entryCount = Number(session.entryCount) || 0;
    state.entries = Array.isArray(session.entries) ? session.entries : [];
    state.current = null;
    elements.editorWrap.classList.add('hidden');
    elements.previewArea.classList.add('hidden');
    elements.tableViewTabs.classList.add('hidden');
    elements.previewStage.classList.remove('table-preview');
    elements.previewStage.classList.remove('map-scene-preview');
    elements.previewStage.classList.remove('resource-records-preview');
    elements.previewStage.classList.remove('effect-scene-preview');
    elements.textEditor.value = '';
    elements.textEditor.disabled = true;
    elements.editorNotice.textContent = '正在读取工程文件…';
    elements.editorNotice.classList.remove('hidden');
    state.staged = new Map((Array.isArray(session.staged) ? session.staged : []).map((item) => [String(item.id), item]));
    state.searchCollapsed = preserved ? preserved.searchCollapsed : new Set();
    state.focusedKey = preserved?.focusedKey || '';
    elements.archiveName.textContent = state.archiveName;
    elements.archiveName.title = state.projectPath || state.archiveName;
    elements.explorerProject.textContent = state.archiveName;
    elements.explorerProject.title = state.projectPath || state.archiveName;
    elements.stagedSummary.title = state.projectPath;
    buildTree(state.entries);
    if (preserved) {
      state.expandedFolders = preserved.expandedFolders;
      state.searchCollapsed = preserved.searchCollapsed;
      state.focusedKey = preserved.focusedKey;
      for (const tab of state.tabs) tab.entry = state.entryById.get(String(tab.id)) || tab.entry;
    }
    renderTree();
    if (preserved) elements.entryList.scrollTop = preserved.scrollTop;
    renderStagedSummary();
    syncDirty();

    renderTabs();
    const desiredId = preserved ? preserved.activeTabId : session.currentId;
    if (desiredId !== null && desiredId !== undefined) {
      const entry = state.entryById.get(String(desiredId));
      const fileNode = state.treeRoot && findFileNode(state.treeRoot, desiredId);
      if (entry && fileNode) {
        if (!preserved) {
          let folder = fileNode.parent;
          while (folder && folder !== state.treeRoot) {
            state.expandedFolders.add(folder.path);
            folder = folder.parent;
          }
          state.focusedKey = fileNode.key;
        }
        renderTree();
        if (getTab(desiredId)) activateTab(desiredId, true);
        else openEntry(entry, true, true);
      }
    }
    elements.welcomeState.classList.toggle('hidden', !!state.activeTabId);
    elements.editorHeading.classList.toggle('hidden', !state.activeTabId);
    updateControls();
    setStatus('工程已打开');
  }

  function findFileNode(folder, id) {
    for (const child of folder.children.values()) {
      if (child.type === 'file' && String(child.id) === String(id)) return child;
      if (child.type === 'folder') {
        const match = findFileNode(child, id);
        if (match) return match;
      }
    }
    return null;
  }

  async function openArchive() {
    if (state.taskBusy) return;
    if (hasUnsavedChanges() && !window.confirm('切换工程会丢弃尚未保存的文本草稿。是否继续？')) return;
    const result = await runTask('正在从 PKG 创建工程…', () => api.openArchive());
    if (!result || result.canceled) return;
    applySession(result, true);
    notify(`工程「${result.projectName || result.pathName || '新工程'}」已创建`);
  }

  async function openProject() {
    if (state.taskBusy) return;
    if (hasUnsavedChanges() && !window.confirm('切换工程会丢弃尚未保存的文本草稿。是否继续？')) return;
    const result = await runTask('正在打开工程…', () => api.openProject());
    if (!result || result.canceled) return;
    applySession(result, true);
    notify(`工程「${result.projectName || result.pathName || '工程'}」已打开`);
  }

  async function refreshProject(quiet = false) {
    if (state.taskBusy || !state.opened || !state.projectMode) return false;
    const currentId = state.current?.id;
    const result = await runTask('正在检查工程文件…', async () => {
      const session = await api.refreshProject();
      for (const [id, draft] of state.textDrafts) {
        if (!draft.available || draft.text === draft.stagedText) continue;
        try {
          const disk = await api.getText(draft.entryId ?? id);
          draft.conflict = !disk?.sha256 || !draft.sha256 || disk.sha256 !== draft.sha256;
        } catch (_) {
          draft.conflict = true;
        }
      }
      return session;
    });
    if (!result) return false;
    for (const [id, draft] of state.textDrafts) {
      if (!draft.available || draft.text === draft.stagedText) state.textDrafts.delete(id);
    }
    if (currentId !== null && currentId !== undefined) result.currentId = currentId;
    applySession(result, false, true);
    const conflictCount = [...state.textDrafts.values()].filter((draft) => draft.conflict).length;
    if (conflictCount) notify(`${conflictCount} 个未保存草稿对应的工程文件已外部修改，请检查后重新载入`, true);
    else if (!quiet) notify('工程文件已刷新；未保存草稿已保留');
    return true;
  }

  function hasUnsavedChanges() {
    return [...state.textDrafts.values()].some((draft) => draft.available && draft.text !== draft.stagedText);
  }

  async function stageSelectedFile(id = state.current?.id) {
    if (id === undefined || id === null) return;
    if (!confirmReplacementOverwrite(id)) return;
    const result = await runTask('正在写入工程文件…', () => api.replaceFile(id));
    if (!result || result.canceled) return;
    if (!applyStaged(result)) {
      notify(`工程文件操作未完整完成：${result.error || result.snapshotError || '无法确认工程差异'}`, true);
      return;
    }
    discardTextDraft(id);
    notify('工程文件已更新');
  }

  async function stageDirectory(folderPath = '') {
    if (!confirmDraftsMayBeReplaced()) return;
    const result = await runTask('正在比较替换目录…', () => api.replaceDirectory(folderPath));
    applyDirectoryResult(result);
  }

  async function clearSelected(id = state.current?.id) {
    if (id === undefined || id === null) return;
    if (!window.confirm('将当前工程文件还原为源 PKG 内容？')) return;
    const result = await runTask('正在还原工程文件…', () => api.resetEntry(id));
    if (result) {
      applyStaged(result);
      const key = String(id);
      const draft = state.textDrafts.get(key);
      if (draft?.available && draft.text !== draft.stagedText) {
        const baseline = await runTask('正在刷新文本基线…', () => api.getText(draft.entryId ?? id));
        if (baseline) updateDraftBaseline(draft, baseline);
        else draft.conflict = true;
      } else {
        invalidatePreviewCache(key);
        state.textRequest += 1;
        state.textDrafts.delete(key);
        const entry = state.entryById.get(key);
        if (entry && state.current && String(state.current.id) === key) renderTextEntry(entry);
      }
      syncDirty();
    }
  }

  async function clearAll() {
    if (state.staged.size && !window.confirm(`将 ${state.staged.size} 项工程文件还原为源 PKG 内容？`)) return;
    if (hasUnsavedChanges() && !window.confirm('还原工程文件后，当前未保存的文本草稿会继续保留。是否继续？')) return;
    const result = await runTask('正在还原全部工程文件…', () => api.resetAll());
    if (result) {
      const objectResult = !Array.isArray(result);
      const partial = objectResult && result.ok === false;
      applyStaged(objectResult ? result.staged : result);
      const affected = objectResult && Array.isArray(result.affectedIds) ? new Set(result.affectedIds.map(String)) : null;
      for (const [id, draft] of [...state.textDrafts]) {
        if (affected && !affected.has(String(id))) continue;
        if (!draft.available) {
          state.textDrafts.delete(id);
          continue;
        }
        if (draft.text !== draft.stagedText) {
          const baseline = await runTask('正在刷新文本基线…', () => api.getText(draft.entryId ?? id));
          if (baseline) updateDraftBaseline(draft, baseline);
          else draft.conflict = true;
        } else state.textDrafts.delete(id);
      }
      if (state.current && !state.textDrafts.has(String(state.current.id))) {
        invalidatePreviewCache(state.current.id);
        state.textRequest += 1;
        renderTextEntry(state.current);
      }
      syncDirty();
      if (partial) {
        notify(`已还原 ${Number(result.completed) || 0} 项，处理「${result.failedId || '未知文件'}」失败：${result.error || '未知错误'}`, true);
      } else notify(`已还原 ${Number(result.completed) || state.staged.size} 项工程文件`);
    }
  }

  function updateDraftBaseline(draft, baseline) {
    const text = String(baseline?.text ?? '').replace(/\r\n?/g, '\n');
    draft.originalText = text;
    draft.stagedText = text;
    draft.entryId = baseline?.id ?? draft.entryId;
    draft.encoding = baseline?.encoding || draft.encoding;
    draft.newline = baseline?.newline || draft.newline;
    draft.bom = !!baseline?.bom;
    draft.sha256 = baseline?.sha256 || draft.sha256;
    draft.conflict = false;
    if (currentDraft() === draft) {
      elements.encodingInfo.textContent = `${draft.encoding} · ${draft.newline}${draft.bom ? ' · BOM' : ''}`;
    }
  }

  async function exportSelected(id = (state.contextTarget?.type === 'file' ? state.contextTarget.id : state.current?.id)) {
    if (id === undefined || id === null) return notify('先在文件树中选择一个资源', true);
    const ids = [id];
    const result = await runTask('正在导出所选条目…', () => api.exportSelected(ids));
    if (result && !result.canceled) notify(`已导出 ${result.count} 项到「${result.directoryName}」`);
  }

  async function exportAll() {
    const result = await runTask('正在导出全部条目…', () => api.exportAll());
    if (result && !result.canceled) notify(`已导出 ${result.count} 项到「${result.directoryName}」`);
  }

  async function exportEditable(id = state.current?.id) {
    if (id === undefined || id === null) return;
    const result = await runTask('正在生成 PNG 编辑预览…', () => api.exportEditable(id));
    if (result && !result.canceled) notify(`已导出 ${result.files.join('、')}`);
  }

  async function importEditable(id = state.current?.id) {
    if (id === undefined || id === null) return;
    if (!confirmReplacementOverwrite(id)) return;
    const result = await runTask('正在转换导入 PNG…', () => api.importEditable(id));
    if (result && !result.canceled) {
      if (!applyStaged(result)) {
        notify(`工程文件导入未完整完成：${result.error || result.snapshotError || '无法确认工程差异'}`, true);
        return;
      }
      discardTextDraft(id);
      notify('PNG 已转换并写入工程文件');
    }
  }

  async function reloadDiskContent() {
    const draft = currentDraft();
    if (!draft?.available || !draft.conflict || !state.current) return;
    if (draft.text !== draft.stagedText && !window.confirm('重新载入会丢弃当前文本草稿。是否继续？')) return;
    const entry = state.current;
    const result = await runTask('正在重新载入工程文件…', () => api.getText(entry.id));
    if (!result || state.current !== entry) return;
    state.textRequest += 1;
    const text = String(result.text ?? '').replace(/\r\n?/g, '\n');
    state.textDrafts.set(String(entry.id), {
      available: true, entryId: result.id ?? entry.id,
      text, originalText: text, stagedText: text, sha256: result.sha256 || '', conflict: false,
      encoding: result.encoding || 'UTF-8', newline: result.newline || 'LF', bom: !!result.bom,
    });
    invalidatePreviewCache(entry.id);
    renderTextEntry(entry);
    syncDirty();
    notify('已载入工程文件的磁盘内容');
  }

  async function saveAs() {
    let failedDraftId = '';
    const result = await runTask('正在保存文本并导出 PKG…', async () => {
      if (!state.projectMode) throw new Error('请先打开或新建工程');
      for (const [id, draft] of state.textDrafts) {
        if (!draft.available || draft.text === draft.stagedText) continue;
        failedDraftId = id;
        await saveDraftToProject(id, draft);
        failedDraftId = '';
      }
      renderStagedSummary();
      const saved = await api.saveAs();
      return saved;
    });
    if (!result && failedDraftId) {
      const entry = state.entryById.get(failedDraftId);
      if (entry && String(state.current?.id) !== failedDraftId) selectEntry(entry);
    }
    if (result && !result.canceled) notify(`已导出 PKG「${result.pathName}」，写入 ${result.count} 项差异`);
  }

  elements.welcomeProjectButton.addEventListener('click', openProject);
  elements.welcomeOpenButton.addEventListener('click', openArchive);
  elements.reloadDiskButton.addEventListener('click', reloadDiskContent);
  elements.quickOpenInput.addEventListener('input', () => { state.quickIndex = 0; updateQuickOpen(); });
  elements.quickOpenInput.addEventListener('keydown', handleQuickOpenKeydown);
  elements.closeInfoButton.addEventListener('click', closeResourceInfo);
  elements.tableViewTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-table-view]');
    if (!button || !state.current || state.previewData?.kind !== 'table') return;
    const tab = getTab(state.current.id);
    if (!tab) return;
    tab.tableView = button.dataset.tableView === 'schema' ? 'schema' : 'data';
    renderTablePreview(state.previewData);
  });
  elements.infoDialog.addEventListener('click', (event) => {
    if (event.target === elements.infoDialog) closeResourceInfo();
  });
  elements.sidebarResizer.addEventListener('pointerdown', (event) => {
    if (!state.sidebarVisible) return;
    state.resizeActive = true;
    elements.sidebarResizer.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  elements.sidebarResizer.addEventListener('pointermove', (event) => {
    if (!state.resizeActive) return;
    state.sidebarWidth = Math.max(170, Math.min(window.innerWidth * .45, event.clientX));
    elements.sidebar.style.width = `${state.sidebarWidth}px`;
  });
  elements.sidebarResizer.addEventListener('pointerup', () => { state.resizeActive = false; });
  elements.textEditor.addEventListener('scroll', () => {
    elements.lineGutter.scrollTop = elements.textEditor.scrollTop;
    renderLineNumbers();
    captureCurrentView();
  }, { passive: true });
  elements.textEditor.addEventListener('input', () => {
    const draft = currentDraft();
    if (!draft?.available) return;
    draft.text = elements.textEditor.value.replace(/\r\n?/g, '\n');
    const tab = getTab(state.current?.id);
    if (tab) tab.pinned = true;
    renderLineNumbers();
    syncDirty();
    updateCursorState();
  });
  elements.textEditor.addEventListener('click', updateCursorState);
  elements.textEditor.addEventListener('keyup', updateCursorState);
  elements.textEditor.addEventListener('select', updateCursorState);
  elements.textEditor.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    if (state.taskBusy || elements.textEditor.readOnly || elements.textEditor.disabled) return;
    event.preventDefault();
    if (!document.execCommand('insertText', false, '  ')) {
      const editor = elements.textEditor;
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  elements.contextMenu.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (button && !button.disabled) runContextAction(button.dataset.action);
  });
  document.addEventListener('click', (event) => {
    if (!elements.contextMenu.contains(event.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    hideContextMenu();
    if (!elements.infoDialog.classList.contains('hidden')) closeResourceInfo();
  });
  elements.entryList.addEventListener('scroll', () => renderTree(false, false), { passive: true });
  elements.entryList.addEventListener('keydown', (event) => {
    if (state.taskBusy || event.metaKey || event.ctrlKey || event.altKey) return;
    const row = event.target.closest('.entry-row');
    if (!row) return;
    const index = Number(row.dataset.visibleIndex);
    const item = state.visibleNodes[index];
    if (!item) return;
    const { node } = item;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusVisibleIndex(Math.min(state.visibleNodes.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusVisibleIndex(Math.max(0, index - 1));
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (node.type === 'folder' && isExpanded(node)) {
        toggleFolder(node);
        const sameIndex = state.visibleNodes.findIndex((entry) => entry.node.key === node.key);
        if (sameIndex >= 0) focusVisibleIndex(sameIndex);
      }
      else if (node.parent && node.parent !== state.treeRoot) {
        const parentIndex = state.visibleNodes.findIndex((entry) => entry.node.key === node.parent.key);
        if (parentIndex >= 0) focusVisibleIndex(parentIndex);
      }
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (node.type !== 'folder') return;
      if (!isExpanded(node)) toggleFolder(node);
      const firstChild = state.visibleNodes.findIndex((entry, position) => position > index && entry.node.parent === node);
      if (firstChild >= 0) focusVisibleIndex(firstChild);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (node.type === 'folder') toggleFolder(node);
      else {
        selectEntry(node.entry);
        const sameIndex = state.visibleNodes.findIndex((entry) => entry.node.key === node.key);
        if (sameIndex >= 0) focusVisibleIndex(sameIndex);
      }
    }
  });

  api.onProgress((value) => {
    if (!state.taskBusy) return;
    const total = Number(value.total) || 0;
    const done = Number(value.done) || 0;
    elements.statusText.textContent = value.message || '正在处理…';
    if (total > 0) {
      elements.progressFill.classList.remove('indeterminate');
      elements.progressFill.style.width = `${Math.max(2, Math.min(100, done / total * 100))}%`;
    }
  });

  api.onCommand?.((command) => {
    if (command === 'open') openArchive();
    else if (command === 'openProject') openProject();
    else if (command === 'save') stageTextDraft();
    else if (command === 'saveAs') saveAs();
    else if (command === 'refreshProject') refreshProject();
    else if (command === 'find' || command === 'quickOpen') openQuickOpen();
    else if (command === 'closeTab' && state.activeTabId !== null) closeTab(state.activeTabId);
    else if (command === 'exportSelected') exportSelected();
    else if (command === 'exportAll') exportAll();
    else if (command === 'replaceFile') stageSelectedFile();
    else if (command === 'replaceDirectory') stageDirectory();
    else if (command === 'exportEditable') exportEditable();
    else if (command === 'importEditable') importEditable();
    else if (command === 'resetEntry') clearSelected();
    else if (command === 'resetAll') clearAll();
    else if (command === 'info') showResourceInfo();
    else if (command === 'toggleSidebar') toggleSidebar();
    else if (command === 'importTableSchema') changeTableSchema('import');
    else if (command === 'clearTableSchema') changeTableSchema('clear');
  });

  window.addEventListener('blur', () => {
    clearTimeout(state.focusRefreshTimer);
    state.focusRefreshTimer = null;
    stopAnimation();
    destroyEffectScene();
  });
  function schedulePreviewResume(refreshProjectFirst = true) {
    clearTimeout(state.focusRefreshTimer);
    state.focusRefreshTimer = setTimeout(async () => {
      state.focusRefreshTimer = null;
      if (state.taskBusy || !state.opened || !state.current) return;
      if (refreshProjectFirst && state.projectMode) {
        const refreshed = await refreshProject(true);
        if (!refreshed && !state.taskBusy && state.current && state.previewData?.kind === 'effect-scene' && !state.effectScene) {
          loadProjectPreview(state.current);
        }
      } else if (state.previewData?.kind === 'effect-scene' && !state.effectScene) {
        loadProjectPreview(state.current);
      }
    }, 180);
  }

  window.addEventListener('focus', () => {
    schedulePreviewResume();
  });

  document.addEventListener('visibilitychange', () => {
    state.previewVisible = !document.hidden;
    if (!state.previewVisible) {
      stopAnimation();
      destroyEffectScene();
    } else schedulePreviewResume();
    syncPreviewControls();
  });
  window.addEventListener('pagehide', () => {
    destroyMapScene();
    destroyEffectScene();
    stopAnimation();
    state.previewRequest += 1;
    state.textRequest += 1;
  }, { once: true });

  updateControls();
  api.getSession().then((session) => {
    if (session?.opened) applySession(session);
    else setStatus('就绪');
  }).catch((error) => {
    setStatus(`恢复工程会话失败：${error?.message || String(error)}`, 'error');
  });
})();
