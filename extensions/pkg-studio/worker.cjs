'use strict';

const { parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const pkg = require('./runtime/pkg.cjs');
const preview = require('./runtime/preview.cjs');

let archive;
let archiveMountId = null;
const previewSources = new Map();
const previewBuffers = new Map();
let previewBufferBytes = 0;
const PREVIEW_CACHE_BYTES = 67108864;
const staged = new Map();
const temporaryFiles = new Map();
let temporaryRoot;
let queue = Promise.resolve();

function requireArchive() { if (!archive) throw new Error('Open a PKG archive first.'); }
function entryFor(id) {
  requireArchive();
  const entry = archive.entries.find(item => String(item.id) === String(id));
  if (!entry) throw new Error('The selected package resource no longer exists.');
  return entry;
}
function progress(requestId, value) {
  parentPort.postMessage({ type: 'progress', requestId, value: {
    done: Number(value?.done) || 0, total: Number(value?.total) || 0,
    message: typeof value?.message === 'string' ? value.message : '',
  } });
}
function snapshot() {
  return archive ? {
    opened: true, path: archive.path, entries: archive.entries.map(entry => ({
      id: entry.id, name: String(entry.name ?? ''), size: Number(entry.size) || 0,
      packedSize: Number(entry.packedSize) || 0,
    })),
    staged: Array.from(staged.keys()),
  } : { opened: false, entries: [], staged: [] };
}
function rememberPreviewSource(uri, source) {
  if (typeof uri !== 'string' || uri.length > 8192) throw new Error('Invalid preview document identity.');
  previewSources.delete(uri);
  previewSources.set(uri, source);
  while (previewSources.size > 256) previewSources.delete(previewSources.keys().next().value);
}
function clearPreviewBuffers() {
  previewBuffers.clear();
  previewBufferBytes = 0;
}
function cachePreviewBuffer(uri, source, buffer) {
  clearCachedPreviewBuffer(uri);
  if (buffer.length > PREVIEW_CACHE_BYTES) return;
  while (previewBufferBytes + buffer.length > PREVIEW_CACHE_BYTES && previewBuffers.size) {
    const oldestKey = previewBuffers.keys().next().value;
    clearCachedPreviewBuffer(oldestKey);
  }
  previewBuffers.set(uri, { ...source, buffer });
  previewBufferBytes += buffer.length;
}
function clearCachedPreviewBuffer(uri) {
  const cached = previewBuffers.get(uri);
  if (!cached) return;
  previewBufferBytes -= cached.buffer.length;
  previewBuffers.delete(uri);
}
function getCachedPreviewBuffer(uri) {
  const cached = previewBuffers.get(uri);
  if (!cached) return null;
  previewBuffers.delete(uri);
  previewBuffers.set(uri, cached);
  return cached;
}
async function assertArchiveFingerprint() {
  let current;
  try { current = await fs.stat(archive.path, { bigint: true }); }
  catch (error) {
    clearPreviewBuffers();
    throw new Error(`Source package is unavailable; reopen the package before previewing (${error.message}).`);
  }
  const original = archive._fingerprint;
  if (current.dev !== original.dev || current.ino !== original.ino || current.size !== original.size ||
      current.mtimeNs !== original.mtimeNs || current.ctimeNs !== original.ctimeNs) {
    clearPreviewBuffers();
    throw new Error('Source package changed after it was opened; reopen the package before previewing.');
  }
}
async function removeTemporary(id) {
  const filePath = temporaryFiles.get(String(id));
  temporaryFiles.delete(String(id));
  if (filePath) await fs.unlink(filePath).catch(() => {});
}
async function cleanup() {
  if (temporaryRoot) await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  temporaryRoot = undefined;
  temporaryFiles.clear();
}
function normalized(name) {
  const value = String(name ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!value || value.split('/').some(part => !part || part === '.' || part === '..')) return null;
  return value;
}
async function regularFile(filePath) {
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Replacement must be a regular file, not a symbolic link.');
  return stat;
}
async function scan(root) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Choose a real folder without symbolic links.');
  const files = new Map();
  async function visit(dir, relative) {
    for (const child of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, child.name);
      const childStat = await fs.lstat(full);
      if (childStat.isSymbolicLink()) throw new Error(`Folder contains a symbolic link: ${relative}${child.name}`);
      const rel = relative ? `${relative}/${child.name}` : child.name;
      if (childStat.isDirectory()) await visit(full, rel);
      else if (childStat.isFile()) files.set(rel.replace(/\\/g, '/'), full);
      else throw new Error(`Folder contains a non-file entry: ${rel}`);
    }
  }
  await visit(root, '');
  return files;
}
async function dispatch(method, args, requestId) {
  if (method === 'open') {
    archive = await pkg.openArchive(args.path);
    archiveMountId = String(args.mountId || '');
    staged.clear();
    previewSources.clear();
    clearPreviewBuffers();
    await cleanup();
    return snapshot();
  }
  if (method === 'shutdown') { await cleanup(); return { stopped: true }; }
  if (method === 'previewBytes') {
    const bytes = Buffer.from(args.bytes || []);
    const result = await preview.makePreview(bytes, String(args.name || ''), { frameIndex: 0 });
    const source = { kind: 'external', name: String(args.name || ''), fingerprint: String(args.fingerprint || '') };
    rememberPreviewSource(args.documentUri, source);
    if (result.kind === 'animation') cachePreviewBuffer(args.documentUri, source, bytes);
    return result;
  }
  if (method === 'previewFrame') {
    if (!Number.isSafeInteger(args.frameIndex) || args.frameIndex < 0) throw new Error('Invalid animation frame index.');
    const source = args.source || {};
    const documentUri = String(source.documentUri || '');
    const remembered = previewSources.get(documentUri);
    if (!remembered) throw new Error('Preview document is no longer active.');
    if (source.kind === 'archive') {
      if (remembered.kind !== 'archive' || source.mountId !== archiveMountId ||
          remembered.entryId !== source.entryId || remembered.mountId !== source.mountId) {
        throw new Error('Animation request does not match the open package document.');
      }
      const entry = entryFor(source.entryId);
      let cached = getCachedPreviewBuffer(documentUri);
      let bytes;
      if (cached && cached.kind === 'archive' && cached.mountId === source.mountId && cached.entryId === source.entryId) {
        await assertArchiveFingerprint();
        bytes = cached.buffer;
      } else {
        bytes = await pkg.readEntry(archive, entry.id, { maxBytes: 67108864 });
      }
      const result = await preview.makePreview(bytes, entry.name, { frameIndex: args.frameIndex });
      if (result.kind === 'animation') cachePreviewBuffer(documentUri, remembered, bytes);
      return result;
    }
    if (source.kind === 'external') {
      if (remembered.kind !== 'external' || remembered.name !== String(args.name || '')) {
        throw new Error('Animation request does not match the open preview document.');
      }
      const fingerprint = String(args.fingerprint || '');
      let cached = getCachedPreviewBuffer(documentUri);
      let bytes;
      if (cached && cached.kind === 'external' && cached.fingerprint === fingerprint && fingerprint === remembered.fingerprint) {
        bytes = cached.buffer;
      } else if (args.bytes !== undefined) {
        bytes = Buffer.from(args.bytes);
        if (bytes.length > 67108864) throw new Error('File exceeds the 64 MiB preview limit.');
        remembered.fingerprint = fingerprint;
      } else {
        return { needSource: true };
      }
      const result = await preview.makePreview(bytes, remembered.name, { frameIndex: args.frameIndex });
      if (result.kind === 'animation') cachePreviewBuffer(documentUri, remembered, bytes);
      return result;
    }
    throw new Error('Invalid animation source.');
  }
  requireArchive();
  if (method === 'snapshot') return snapshot();
  if (method === 'read') return pkg.readEntry(archive, Number(args.id), { maxBytes: 67108864 });
  if (method === 'preview') {
    const entry = entryFor(args.id);
    const bytes = await pkg.readEntry(archive, entry.id, { maxBytes: 67108864 });
    const result = await preview.makePreview(bytes, entry.name, { frameIndex: 0 });
    const source = { kind: 'archive', mountId: archiveMountId, entryId: entry.id };
    rememberPreviewSource(args.documentUri, source);
    if (result.kind === 'animation') cachePreviewBuffer(args.documentUri, source, bytes);
    return result;
  }
  if (method === 'replace') {
    const entry = entryFor(args.id);
    await regularFile(args.path);
    await removeTemporary(entry.id);
    staged.set(String(entry.id), args.path);
    return snapshot();
  }
  if (method === 'replaceFolder') {
    const folder = normalized(args.folder || '');
    if (args.folder && !folder) throw new Error('Invalid package folder path.');
    const files = await scan(args.path);
    const prefix = folder ? `${folder}/` : '';
    const candidates = archive.entries.filter(entry => {
      const name = normalized(entry.name);
      return name && name.startsWith(prefix) && files.has(name.slice(prefix.length));
    });
    let changed = 0;
    let unchanged = 0;
    let done = 0;
    const updates = [];
    for (const entry of candidates) {
      const name = normalized(entry.name);
      const candidate = files.get(name.slice(prefix.length));
      const stat = await regularFile(candidate);
      let same = false;
      if (stat.size === entry.size) {
        if (stat.size > 67108864) throw new Error(`Cannot compare same-size resource over 64 MiB: ${entry.name}`);
        same = (await pkg.readEntry(archive, entry.id, { maxBytes: 67108864 })).equals(await fs.readFile(candidate));
      }
      if (same) { unchanged += 1; updates.push([String(entry.id), null]); }
      else { changed += 1; updates.push([String(entry.id), candidate]); }
      done += 1;
      progress(requestId, { done, total: candidates.length, message: `Comparing replacements ${done}/${candidates.length}` });
    }
    for (const [id, filePath] of updates) {
      await removeTemporary(id);
      filePath ? staged.set(id, filePath) : staged.delete(id);
    }
    return { matched: candidates.length, changed, unchanged, staged: snapshot().staged };
  }
  if (method === 'clear') { await removeTemporary(args.id); staged.delete(String(args.id)); return snapshot(); }
  if (method === 'clearFolder') {
    const folder = normalized(args.folder || '');
    const prefix = folder ? `${folder}/` : '';
    for (const id of Array.from(staged.keys())) {
      const entry = entryFor(id);
      const name = normalized(entry.name);
      if (!folder || name?.startsWith(prefix)) { await removeTemporary(id); staged.delete(id); }
    }
    return snapshot();
  }
  if (method === 'exportFolder') {
    const folder = normalized(args.folder || '');
    const prefix = folder ? `${folder}/` : '';
    const ids = archive.entries.filter(entry => {
      const name = normalized(entry.name);
      return name && (folder ? name.startsWith(prefix) : true);
    }).map(entry => entry.id);
    return pkg.exportEntries(archive, ids, args.directory, value => progress(requestId, value));
  }
  if (method === 'exportPng') {
    const entry = entryFor(args.id);
    return preview.exportEditable(await pkg.readEntry(archive, entry.id, { maxBytes: 67108864 }), entry.name);
  }
  if (method === 'importPng') {
    const entry = entryFor(args.id);
    const stat = await regularFile(args.path);
    if (stat.size > 67108864) throw new Error('PNG exceeds the 64 MiB import limit.');
    const original = await pkg.readEntry(archive, entry.id, { maxBytes: 67108864 });
    const converted = await preview.importEditable(original, await fs.readFile(args.path), entry.name);
    if (!temporaryRoot) temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fantasy-pkg-studio-'));
    const output = path.join(temporaryRoot, `gsa-${entry.id}-${Date.now()}.bin`);
    await fs.writeFile(output, converted, { flag: 'wx', mode: 0o600 });
    await removeTemporary(entry.id);
    temporaryFiles.set(String(entry.id), output);
    staged.set(String(entry.id), output);
    return snapshot();
  }
  if (method === 'repack') {
    const replacements = Object.fromEntries(staged);
    return pkg.repack(archive, replacements, args.path, value => progress(requestId, value));
  }
  throw new Error(`Unknown package operation: ${method}`);
}

parentPort.on('message', message => {
  queue = queue.then(async () => {
    try {
      const result = message.method === 'shutdown' ? await cleanup() : await dispatch(message.method, message.args || {}, message.requestId);
      parentPort.postMessage({ requestId: message.requestId, result });
    } catch (error) {
      parentPort.postMessage({ requestId: message.requestId, error: error?.message || String(error) });
    }
  });
});

parentPort.on('close', () => { cleanup().catch(() => {}); });
