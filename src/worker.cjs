'use strict';

const { parentPort } = require('node:worker_threads');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const preview = require('./preview.cjs');
const mapPreview = require('./map-preview.cjs');
const midiPreview = require('./midi-preview.cjs');
const binaryPreview = require('./binary-preview.cjs');
const procPreview = require('./proc-preview.cjs');
const tablePreview = require('./table-preview.cjs');
const rasterPreview = require('./raster-preview.cjs');
const structuredPreview = require('./structured-preview.cjs');
const archivePreview = require('./archive-preview.cjs');
const effectPreview = require('./effect-preview.cjs');
const { makeEffectScene } = require('./effect-scene.cjs');
const { makeScenePreview } = require('./map-scene.cjs');
const { readMapLogic } = require('./map-logic.cjs');
const { attachMapLogic } = require('./scene-contract.cjs');
const { makeWorldResourcePreview } = require('./world-resource-preview.cjs');
const projectStore = require('./project.cjs');

let project = null;
let archive = null;
let entriesById = new Map();
let entriesByPath = new Map();
let currentEntryId = null;
let previewBuffer = null;
let previewBufferId = null;
let previewBufferFingerprint = null;
const textMetadata = new Map();
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
let dispatchQueue = Promise.resolve();

function entryId(entry) { return String(entry.id); }

function requireArchive() {
  if (!archive) throw new Error('请先打开 PKG 文件');
}

function requireEntry(id) {
  requireArchive();
  const entry = entriesById.get(String(id));
  if (!entry) throw new Error('找不到所选资源');
  return entry;
}

function clearPreviewBuffer() {
  previewBuffer = null;
  previewBufferId = null;
  previewBufferFingerprint = null;
}

function clearPreviewBufferUnless(id) {
  if (previewBufferId !== null && previewBufferId !== String(id)) clearPreviewBuffer();
}

async function getPreviewBuffer(entry) {
  const id = entryId(entry);
  const before = await projectStore.statEntry(project, entry.id);
  const fingerprint = before.fingerprint;
  if (previewBuffer && previewBufferId === id && sameFingerprint(previewBufferFingerprint, fingerprint)) return previewBuffer;
  clearPreviewBuffer();
  const data = await projectStore.readEntry(project, entry.id, 67108864);
  const after = await projectStore.statEntry(project, entry.id);
  if (!sameFingerprint(fingerprint, after.fingerprint)) throw new Error(`工程资源在读取期间发生变化：${entry.name}`);
  previewBuffer = data;
  previewBufferId = id;
  previewBufferFingerprint = fingerprint;
  return data;
}

function sameFingerprint(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs);
}

function normalizedRelatedName(name) {
  const value = String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = value.split('/');
  if (!value || parts.some((part) => part === '..')) return null;
  return parts.filter((part) => part && part !== '.').join('/').toLowerCase();
}

function findRelatedEntry(name) {
  const key = normalizedRelatedName(name);
  if (!key) return null;
  const match = entriesByPath.get(key);
  if (match === false) throw new Error(`同包资源名称存在大小写或路径冲突：${name}`);
  return match || null;
}

