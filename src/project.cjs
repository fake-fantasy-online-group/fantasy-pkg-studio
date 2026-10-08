'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const pkg = require('./pkg.cjs');

const FORMAT = 'fantasy-pkg-project';
const VERSION = 1;
const SOURCE_FILE = '.pkg-studio/source.pkg';
const TABLE_SCHEMA_FILE = 'table-schema.bin';
const TABLE_SCHEMA_MAGIC = Buffer.from([0x55, 0x44, 0x67, 0x00]);
const MAX_TABLE_SCHEMA_BYTES = 8 * 1024 * 1024;
const RESOURCE_PREFIX = 'resources/';
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_U32 = 0xffffffff;
const HASH_RE = /^[a-f0-9]{64}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

function fail(message, code = 'PROJECT_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function conflict(message) {
  fail(`PROJECT_CONFLICT:${message}`, 'PROJECT_CONFLICT');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function fingerprint(stat) {
  return {
    dev: stat.dev, ino: stat.ino, size: stat.size,
    mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
  };
}

function sameFingerprint(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function openRegular(filePath, label) {
  const resolved = path.resolve(filePath);
  const before = await fsp.lstat(resolved, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) fail(`${label} 必须是普通文件且不能是符号链接：${resolved}`);
  const handle = await fsp.open(resolved, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameFingerprint(fingerprint(before), fingerprint(after))) {
      fail(`${label} 在打开期间发生变化：${resolved}`);
    }
    return { path: resolved, handle, stat: fingerprint(after) };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

async function hashRegularFile(filePath, label = '文件') {
  const opened = await openRegular(filePath, label);
  const hash = crypto.createHash('sha256');
  try {
    for await (const chunk of opened.handle.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
    const after = fingerprint(await opened.handle.stat({ bigint: true }));
    if (!sameFingerprint(opened.stat, after)) fail(`${label} 在读取期间发生变化：${opened.path}`);
    return { sha256: hash.digest('hex'), size: Number(after.size), fingerprint: after };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function statRegularFile(filePath, label) {
  const opened = await openRegular(filePath, label);
  await opened.handle.close();
  return opened.stat;
}

async function readRegularFile(filePath, maxBytes, label) {
  const opened = await openRegular(filePath, label);
  try {
    if (opened.stat.size > BigInt(maxBytes)) fail(`${label} 超过 ${maxBytes} 字节读取上限`);
    const data = await opened.handle.readFile();
    const after = fingerprint(await opened.handle.stat({ bigint: true }));
    if (!sameFingerprint(opened.stat, after) || BigInt(data.length) !== after.size) {
      fail(`${label} 在读取期间发生变化：${opened.path}`);
    }
    return { data, fingerprint: after };
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

function safeSegments(name) {
  if (typeof name !== 'string' || !name || name.includes('\0')) fail('PKG 条目名称为空或无效');
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) fail(`PKG 条目路径不能是绝对路径：${name}`);
  const segments = normalized.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) fail(`PKG 条目路径包含穿越或空路径段：${name}`);
  if (segments.some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    fail(`PKG 条目名称不能安全地保存为工程文件：${name}`);
  }
  return segments;
}

function collisionKey(segments) {
  return segments.join('/').normalize('NFC').toLocaleLowerCase('en-US');
}

function validateArchiveNames(entries) {
  const paths = new Map();
  for (const entry of entries) {
    const segments = safeSegments(entry.name);
    for (let index = 0; index < segments.length; index++) {
      const prefix = segments.slice(0, index + 1);
      const key = collisionKey(prefix);
      const relative = prefix.join('/');
      const kind = index === segments.length - 1 ? 'file' : 'directory';
      const previous = paths.get(key);
      if (previous && (previous.path !== relative || previous.kind !== kind)) {
        fail(`PKG 条目存在大小写、Unicode 或文件目录冲突：${entry.name}`);
      }
      paths.set(key, { path: relative, kind });
    }
  }
}

function expectedResourceName(entry) {
  return `${RESOURCE_PREFIX}${safeSegments(entry.name).join('/')}`;
}

async function assertDirectory(directory, label) {
  const stat = await fsp.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} 必须是普通目录且不能是符号链接：${directory}`);
  return stat;
}

async function tableSchemaPath(project) {
  await assertDirectory(project.directory, '工程根目录');
  const expectedRoot = path.join(path.resolve(project.directory), '.pkg-studio');
  if (path.resolve(project.hiddenRoot) !== expectedRoot) fail('工程内部目录路径无效');
  await assertDirectory(expectedRoot, '工程内部目录');
  const filePath = path.join(expectedRoot, TABLE_SCHEMA_FILE);
  if (path.dirname(filePath) !== expectedRoot) fail('工程表结构路径无效');
  return filePath;
}

async function validateOptionalTableSchema(projectRoot) {
  const filePath = path.join(projectRoot, '.pkg-studio', TABLE_SCHEMA_FILE);
  try {
    const stat = await fsp.lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`工程导入的表结构必须是普通文件且不能是符号链接：${filePath}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function scanTree(root, label) {
  const files = new Map();
  const directories = new Set(['']);
  async function visit(directory, relative) {
    const children = await fsp.readdir(directory, { withFileTypes: true });
    for (const child of children) {
      const full = path.join(directory, child.name);
      const stat = await fsp.lstat(full, { bigint: true });
      if (stat.isSymbolicLink()) fail(`${label} 包含符号链接：${full}`);
      const rel = relative ? `${relative}/${child.name}` : child.name;
      if (stat.isDirectory()) {
        directories.add(rel);
        await visit(full, rel);
      } else if (stat.isFile()) {
        files.set(rel, full);
      } else {
        fail(`${label} 包含非普通文件或目录：${full}`);
      }
    }
  }
  await visit(root, '');
  return { files, directories };
}

function assertSafeTreeNames(relativePaths) {
  const seen = new Map();
  for (const relative of relativePaths) {
    const segments = safeSegments(relative);
    for (let index = 0; index < segments.length; index++) {
      const prefix = segments.slice(0, index + 1);
      const key = collisionKey(prefix);
      const full = prefix.join('/');
      const kind = index === segments.length - 1 ? 'file' : 'directory';
      const prior = seen.get(key);
      if (prior && (prior.path !== full || prior.kind !== kind)) fail(`工程资源存在大小写、Unicode 或文件目录冲突：${relative}`);
      seen.set(key, { path: full, kind });
    }
  }
}

async function ensureProjectPath(project, entry) {
  await assertDirectory(project.directory, '工程根目录');
  await assertDirectory(project.resourcesRoot, 'resources 目录');
  const metadata = project.entriesById.get(String(entry.id));
  if (!metadata) fail(`工程元信息缺少条目 ${entry.id}`);
  if (metadata.file !== expectedResourceName(entry)) fail(`工程资源路径与 PKG 条目不一致：${entry.name}`);
  const segments = safeSegments(metadata.file.slice(RESOURCE_PREFIX.length));
  let current = project.resourcesRoot;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    await assertDirectory(current, '工程资源父目录');
  }
  const filePath = path.join(current, segments[segments.length - 1]);
  const stat = await fsp.lstat(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`工程资源必须是普通文件且不能是符号链接：${metadata.file}`);
  return filePath;
}

async function hashResource(project, entry) {
  const filePath = await ensureProjectPath(project, entry);
  return hashRegularFile(filePath, `工程资源 ${entry.name}`);
}

async function readResource(project, entry, maxBytes = MAX_ENTRY_BYTES) {
  const filePath = await ensureProjectPath(project, entry);
  return (await readRegularFile(filePath, maxBytes, `工程资源 ${entry.name}`)).data;
}

async function scanProjectResources(project) {
  await assertDirectory(project.directory, '工程根目录');
  await assertDirectory(project.resourcesRoot, 'resources 目录');
  const tree = await scanTree(project.resourcesRoot, 'resources');
  const actualNames = [...tree.files.keys()];
  const expectedNames = new Set(project.archive.entries.map((entry) => expectedResourceName(entry).slice(RESOURCE_PREFIX.length)));
  for (const name of expectedNames) if (!tree.files.has(name)) fail(`resources 缺少已登记资源：${name}`);
  return tree;
}

function entryFor(project, id) {
  if (!Number.isSafeInteger(Number(id)) || !/^(0|[1-9][0-9]*)$/.test(String(id))) fail('工程条目标识无效');
  const entry = project.archive.entries[Number(id)];
  if (!entry || entry.id !== Number(id)) fail(`工程中找不到条目 ${id}`);
  return entry;
}

async function loadProject(directory, onProgress) {
  const projectPath = path.resolve(directory);
  await assertDirectory(projectPath, '工程根目录');
  const items = new Set(await fsp.readdir(projectPath));
  if (!items.has('pkg-studio.json') || !items.has('.pkg-studio') || !items.has('resources')) {
    fail('工程目录结构无效；需要 pkg-studio.json、.pkg-studio 和 resources');
  }
  for (const item of items) {
    if (['pkg-studio.json', '.pkg-studio', 'resources'].includes(item)) continue;
    const stat = await fsp.lstat(path.join(projectPath, item), { bigint: true });
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) fail(`工程包含符号链接或非普通项目文件：${item}`);
    if (stat.isDirectory()) await scanTree(path.join(projectPath, item), `工程目录 ${item}`);
  }
  const metadataPath = path.join(projectPath, 'pkg-studio.json');
  const metadataFile = await readRegularFile(metadataPath, 16 * 1024 * 1024, '工程元信息');
  let metadata;
  try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataFile.data)); }
  catch (_) { fail('工程元信息不是有效 JSON'); }
  if (metadata?.format !== FORMAT) fail('所选目录不是 Fantasy PKG Studio 工程');
  if (metadata?.version !== VERSION) fail(`不支持的工程版本 ${String(metadata?.version)}`);
  if (typeof metadata.name !== 'string' || !metadata.name || typeof metadata.createdAt !== 'string' || !Number.isFinite(Date.parse(metadata.createdAt))) {
    fail('工程名称或创建时间无效');
  }
  if (metadata.source?.file !== SOURCE_FILE || typeof metadata.source?.originalName !== 'string' || !HASH_RE.test(metadata.source?.sha256 || '')) {
    fail('工程源 PKG 元信息无效');
  }
  if (!Array.isArray(metadata.entries) || metadata.entries.length > 0xffffffff) fail('工程条目清单无效');

  const hiddenRoot = path.join(projectPath, '.pkg-studio');
  await assertDirectory(hiddenRoot, '工程内部目录');
  const hiddenItems = await fsp.readdir(hiddenRoot);
  if (!hiddenItems.includes('source.pkg') ||
      hiddenItems.some((item) => item !== 'source.pkg' && item !== TABLE_SCHEMA_FILE)) {
    fail('工程内部目录只能包含 source.pkg 和可选的 table-schema.bin');
  }
  await validateOptionalTableSchema(projectPath);
  const sourcePath = path.join(hiddenRoot, 'source.pkg');
  const sourceResult = await hashRegularFile(sourcePath, '工程源 PKG');
  if (sourceResult.sha256 !== metadata.source.sha256) fail('工程源 PKG 的 SHA-256 与工程元信息不匹配');
  const archive = await pkg.openArchive(sourcePath);
  if (!sameFingerprint(sourceResult.fingerprint, archive._fingerprint)) fail('工程源 PKG 在解析期间发生变化');
  if (archive.entries.length !== metadata.entries.length) fail('工程条目数量与源 PKG 不一致');
  validateArchiveNames(archive.entries);

  const entriesById = new Map();
  const recordsById = new Map();
  for (const record of metadata.entries) {
    if (!record || !Number.isSafeInteger(record.id) || recordsById.has(String(record.id))) fail('工程条目清单含无效或重复标识');
    recordsById.set(String(record.id), record);
  }
  for (const entry of archive.entries) {
    const record = recordsById.get(String(entry.id));
    if (!record || record.id !== entry.id || record.name !== entry.name || record.file !== expectedResourceName(entry) ||
        !HASH_RE.test(record.sha256 || '') || !Number.isSafeInteger(record.size) || record.size !== entry.size) {
      fail(`工程元信息中的条目 ${entry.id} 与源 PKG 不一致`);
    }
    const original = await pkg.readEntry(archive, entry.id, { maxBytes: MAX_ENTRY_BYTES });
    if (sha256(original) !== record.sha256) fail(`工程基线哈希与源 PKG 条目不一致：${entry.name}`);
    entriesById.set(String(entry.id), record);
    onProgress?.({ done: entry.id + 1, total: archive.entries.length, message: `校验工程基线 ${entry.id + 1}/${archive.entries.length}` });
  }

  const project = {
    directory: projectPath,
    resourcesRoot: path.join(projectPath, 'resources'),
    hiddenRoot,
    metadataPath,
    metadata,
    archive,
    entriesById,
    hashCache: new Map(),
    metadataFingerprint: metadataFile.fingerprint,
    sourceFingerprint: sourceResult.fingerprint,
  };
  await assertDirectory(project.resourcesRoot, 'resources 目录');
  const tree = await scanProjectResources(project);
  for (const entry of archive.entries) {
    const relative = entriesById.get(String(entry.id)).file.slice(RESOURCE_PREFIX.length);
    const actual = await hashRegularFile(tree.files.get(relative), `工程资源 ${entry.name}`);
    project.hashCache.set(String(entry.id), {
      cacheKey: `${actual.fingerprint.dev}:${actual.fingerprint.ino}:${actual.fingerprint.size}:${actual.fingerprint.mtimeNs}:${actual.fingerprint.ctimeNs}`,
      sha256: actual.sha256,
      size: actual.size,
    });
  }
  return project;
}

async function createProject(pkgPath, newDirectory, onProgress) {
  const source = path.resolve(pkgPath);
  const target = path.resolve(newDirectory);
  const parent = path.dirname(target);
  await assertDirectory(parent, '工程父目录');
  try {
    await fsp.lstat(target);
    fail(`工程目录必须不存在：${target}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceOriginal = await hashRegularFile(source, '原始 PKG');
  const sourceInput = await openRegular(source, '原始 PKG');
  await sourceInput.handle.close();
  const tempRoot = await fsp.mkdtemp(path.join(parent, `.${path.basename(target)}.pkg-studio-`));
  const sourceCopy = path.join(tempRoot, SOURCE_FILE);
  let published = false;
  try {
    await fsp.mkdir(path.dirname(sourceCopy), { recursive: false });
    await fsp.mkdir(path.join(tempRoot, 'resources'), { recursive: false });
    await fsp.copyFile(source, sourceCopy, fs.constants.COPYFILE_EXCL);
    await fsp.chmod(sourceCopy, 0o444);
    const sourceCopyHash = await hashRegularFile(sourceCopy, '工程源 PKG 副本');
    const sourceAfter = await hashRegularFile(source, '原始 PKG');
    if (sourceCopyHash.sha256 !== sourceOriginal.sha256 || sourceAfter.sha256 !== sourceOriginal.sha256 ||
        !sameFingerprint(sourceAfter.fingerprint, sourceOriginal.fingerprint)) {
      fail('原始 PKG 在复制到工程期间发生变化');
    }
    const archive = await pkg.openArchive(sourceCopy);
    validateArchiveNames(archive.entries);
    const exportRoot = path.join(tempRoot, 'resources');
    await pkg.exportEntries(archive, archive.entries.map((entry) => entry.id), exportRoot, (value) => onProgress?.(value));
    const records = [];
    for (const entry of archive.entries) {
      const file = expectedResourceName(entry);
      const resourcePath = path.join(exportRoot, ...safeSegments(file.slice(RESOURCE_PREFIX.length)));
      const actual = await hashRegularFile(resourcePath, `导出资源 ${entry.name}`);
      records.push({ id: entry.id, name: entry.name, file, sha256: actual.sha256, size: actual.size });
    }
    const metadata = {
      format: FORMAT,
      version: VERSION,
      name: path.basename(target),
      createdAt: new Date().toISOString(),
      source: { file: SOURCE_FILE, originalName: path.basename(source), sha256: sourceCopyHash.sha256 },
      entries: records,
    };
    await fsp.writeFile(path.join(tempRoot, 'pkg-studio.json'), `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await fsp.lstat(target);
      fail(`工程目录必须不存在：${target}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const project = await loadProject(tempRoot, onProgress);
    await fsp.rename(tempRoot, target);
    published = true;
    project.directory = target;
    project.resourcesRoot = path.join(target, 'resources');
    project.hiddenRoot = path.join(target, '.pkg-studio');
    project.metadataPath = path.join(target, 'pkg-studio.json');
    project.archive = await pkg.openArchive(path.join(project.hiddenRoot, 'source.pkg'));
    return project;
  } catch (error) {
    if (!published) await fsp.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    else error.message = `工程目录已创建：${target}。重新选择该目录即可打开；本次未切换当前工程。原因：${error.message}`;
    throw error;
  }
}

async function openProject(directory, onProgress) {
  return loadProject(directory, onProgress);
}

async function refreshProject(project, onProgress) {
  await assertDirectory(project.directory, '工程根目录');
  await assertDirectory(project.hiddenRoot, '工程内部目录');
  await assertDirectory(project.resourcesRoot, 'resources 目录');
  const [metadataFingerprint, sourceFingerprint] = await Promise.all([
    statRegularFile(project.metadataPath, '工程元信息'),
    statRegularFile(path.join(project.hiddenRoot, 'source.pkg'), '工程源 PKG'),
  ]);
  if (!sameFingerprint(metadataFingerprint, project.metadataFingerprint) ||
      !sameFingerprint(sourceFingerprint, project.sourceFingerprint)) {
    return loadProject(project.directory, onProgress);
  }
  await stagedSnapshot(project);
  return project;
}

async function readEntry(project, id, maxBytes = MAX_ENTRY_BYTES) {
  return readResource(project, entryFor(project, id), maxBytes);
}

async function importTableSchema(project, sourcePath) {
  const destination = await tableSchemaPath(project);
  const source = await openRegular(sourcePath, '外部表结构文件');
  const temporary = path.join(
    path.dirname(destination),
    `.${TABLE_SCHEMA_FILE}.${crypto.randomBytes(12).toString('hex')}.tmp`,
  );
  let output;
  try {
    if (source.stat.size > BigInt(MAX_TABLE_SCHEMA_BYTES)) {
      fail(`外部表结构超过 ${MAX_TABLE_SCHEMA_BYTES} 字节上限`);
    }
    const data = await source.handle.readFile();
    const sourceAfterRead = fingerprint(await source.handle.stat({ bigint: true }));
    if (!sameFingerprint(source.stat, sourceAfterRead) || BigInt(data.length) !== sourceAfterRead.size) {
      conflict(`外部表结构在读取期间发生变化：${source.path}`);
    }
    if (data.length < TABLE_SCHEMA_MAGIC.length || !data.subarray(0, TABLE_SCHEMA_MAGIC.length).equals(TABLE_SCHEMA_MAGIC)) {
      fail('外部表结构签名无效；预期 UDg\\0');
    }

    try {
      const existing = await fsp.lstat(destination, { bigint: true });
      if (existing.isSymbolicLink() || !existing.isFile()) {
        fail(`工程导入的表结构必须是普通文件且不能是符号链接：${destination}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    output = await fsp.open(temporary, 'wx', 0o600);
    await output.writeFile(data);
    await output.sync();
    await output.close();
    output = null;

    const sourceAfterWrite = fingerprint(await source.handle.stat({ bigint: true }));
    if (!sameFingerprint(source.stat, sourceAfterWrite)) {
      conflict(`外部表结构在复制期间发生变化：${source.path}`);
    }
    await tableSchemaPath(project);
    try {
      const existing = await fsp.lstat(destination, { bigint: true });
      if (existing.isSymbolicLink() || !existing.isFile()) {
        fail(`工程导入的表结构必须是普通文件且不能是符号链接：${destination}`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await fsp.rename(temporary, destination);
    return {
      source: path.basename(source.path),
      storedAs: `.pkg-studio/${TABLE_SCHEMA_FILE}`,
      size: data.length,
      sha256: sha256(data),
    };
  } finally {
    if (output) await output.close().catch(() => {});
    await source.handle.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function readTableSchema(project) {
  const filePath = await tableSchemaPath(project);
  try {
    const { data, fingerprint: sourceFingerprint } = await readRegularFile(
      filePath,
      MAX_TABLE_SCHEMA_BYTES,
      '工程导入的表结构',
    );
    return {
      buffer: data,
      source: `项目导入副本（.pkg-studio/${TABLE_SCHEMA_FILE}）`,
      size: data.length,
      sha256: sha256(data),
      fingerprint: sourceFingerprint,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function clearTableSchema(project) {
  const filePath = await tableSchemaPath(project);
  try {
    const stat = await fsp.lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail(`工程导入的表结构必须是普通文件且不能是符号链接：${filePath}`);
    }
    await fsp.unlink(filePath);
    return { cleared: true, storedAs: `.pkg-studio/${TABLE_SCHEMA_FILE}` };
  } catch (error) {
    if (error.code === 'ENOENT') return { cleared: false, storedAs: `.pkg-studio/${TABLE_SCHEMA_FILE}` };
    throw error;
  }
}

async function hashEntry(project, id) {
  return hashResource(project, entryFor(project, id));
}

async function statEntry(project, id) {
  const entry = entryFor(project, id);
  const filePath = await ensureProjectPath(project, entry);
  const opened = await openRegular(filePath, `工程资源 ${entry.name}`);
  await opened.handle.close();
  return { path: filePath, fingerprint: opened.stat };
}

async function atomicWrite(project, entry, writer, expectedHash) {
  const destination = await ensureProjectPath(project, entry);
  const original = await hashRegularFile(destination, `工程资源 ${entry.name}`);
  if (expectedHash !== undefined && original.sha256 !== expectedHash) conflict(`工程资源已被外部修改：${entry.name}`);
  const temp = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomBytes(10).toString('hex')}.tmp`);
  let output;
  try {
    output = await fsp.open(temp, 'wx', 0o600);
    const result = await writer(output);
    await output.sync();
    await output.close();
    output = null;
    const currentPath = await ensureProjectPath(project, entry);
    const current = await hashRegularFile(currentPath, `工程资源 ${entry.name}`);
    if (current.sha256 !== original.sha256) conflict(`工程资源在写入期间被外部修改：${entry.name}`);
    await fsp.rename(temp, destination);
    return result;
  } finally {
    if (output) await output.close().catch(() => {});
    await fsp.rm(temp, { force: true }).catch(() => {});
  }
}

async function writeBuffer(project, id, buffer, expectedHash) {
  if (!Buffer.isBuffer(buffer)) fail('工程写入内容必须是 Buffer');
  const entry = entryFor(project, id);
  if (buffer.length > MAX_U32) fail(`资源 ${entry.name} 超过 PKG 格式大小上限`);
  const result = await atomicWrite(project, entry, async (handle) => {
    await handle.writeFile(buffer);
    return { sha256: sha256(buffer), size: buffer.length };
  }, expectedHash);
  project.hashCache.delete(String(entry.id));
  return result;
}

async function copyIntoResource(project, id, sourcePath, expectedHash) {
  const entry = entryFor(project, id);
  const source = await openRegular(sourcePath, '替换源文件');
  if (source.stat.size > BigInt(MAX_U32)) {
    await source.handle.close();
    fail(`替换文件超过 PKG 格式大小上限：${sourcePath}`);
  }
  try {
    return await atomicWrite(project, entry, async (output) => {
      const hash = crypto.createHash('sha256');
      let size = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          size += chunk.length;
          if (size > MAX_U32) return callback(new Error('替换文件超过 PKG 格式大小上限'));
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(source.handle.createReadStream({ autoClose: false, start: 0 }), counter,
        output.createWriteStream({ autoClose: false, start: 0 }));
      const after = fingerprint(await source.handle.stat({ bigint: true }));
      if (!sameFingerprint(source.stat, after) || size !== Number(source.stat.size)) conflict(`替换源文件在复制期间发生变化：${sourcePath}`);
      return { sha256: hash.digest('hex'), size };
    }, expectedHash);
  } finally {
    await source.handle.close().catch(() => {});
  }
}

async function replaceFile(project, id, sourcePath) {
  const result = await copyIntoResource(project, id, sourcePath);
  return { sha256: result.sha256, staged: await stagedSnapshot(project) };
}

async function scanInputDirectory(directory) {
  const root = path.resolve(directory);
  await assertDirectory(root, '替换目录');
  const tree = await scanTree(root, '替换目录');
  assertSafeTreeNames([...tree.files.keys()]);
  return tree.files;
}

async function replaceDirectory(project, directory, folderPath = '', onProgress) {
  const files = await scanInputDirectory(directory);
  const folder = folderPath ? safeSegments(folderPath).join('/') : '';
  const selected = new Map();
  for (const entry of project.archive.entries) {
    const resourceName = project.entriesById.get(String(entry.id)).file.slice(RESOURCE_PREFIX.length);
    if (folder) {
      if (!resourceName.startsWith(`${folder}/`)) continue;
      selected.set(resourceName.slice(folder.length + 1), entry);
    } else {
      selected.set(resourceName, entry);
    }
  }
  for (const name of files.keys()) {
    if (!selected.has(name)) fail(`替换目录包含工程中不存在的资源：${name}`);
  }
  let completed = 0;
  let changed = 0;
  const affectedIds = [];
  let failedPath = '';
  let failure;
  for (const [relative, sourcePath] of files) {
    const entry = selected.get(relative);
    failedPath = relative;
    try {
      const before = await hashResource(project, entry);
      const written = await copyIntoResource(project, entry.id, sourcePath, before.sha256);
      if (written.sha256 !== before.sha256) changed++;
      completed++;
      affectedIds.push(entry.id);
      onProgress?.({ done: completed, total: files.size, message: `写入工程资源 ${relative}` });
    } catch (error) {
      failure = error;
      break;
    }
  }
  let staged = [];
  let snapshotError;
  try { staged = await stagedSnapshot(project); } catch (error) { snapshotError = error; }
  if (failure) return { ok: false, matched: files.size, changed, completed, affectedIds, failedPath, error: failure.message, staged, ...(snapshotError ? { snapshotError: snapshotError.message } : {}) };
  if (snapshotError) return { ok: false, matched: files.size, changed, completed, affectedIds, error: snapshotError.message, staged };
  return { matched: files.size, changed, completed, affectedIds, staged };
}

async function resetEntry(project, id) {
  const entry = entryFor(project, id);
  const original = await pkg.readEntry(project.archive, entry.id, { maxBytes: MAX_ENTRY_BYTES });
  await writeBuffer(project, entry.id, original);
  return stagedSnapshot(project);
}

async function resetAll(project, onProgress) {
  let completed = 0;
  let failedId = null;
  const affectedIds = [];
  let failure;
  for (const entry of project.archive.entries) {
    failedId = entry.id;
    try {
      const original = await pkg.readEntry(project.archive, entry.id, { maxBytes: MAX_ENTRY_BYTES });
      await writeBuffer(project, entry.id, original);
      completed++;
      affectedIds.push(entry.id);
      onProgress?.({ done: completed, total: project.archive.entries.length, message: `恢复原始资源 ${entry.name}` });
    } catch (error) {
      failure = error;
      break;
    }
  }
  let staged = [];
  let snapshotError;
  try { staged = await stagedSnapshot(project); } catch (error) { snapshotError = error; }
  if (failure) return { ok: false, completed, affectedIds, failedId, error: failure.message, staged, ...(snapshotError ? { snapshotError: snapshotError.message } : {}) };
  if (snapshotError) return { ok: false, completed, affectedIds, error: snapshotError.message, staged };
  return { completed, affectedIds, staged };
}

async function stagedSnapshot(project) {
  const tree = await scanProjectResources(project);
  const result = [];
  for (const entry of project.archive.entries) {
    const baseline = project.entriesById.get(String(entry.id));
    const relative = baseline.file.slice(RESOURCE_PREFIX.length);
    const filePath = tree.files.get(relative);
    const opened = await openRegular(filePath, `工程资源 ${entry.name}`);
    const cacheKey = `${opened.stat.dev}:${opened.stat.ino}:${opened.stat.size}:${opened.stat.mtimeNs}:${opened.stat.ctimeNs}`;
    let actual = project.hashCache.get(String(entry.id));
    await opened.handle.close();
    if (!actual || actual.cacheKey !== cacheKey) {
      const value = await hashRegularFile(filePath, `工程资源 ${entry.name}`);
      actual = {
        cacheKey: `${value.fingerprint.dev}:${value.fingerprint.ino}:${value.fingerprint.size}:${value.fingerprint.mtimeNs}:${value.fingerprint.ctimeNs}`,
        sha256: value.sha256,
        size: value.size,
      };
      project.hashCache.set(String(entry.id), actual);
    }
    if (actual.sha256 !== baseline.sha256) {
      result.push({ id: entry.id, entryName: entry.name, replacementName: '工程资源', kind: 'project-file', sha256: actual.sha256, size: actual.size });
    }
  }
  return result;
}

async function exportEntries(project, ids, directory, onProgress) {
  if (!Array.isArray(ids)) fail('导出条目标识无效');
  const selected = [];
  const seenIds = new Set();
  for (const id of ids) {
    const entry = entryFor(project, id);
    if (seenIds.has(entry.id)) fail(`重复导出条目标识：${entry.id}`);
    seenIds.add(entry.id);
    selected.push({ entry, segments: safeSegments(entry.name) });
  }
  assertSafeTreeNames(selected.map((item) => item.segments.join('/')));
  const outputRoot = path.resolve(directory);
  await fsp.mkdir(outputRoot, { recursive: true });
  await assertDirectory(outputRoot, '导出目录');
  const written = [];
  try {
    for (let index = 0; index < selected.length; index++) {
      const { entry, segments } = selected[index];
      let current = outputRoot;
      for (const segment of segments.slice(0, -1)) {
        current = path.join(current, segment);
        try { await fsp.mkdir(current); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        await assertDirectory(current, '导出父目录');
      }
      const target = path.join(current, segments[segments.length - 1]);
      const source = await ensureProjectPath(project, entry);
      const sourceHandle = await openRegular(source, `工程资源 ${entry.name}`);
      let output;
      try {
        output = await fsp.open(target, 'wx', 0o600);
        const partial = { id: entry.id, name: entry.name, path: target };
        written.push(partial);
        await pipeline(sourceHandle.handle.createReadStream({ autoClose: false, start: 0 }), output.createWriteStream({ autoClose: false, start: 0 }));
        const after = fingerprint(await sourceHandle.handle.stat({ bigint: true }));
        if (!sameFingerprint(sourceHandle.stat, after)) fail(`工程资源在导出期间发生变化：${entry.name}`);
        await output.close();
        output = null;
      } finally {
        if (output) await output.close().catch(() => {});
        await sourceHandle.handle.close().catch(() => {});
      }
      onProgress?.({ done: index + 1, total: selected.length, message: `导出 ${entry.name}` });
    }
  } catch (error) {
    for (const item of written) await fsp.rm(item.path, { force: true }).catch(() => {});
    throw error;
  }
  return { count: written.length, entries: written };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function canonicalPotentialPath(input) {
  let current = path.resolve(input);
  const suffix = [];
  while (true) {
    try {
      const real = await fsp.realpath(current);
      return path.join(real, ...suffix.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

async function repack(project, outputPath, onProgress) {
  const target = await canonicalPotentialPath(outputPath);
  const realProject = await fsp.realpath(project.directory);
  const sourcePath = await fsp.realpath(project.archive.path);
  if (isWithin(realProject, target)) fail('另存 PKG 不能写入工程目录内部');
  if (target === sourcePath) fail('另存路径不能覆盖工程保留的源 PKG');
  const tree = await scanProjectResources(project);
  const replacements = {};
  const scannedFingerprints = new Map();
  for (const entry of project.archive.entries) {
    const baseline = project.entriesById.get(String(entry.id));
    const resource = tree.files.get(baseline.file.slice(RESOURCE_PREFIX.length));
    const current = await hashRegularFile(resource, `工程资源 ${entry.name}`);
    scannedFingerprints.set(String(entry.id), current.fingerprint);
    if (current.sha256 !== baseline.sha256) replacements[String(entry.id)] = resource;
    onProgress?.({ done: entry.id + 1, total: project.archive.entries.length, message: `扫描工程资源 ${entry.name}` });
  }
  const result = await pkg.repack(project.archive, replacements, target, onProgress);
  try {
    for (const entry of project.archive.entries) {
      const baseline = project.entriesById.get(String(entry.id));
      const resource = tree.files.get(baseline.file.slice(RESOURCE_PREFIX.length));
      const current = await hashRegularFile(resource, `工程资源 ${entry.name}`);
      if (!sameFingerprint(scannedFingerprints.get(String(entry.id)), current.fingerprint)) {
        conflict(`重打包期间工程资源发生外部修改：${entry.name}`);
      }
    }
  } catch (error) {
    await fsp.rm(target, { force: true }).catch(() => {});
    throw error;
  }
  return { count: Number(result?.replaced ?? result?.count ?? result) || 0, pathName: path.basename(target), stagedCount: Object.keys(replacements).length };
}

module.exports = {
  createProject, openProject, refreshProject, readEntry, importTableSchema, readTableSchema, clearTableSchema,
  hashEntry, statEntry, stagedSnapshot,
  writeBuffer, replaceFile, replaceDirectory, resetEntry, resetAll,
  exportEntries, repack, entryFor,
};