// A scene reads only registered project entries, with a request-local bounded cache.
// Retain fingerprints rather than source buffers for the final consistency check.
function sceneDependencies() {
  const requested = new Set();
  const observed = new Map();
  const cache = new Map();
  let readBytes = 0;
  let cacheBytes = 0;
  let reads = Promise.resolve();
  const readOne = async (name) => {
    const key = normalizedRelatedName(name);
    if (!key) throw new Error('地图依赖路径无效');
    if (cache.has(key)) return cache.get(key);
    if (!requested.has(key)) {
      if (requested.size >= 256) throw new Error('场景依赖超过 256 项上限');
      requested.add(key);
    }
    const entry = findRelatedEntry(name);
    if (!entry) { cache.set(key, null); return null; }
    const before = await projectStore.statEntry(project, entry.id);
    const previous = observed.get(String(entry.id));
    if (previous && !sameFingerprint(previous.fingerprint, before.fingerprint)) {
      throw new Error(`场景依赖在预览期间发生变化：${entry.name}`);
    }
    const limit = Math.min(67108864, 134217728 - readBytes);
    if (limit < 1) throw new Error('场景依赖读取总量超过 128 MiB 上限');
    const bytes = await projectStore.readEntry(project, entry.id, limit);
    readBytes += bytes.length;
    const after = await projectStore.statEntry(project, entry.id);
    if (!sameFingerprint(before.fingerprint, after.fingerprint)) {
      throw new Error(`场景依赖在读取期间发生变化：${entry.name}`);
    }
    observed.set(String(entry.id), { entry, fingerprint: after.fingerprint });
    if (bytes.length <= 16777216) {
      for (const [cachedKey, value] of cache) {
        if (cacheBytes + bytes.length <= 16777216) break;
        if (value) { cacheBytes -= value.length; cache.delete(cachedKey); }
      }
      cache.set(key, bytes);
      cacheBytes += bytes.length;
    }
    return bytes;
  };
  const readRelated = name => {
    const result = reads.then(() => readOne(name));
    reads = result.catch(() => {});
    return result;
  };
  const verify = async () => {
    for (const { entry, fingerprint } of observed.values()) {
      const current = await projectStore.statEntry(project, entry.id);
      if (!sameFingerprint(fingerprint, current.fingerprint)) {
        throw new Error(`场景依赖在预览期间发生变化：${entry.name}，请重新打开预览`);
      }
    }
  };
  // ResLoader.ObjPath uses Pkg.FindUnique(prefix, suffix) only after its exact
  // object path is absent. Expose names, never filesystem paths or file contents.
  const findRelatedPaths = (prefix, suffix) => {
    const key = normalizedRelatedName(prefix);
    if (!key || typeof suffix !== 'string' || !/^_\d+\.gso$/i.test(suffix)) {
      throw new Error('物件目录查询参数无效');
    }
    const directory = `${key}/`;
    const ending = suffix.toLowerCase();
    const matches = [];
    for (const entry of archive.entries) {
      const candidate = normalizedRelatedName(entry.name);
      if (candidate?.startsWith(directory) && candidate.endsWith(ending)) {
        if (matches.length >= 32) throw new Error('物件同名候选超过 32 项，不能确定素材');
        matches.push(entry.name);
      }
    }
    return matches;
  };
  return { readRelated, findRelatedPaths, verify };
}

function findTableSchemaEntry(entry) {
  const normalized = String(entry.name ?? '').replace(/\\/g, '/');
  const directory = path.posix.dirname(normalized);
  const sibling = directory === '.' ? 'ov_res.bin' : `${directory}/ov_res.bin`;
  const seen = new Set();
  for (const candidate of [sibling, 'zipbin/ov_res.bin']) {
    const key = normalizedRelatedName(candidate);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const match = findRelatedEntry(candidate);
    if (match) return match;
  }
  return null;
}

async function stableSchemaEntryBytes(entry) {
  const before = await projectStore.statEntry(project, entry.id);
  const bytes = await projectStore.readEntry(project, entry.id, 8 * 1024 * 1024);
  const after = await projectStore.statEntry(project, entry.id);
  if (!sameFingerprint(before.fingerprint, after.fingerprint)) {
    throw new Error(`工程内表结构在读取期间发生变化：${entry.name}`);
  }
  return bytes;
}

async function tableSchemaForEntry(entry) {
  let schemaEntry;
  try {
    schemaEntry = findTableSchemaEntry(entry);
  } catch (error) {
    return {
      schemaBuffer: null,
      schemaSource: '',
      schemaError: `工程内表结构查找失败：${error.message}`,
    };
  }
  if (schemaEntry) {
    try {
      return {
        schemaBuffer: await stableSchemaEntryBytes(schemaEntry),
        schemaSource: `工程资源 ${schemaEntry.name}`,
        schemaError: '',
      };
    } catch (error) {
      return {
        schemaBuffer: null,
        schemaSource: `工程资源 ${schemaEntry.name}`,
        schemaError: `工程内表结构无法读取：${error.message}`,
      };
    }
  }
  try {
    const imported = await projectStore.readTableSchema(project);
    return imported
      ? { schemaBuffer: imported.buffer, schemaSource: imported.source, schemaError: '' }
      : { schemaBuffer: null, schemaSource: '', schemaError: '' };
  } catch (error) {
    return {
      schemaBuffer: null,
      schemaSource: '项目导入副本（.pkg-studio/table-schema.bin）',
      schemaError: `项目导入的表结构无效：${error.message}`,
    };
  }
}

function progress(requestId, value) {
  parentPort.postMessage({ type: 'progress', requestId, progress: {
    done: Number(value?.done) || 0,
    total: Number(value?.total) || 0,
    message: typeof value?.message === 'string' ? value.message : '',
  } });
}

function serializableEntries(values) {
  return values.map((entry) => ({
    id: entry.id,
    name: String(entry.name ?? ''),
    size: Number(entry.size) || 0,
    packedSize: Number(entry.packedSize) || 0,
    ...(entry.offset !== undefined ? { offset: Number(entry.offset) || 0 } : {}),
    ...(entry.codec !== undefined ? { codec: String(entry.codec) } : {}),
  }));
}

function sessionSnapshot() {
  if (!project || !archive) return { opened: false, projectMode: true, entries: [], staged: [], currentId: null };
  return {
    opened: true,
    projectMode: true,
    projectName: project.metadata.name,
    projectPath: project.directory,
    pathName: project.metadata.source.originalName,
    entryCount: archive.entries.length,
    entries: serializableEntries(archive.entries),
    staged: [],
    currentId: currentEntryId,
  };
}

function decodeEditableText(buffer, entry, stagedReplacement) {
  if (buffer.length > MAX_TEXT_BYTES) throw new Error('文本文件超过 2 MiB 编辑上限');
  if (buffer.includes(0)) throw new Error('此条目包含二进制数据，不能作为文本编辑');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch (_) {
    throw new Error('此条目不是有效的 UTF-8 文本，不能编辑');
  }
  if (!Buffer.from(text, 'utf8').equals(buffer)) throw new Error('UTF-8 内容无法无损往返，不能编辑');
  for (const character of text) {
    const code = character.codePointAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      throw new Error('此条目包含二进制控制字符，不能作为文本编辑');
    }
  }
  const newlineMatches = text.match(/\r\n|\r|\n/g) || [];
  const kinds = new Set(newlineMatches.map((value) => value === '\r\n' ? 'CRLF' : value === '\r' ? 'CR' : 'LF'));
  if (kinds.size > 1) throw new Error('此文本混用了多种换行符，暂不支持编辑以免改变原始格式');
  const newline = kinds.size ? [...kinds][0] : 'none';
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const source = stagedReplacement ? 'project' : 'archive';
  const name = String(entry.name ?? '');
  textMetadata.set(entryId(entry), { bom, newline: newline === 'none' ? 'LF' : newline });
  if (bom) text = text.slice(1);
  text = text.replace(/\r\n|\r/g, '\n');
  return { id: entry.id, name, text, bytes: buffer.length, encoding: 'UTF-8', bom, newline, staged: false, source };
}

function encodeEditableText(id, input) {
  if (typeof input !== 'string') throw new Error('文本内容无效');
  const metadata = textMetadata.get(String(id));
  if (!metadata) throw new Error('请先重新读取并确认该条目为可编辑文本');
  const normalized = input.replace(/\r\n|\r/g, '\n');
  for (const character of normalized) {
    const code = character.codePointAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c) || (code >= 0x7f && code <= 0x9f)) {
      throw new Error('文本包含二进制控制字符，不能暂存为 UTF-8 文本');
    }
  }
  const lineEnding = metadata.newline === 'CRLF' ? '\r\n' : metadata.newline === 'CR' ? '\r' : '\n';
  const withEnding = normalized.replace(/\n/g, lineEnding);
  const content = `${metadata.bom ? '\ufeff' : ''}${withEnding}`;
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > MAX_TEXT_BYTES) throw new Error('保存后的文本超过 2 MiB 上限');
  let roundTrip;
  try {
    roundTrip = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch (_) {
    throw new Error('文本无法无损编码为 UTF-8');
  }
  if (roundTrip !== content) throw new Error('文本包含无法无损编码的字符');
  return { buffer, newline: metadata.newline, bom: metadata.bom };
}

function activateProject(value) {
  project = value;
  archive = value?.archive || null;
  entriesById = new Map(archive?.entries.map((entry) => [entryId(entry), entry]) || []);
  entriesByPath = new Map();
  for (const entry of archive?.entries || []) {
    const key = normalizedRelatedName(entry.name);
    if (key) entriesByPath.set(key, entriesByPath.has(key) ? false : entry);
  }
  currentEntryId = null;
  clearPreviewBuffer();
  textMetadata.clear();
}

async function assertRegularNoSymlink(filePath) {
  const stat = await fsp.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`替换项必须是普通文件且不能是符号链接：${path.basename(filePath)}`);
  return stat;
}

async function dispatch(method, args, requestId) {
  if (method === 'createProject') {
    const opened = await projectStore.createProject(args.path, args.directory, (value) => progress(requestId, value));
    const staged = await projectStore.stagedSnapshot(opened);
    activateProject(opened);
    return { ...sessionSnapshot(), staged };
  }
  if (method === 'openProject') {
    const opened = await projectStore.openProject(args.directory, (value) => progress(requestId, value));
    const staged = await projectStore.stagedSnapshot(opened);
    activateProject(opened);
    return { ...sessionSnapshot(), staged };
  }
  if (method === 'refreshProject') {
    requireArchive();
    const opened = await projectStore.refreshProject(project, (value) => progress(requestId, value));
    const staged = await projectStore.stagedSnapshot(opened);
    activateProject(opened);
    return { ...sessionSnapshot(), staged };
  }
  if (method === 'getSession') return { ...sessionSnapshot(), staged: project ? await projectStore.stagedSnapshot(project) : [] };
  if (method === 'getStaged') return project ? projectStore.stagedSnapshot(project) : [];
  if (method === 'importTableSchema') {
    requireArchive();
    return projectStore.importTableSchema(project, args.path);
  }
  if (method === 'clearTableSchema') {
    requireArchive();
    return projectStore.clearTableSchema(project);
  }
  if (method === 'readText') {
    const entry = requireEntry(args.id);
    clearPreviewBufferUnless(entry.id);
    textMetadata.delete(entryId(entry));
    const data = await projectStore.readEntry(project, entry.id, MAX_TEXT_BYTES);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    return { ...decodeEditableText(data, entry, true), sha256: hash };
  }
  if (method === 'stageText') {
    const entry = requireEntry(args.id);
    const id = entryId(entry);
    const currentBytes = await projectStore.readEntry(project, entry.id, MAX_TEXT_BYTES);
    const currentHash = crypto.createHash('sha256').update(currentBytes).digest('hex');
    if (typeof args.expectedHash !== 'string') throw new Error('保存文本时必须提供读取时的工程资源哈希');
    if (args.expectedHash !== currentHash) throw new Error(`PROJECT_CONFLICT:工程资源已被外部修改：${entry.name}`);
    decodeEditableText(currentBytes, entry, true);
    const { buffer, newline, bom } = encodeEditableText(id, args.text);
    const saved = await projectStore.writeBuffer(project, entry.id, buffer, args.expectedHash);
    textMetadata.set(id, { bom, newline: newline === 'none' ? 'LF' : newline });
    clearPreviewBuffer();
    return { staged: await projectStore.stagedSnapshot(project), sha256: saved.sha256 };
  }
  if (method === 'previewEntry') {
    const entry = requireEntry(args.id);
    clearPreviewBufferUnless(entry.id);
    const options = args.options === undefined ? { page: 0 } : args.options;
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('预览选项无效');
    const page = options.page === undefined ? 0 : options.page;
    if (!Number.isSafeInteger(page) || page < 0) throw new Error('预览页码必须是非负安全整数');
    const columnPage = options.columnPage === undefined ? 0 : options.columnPage;
    if (!Number.isSafeInteger(columnPage) || columnPage < 0) throw new Error('表格列页码必须是非负安全整数');
    currentEntryId = entry.id;
    const data = await getPreviewBuffer(entry);
    if (options.view === 'source' && /\.(eff|link|npc|lst)$/i.test(entry.name)) {
      return preview.makePreview(data, entry.name, options);
    }
    if (/\.eff$/i.test(entry.name)) {
      if (options.view === 'structure') return effectPreview.makeEffectPreview(data, entry.name, { page });
      const dependencies = sceneDependencies();
      const sourceFingerprint = previewBufferFingerprint;
      const result = await makeEffectScene(data, entry.name, dependencies);
      await dependencies.verify();
      const current = await projectStore.statEntry(project, entry.id);
      if (!sameFingerprint(sourceFingerprint, current.fingerprint)) {
        throw new Error('特效在预览期间发生变化，请重新打开预览');
      }
      return result;
    }
    if (/\.(prc|link|npc|lst)$/i.test(entry.name)) {
      const dependencies = sceneDependencies();
      const sourceFingerprint = previewBufferFingerprint;
      const result = await makeWorldResourcePreview(data, entry.name, { ...dependencies, page });
      await dependencies.verify();
      const current = await projectStore.statEntry(project, entry.id);
      if (!sameFingerprint(sourceFingerprint, current.fingerprint)) {
        throw new Error('资源在预览期间发生变化，请重新打开预览');
      }
      return result ?? preview.makePreview(data, entry.name, options);
    }
    if (/\.gsm$/i.test(entry.name)) {
      const dependencies = sceneDependencies();
      const sourceFingerprint = previewBufferFingerprint;
      // Reserve dependency reads for logic before potentially large object libraries.
      const logic = await readMapLogic(entry.name, dependencies);
      const scene = await makeScenePreview(data, entry.name, dependencies);
      await dependencies.verify();
      const current = await projectStore.statEntry(project, entry.id);
      if (!sameFingerprint(sourceFingerprint, current.fingerprint)) {
        throw new Error('地图在场景预览期间发生变化，请重新打开预览');
      }
      return attachMapLogic(scene, logic);
    }
    const related = new Map();
    let relatedReadCount = 0;
    let relatedBytes = 0;
    const readRelated = async (name) => {
      const key = normalizedRelatedName(name);
      if (!key) return null;
      if (related.has(key)) return related.get(key);
      const relatedEntry = findRelatedEntry(name);
      if (!relatedEntry) {
        related.set(key, null);
        return null;
      }
      if (relatedReadCount >= 2) throw new Error('地图预览最多读取两个同包依赖资源');
      relatedReadCount += 1;
      const item = requireEntry(relatedEntry.id);
      const bytes = await projectStore.readEntry(project, item.id, 67108864);
      relatedBytes += bytes.length;
      if (relatedBytes > 134217728) throw new Error('地图依赖资源总量超过 128 MiB 上限');
      related.set(key, bytes);
      return bytes;
    };
    const rasterResult = await rasterPreview.makeRasterPreview(data, entry.name, { page });
    if (rasterResult !== null) return rasterResult;
    const structuredResult = await structuredPreview.makeStructuredPreview(data, entry.name, { page, columnPage, readRelated });
    if (structuredResult !== null) return structuredResult;
    const archiveResult = await archivePreview.makeArchivePreview(data, entry.name, { page });
    if (archiveResult !== null) return archiveResult;
    const effectResult = effectPreview.makeEffectPreview(data, entry.name, { page });
    if (effectResult !== null) return effectResult;
    const mapResult = await mapPreview.makeMapPreview(data, entry.name, { readRelated, page });
    if (mapResult !== null) return mapResult;
    const midiResult = await midiPreview.makeMidiPreview(data, entry.name);
    if (midiResult !== null) return midiResult;
    const procResult = procPreview.makeProcPreview(data, entry.name, { page });
    if (procResult !== null) return procResult;
    if (/\.bin$/i.test(String(entry.name || ''))) {
      const schema = await tableSchemaForEntry(entry);
      try {
        const tableResult = tablePreview.makeTablePreview(data, entry.name, { page, columnPage, ...schema });
        if (tableResult !== null) return tableResult;
      } catch (error) {
        if (error.code !== 'TABLE_HEADER_INVALID') throw error;
        const raw = binaryPreview.makeBinaryPreview(data, entry.name, { page });
        raw.info = `${error.message}；${raw.info}`;
        return raw;
      }
      return binaryPreview.makeBinaryPreview(data, entry.name, { page });
    }
    return preview.makePreview(data, entry.name, options);
  }
  if (method === 'previewFrame') {
    const entry = requireEntry(args.id);
    clearPreviewBufferUnless(entry.id);
    const frameIndex = args.frameIndex;
    if (!Number.isSafeInteger(frameIndex) || frameIndex < 0) throw new Error('动画帧编号必须是非负安全整数');
    currentEntryId = entry.id;
    const data = await getPreviewBuffer(entry);
    const result = await preview.makePreview(data, entry.name, { frameIndex });
    if (result?.kind !== 'animation' || result.frameIndex !== frameIndex) {
      const explanation = typeof result?.info === 'string' ? `：${result.info}` : '';
      throw new Error(`此条目没有可预览的动画帧 ${frameIndex}${explanation}`);
    }
    return result;
  }
  if (method === 'stageFile' || method === 'replaceFile') {
    const entry = requireEntry(args.id);
    const result = await projectStore.replaceFile(project, entry.id, args.path);
    textMetadata.delete(entryId(entry));
    clearPreviewBuffer();
    return result;
  }
  if (method === 'stageDirectory' || method === 'stageFolder' || method === 'replaceDirectory') {
    const result = await projectStore.replaceDirectory(project, args.path, args.folderPath || '', (value) => progress(requestId, value));
    for (const id of result.affectedIds || []) textMetadata.delete(String(id));
    clearPreviewBuffer();
    return result;
  }
  if (method === 'resetEntry') {
    const entry = requireEntry(args.id);
    const result = await projectStore.resetEntry(project, entry.id);
    textMetadata.delete(entryId(entry));
    clearPreviewBuffer();
    return result;
  }
  if (method === 'resetAll') {
    const result = await projectStore.resetAll(project, (value) => progress(requestId, value));
    textMetadata.clear();
    clearPreviewBuffer();
    return result;
  }
  if (method === 'exportSelected' || method === 'exportAll') {
    requireArchive();
    const ids = method === 'exportAll' ? archive.entries.map((entry) => entry.id) : args.ids.map((id) => {
      if (typeof id === 'number' && Number.isSafeInteger(id)) return id;
      if (typeof id === 'string' && /^\d+$/.test(id) && Number.isSafeInteger(Number(id))) return Number(id);
      throw new Error('所选条目标识无效');
    });
    const result = await projectStore.exportEntries(project, ids, args.directory, (value) => progress(requestId, value));
    return { count: Number(result?.count) || 0, entries: Array.isArray(result?.entries) ? result.entries : [], directoryName: path.basename(args.directory) };
  }
  if (method === 'exportEditable') {
    const entry = requireEntry(args.id);
    const data = await projectStore.readEntry(project, entry.id, 67108864);
    const editable = await preview.exportEditable(data, entry.name);
    await fsp.mkdir(args.directory, { recursive: true });
    const base = path.basename(String(entry.name).replace(/\\/g, '/')) || String(entry.id);
    const written = [];
    const createdPaths = [];
    try {
      for (const file of editable.files) {
        const suffix = String(file.suffix ?? '');
        if (!/^\.[a-zA-Z0-9._-]{1,40}$/.test(suffix)) throw new Error('编辑预览返回了无效文件扩展名');
        const target = path.join(args.directory, `${base}${suffix}`);
        await fsp.writeFile(target, file.data, { flag: 'wx' });
        createdPaths.push(target);
        written.push(path.basename(target));
      }
    } catch (error) {
      await Promise.all(createdPaths.map((target) => fsp.unlink(target).catch(() => {})));
      throw error;
    }
    return { files: written, info: editable.info };
  }
  if (method === 'importEditable') {
    const entry = requireEntry(args.id);
    const pngStat = await assertRegularNoSymlink(args.path);
    if (pngStat.size > 67108864) throw new Error('PNG 文件超过 64 MiB 上限');
    const original = await projectStore.readEntry(project, entry.id, 67108864);
    const png = await fsp.readFile(args.path);
    const converted = await preview.importEditable(original, png, entry.name);
    const expectedHash = crypto.createHash('sha256').update(original).digest('hex');
    const result = await projectStore.writeBuffer(project, entry.id, converted, expectedHash);
    textMetadata.delete(entryId(entry));
    clearPreviewBuffer();
    return { sha256: result.sha256, staged: await projectStore.stagedSnapshot(project) };
  }
  if (method === 'repack') {
    requireArchive();
    return projectStore.repack(project, args.path, (value) => progress(requestId, value));
  }
  throw new Error(`未知后台操作：${method}`);
}

async function cleanup() {
  clearPreviewBuffer();
}

parentPort.on('close', () => { cleanup().catch(() => {}); });

parentPort.on('message', (message) => {
  dispatchQueue = dispatchQueue.then(async () => {
    const { requestId, method, args } = message || {};
    try {
      const result = method === 'shutdown' ? (await cleanup(), { stopped: true }) : await dispatch(method, args || {}, requestId);
      parentPort.postMessage({ requestId, result });
    } catch (error) {
      parentPort.postMessage({ requestId, error: error?.message || String(error) });
    }
  });
});
