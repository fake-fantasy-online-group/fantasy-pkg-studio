'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { TextDecoder } = require('node:util');

const HEADER_SIZE = 16;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_U32 = 0xffffffff;
const MAGIC_ENC = 1363695685;
const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const SM_GAMMA = 11400714819323198485n;
const SM_MIX1 = 13787848793156543929n;
const SM_MIX2 = 10723151780598845931n;
const U64_MASK = 0xffffffffffffffffn;
const SECRET = Buffer.from([
  0x7c, 0x3d, 0x9a, 0xf1, 0xe0, 0x5b, 0x28, 0xc4,
  0xd6, 0x90, 0x7e, 0x1a, 0x3f, 0x8b, 0x52, 0xc0,
  0xa9, 0x4d, 0x17, 0xe6, 0xb3, 0x82, 0x0f, 0xdc,
  0x5e, 0x19, 0xa7, 0xc4, 0x0d, 0xb6, 0xf2, 0x38,
]);

const gbkDecoder = new TextDecoder('gbk');

function fail(message) {
  throw new Error(`PKG: ${message}`);
}

function checkedU32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_U32) {
    fail(`${label} is outside the unsigned 32-bit range`);
  }
  return value;
}

function deriveSeed(extra) {
  let value = FNV_OFFSET;
  for (const byte of SECRET) value = ((value ^ BigInt(byte)) * FNV_PRIME) & U64_MASK;
  for (const byte of extra) value = ((value ^ BigInt(byte)) * FNV_PRIME) & U64_MASK;
  return value;
}

function fileSeed(name) {
  return deriveSeed(Buffer.from(name.toLowerCase(), 'utf8'));
}

const INDEX_SEED = deriveSeed(Buffer.from('INDEX', 'ascii'));

function xorBuffer(input, initialSeed) {
  const output = Buffer.from(input);
  let seed = initialSeed;
  for (let pos = 0; pos < output.length; pos += 8) {
    seed = (seed + SM_GAMMA) & U64_MASK;
    let mixed = seed;
    mixed = ((mixed ^ (mixed >> 30n)) * SM_MIX1) & U64_MASK;
    mixed = ((mixed ^ (mixed >> 27n)) * SM_MIX2) & U64_MASK;
    mixed ^= mixed >> 31n;
    const count = Math.min(8, output.length - pos);
    for (let i = 0; i < count; i++) output[pos + i] ^= Number((mixed >> BigInt(i * 8)) & 0xffn);
  }
  return output;
}

function xorTransform(initialSeed) {
  let seed = initialSeed;
  let key = Buffer.alloc(0);
  let keyOffset = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      const output = Buffer.from(chunk);
      for (let i = 0; i < output.length; i++) {
        if (keyOffset >= key.length) {
          seed = (seed + SM_GAMMA) & U64_MASK;
          let mixed = seed;
          mixed = ((mixed ^ (mixed >> 30n)) * SM_MIX1) & U64_MASK;
          mixed = ((mixed ^ (mixed >> 27n)) * SM_MIX2) & U64_MASK;
          mixed ^= mixed >> 31n;
          key = Buffer.allocUnsafe(8);
          for (let j = 0; j < 8; j++) key[j] = Number((mixed >> BigInt(j * 8)) & 0xffn);
          keyOffset = 0;
        }
        output[i] ^= key[keyOffset++];
      }
      callback(null, output);
    },
  });
}

function decodeName(bytes) {
  return gbkDecoder.decode(bytes).replace(/\\/g, '/');
}

function u32(buffer, offset, label) {
  if (offset < 0 || offset + 4 > buffer.length) fail(`truncated ${label}`);
  return buffer.readUInt32LE(offset);
}

async function readExact(handle, length, position, label) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(buffer, read, length - read, position + read);
    if (result.bytesRead === 0) fail(`unexpected end of file while reading ${label}`);
    read += result.bytesRead;
  }
  return buffer;
}

async function getFingerprint(filePath) {
  const stat = await fs.stat(filePath, { bigint: true });
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameFingerprint(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function assertUnchanged(archive) {
  const current = await getFingerprint(archive.path);
  if (!sameFingerprint(current, archive._fingerprint)) fail('source archive changed after it was opened');
}

async function openArchive(inputPath) {
  const archivePath = path.resolve(inputPath);
  const stat = await fs.stat(archivePath, { bigint: true });
  if (!stat.isFile()) fail('source path is not a regular file');
  if (stat.size < BigInt(HEADER_SIZE)) fail('file is shorter than the header');
  if (stat.size > BigInt(Number.MAX_SAFE_INTEGER)) fail('file is too large for safe offsets');
  const handle = await fs.open(archivePath, 'r');
  try {
    const header = await readExact(handle, HEADER_SIZE, 0, 'header');
    const magic = header.readUInt32LE(0);
    const count = header.readUInt32LE(4);
    const indexOffset = header.readUInt32LE(8);
    const indexSize = header.readUInt32LE(12);
    const fileSize = Number(stat.size);
    checkedU32(indexOffset, 'index offset');
    checkedU32(indexSize, 'index size');
    if (indexSize > MAX_INDEX_BYTES) fail(`index exceeds the ${MAX_INDEX_BYTES}-byte safety limit`);
    if (indexOffset < HEADER_SIZE || indexOffset + indexSize > fileSize) fail('index range is outside the archive');
    const encodedIndex = await readExact(handle, indexSize, indexOffset, 'index');
    const index = magic === MAGIC_ENC ? xorBuffer(encodedIndex, INDEX_SEED) : encodedIndex;
    const entries = [];
    let cursor = 0;
    for (let id = 0; id < count; id++) {
      if (cursor + 2 > index.length) fail(`index ends before entry ${id}`);
      const nameLength = index.readUInt16LE(cursor);
      const nameStart = cursor + 2;
      const tailStart = nameStart + nameLength;
      const next = tailStart + 16;
      if (next > index.length) fail(`entry ${id} is truncated in the index`);
      const rawName = Buffer.from(index.subarray(nameStart, tailStart));
      const name = decodeName(rawName);
      const offset = u32(index, tailStart + 4, `entry ${id} offset`);
      const size = u32(index, tailStart + 8, `entry ${id} original size`);
      const packedSize = u32(index, tailStart + 12, `entry ${id} packed size`);
      if (offset + packedSize > fileSize) fail(`entry ${id} data range is outside the archive`);
      if (size > MAX_U32 || packedSize > MAX_U32) fail(`entry ${id} size exceeds the format limit`);
      entries.push({
        id,
        name,
        size,
        packedSize,
        offset,
        encrypted: magic === MAGIC_ENC,
        _rawName: rawName,
        _unknown: Buffer.from(index.subarray(tailStart, tailStart + 4)),
        _seed: magic === MAGIC_ENC ? fileSeed(name) : 0n,
      });
      cursor = next;
    }
    const indexTail = Buffer.from(index.subarray(cursor));
    const current = await getFingerprint(archivePath);
    if (!sameFingerprint({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }, current)) {
      fail('source archive changed while its index was being read');
    }
    return {
      path: archivePath,
      entries,
      encrypted: magic === MAGIC_ENC,
      magic,
      indexTail,
      _header: header,
      _indexOffset: indexOffset,
      _fingerprint: current,
    };
  } finally {
    await handle.close();
  }
}

function findEntry(archive, id) {
  if (!Number.isInteger(id) || id < 0 || id >= archive.entries.length || archive.entries[id].id !== id) {
    fail(`unknown entry id ${String(id)}`);
  }
  return archive.entries[id];
}

async function readEntry(archive, id, { maxBytes = MAX_ENTRY_BYTES } = {}) {
  const entry = findEntry(archive, id);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('maxBytes must be a non-negative safe integer');
  if (entry.size > maxBytes) fail(`entry ${id} is ${entry.size} bytes, over the ${maxBytes}-byte read limit`);
  if (entry.packedSize === 0) {
    if (entry.size !== 0) fail(`entry ${id} has no packed data but declares ${entry.size} bytes`);
    await assertUnchanged(archive);
    return Buffer.alloc(0);
  }
  await assertUnchanged(archive);
  const chunks = [];
  let total = 0;
  const sink = new Transform({
    transform(chunk, encoding, callback) {
      total += chunk.length;
      if (total > maxBytes || total > entry.size) return callback(new Error(`entry ${id} exceeds its declared/read size limit`));
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  const source = fsSync.createReadStream(archive.path, {
    start: entry.offset,
    end: entry.offset + entry.packedSize - 1,
  });
  try {
    const stages = [source];
    if (entry.encrypted) stages.push(xorTransform(entry._seed));
    if (entry.packedSize !== entry.size) stages.push(zlib.createInflate());
    stages.push(sink);
    await pipeline(...stages);
  } catch (error) {
    fail(`cannot read entry ${id}: ${error.message}`);
  }
  await assertUnchanged(archive);
  if (total !== entry.size) fail(`entry ${id} produced ${total} bytes; expected ${entry.size}`);
  return Buffer.concat(chunks, total);
}

function safeRelativePath(name) {
  if (typeof name !== 'string' || name.length === 0 || name.includes('\0')) fail('entry has an empty or invalid name');
  const normalized = name.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) fail(`unsafe absolute entry name: ${name}`);
  const segments = normalized.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) fail(`unsafe traversal in entry name: ${name}`);
  if (segments.some((part) => /[<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    fail(`entry name is not safe on Windows: ${name}`);
  }
  return segments;
}

function collisionKey(segments) {
  return segments.join('/').normalize('NFC').toLocaleLowerCase('en-US');
}

async function prepareExportRoot(directory) {
  const target = path.resolve(directory);
  await fs.mkdir(target, { recursive: true });
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('export destination must be a real directory');
  return target;
}

async function ensureSafeParents(root, segments) {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe export path component: ${current}`);
  }
  const output = path.join(root, ...segments);
  try {
    await fs.lstat(output);
    fail(`refusing to overwrite existing export: ${output}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return output;
}

function report(onProgress, done, total, message) {
  if (typeof onProgress === 'function') onProgress({ done, total, message });
}

async function exportEntries(archive, ids, directory, onProgress) {
  if (!Array.isArray(ids)) fail('ids must be an array');
  await assertUnchanged(archive);
  const root = await prepareExportRoot(directory);
  const seenIds = new Set();
  const selected = ids.map((id) => {
    const entry = findEntry(archive, id);
    if (seenIds.has(id)) fail(`duplicate selected id ${id}`);
    seenIds.add(id);
    return { entry, segments: safeRelativePath(entry.name) };
  });
  const seenNames = new Set();
  for (const item of selected) {
    const key = collisionKey(item.segments);
    if (seenNames.has(key)) fail(`selected entries collide on a case-insensitive filesystem: ${item.entry.name}`);
    seenNames.add(key);
  }
  const written = [];
  try {
    for (let i = 0; i < selected.length; i++) {
      const { entry, segments } = selected[i];
      const target = await ensureSafeParents(root, segments);
      const data = await readEntry(archive, entry.id);
      const handle = await fs.open(target, 'wx', 0o600);
      try {
        await handle.writeFile(data);
      } catch (error) {
        await handle.close();
        await fs.rm(target, { force: true });
        throw error;
      }
      await handle.close();
      written.push({ id: entry.id, name: entry.name, path: target });
      report(onProgress, i + 1, selected.length, `Exported ${entry.name}`);
    }
  } catch (error) {
    for (const item of written) await fs.rm(item.path, { force: true }).catch(() => {});
    throw error;
  }
  return { count: written.length, entries: written };
}

async function copyRange(sourceHandle, destinationHandle, offset, length, destinationOffset) {
  const chunkSize = 1024 * 1024;
  let copied = 0;
  while (copied < length) {
    const size = Math.min(chunkSize, length - copied);
    const chunk = await readExact(sourceHandle, size, offset + copied, 'source payload');
    let written = 0;
    while (written < size) {
      const result = await destinationHandle.write(chunk, written, size - written, destinationOffset + copied + written);
      if (result.bytesWritten === 0) fail('could not write output payload');
      written += result.bytesWritten;
    }
    copied += size;
  }
}

async function validateReplacement(filePath, id) {
  const resolved = path.resolve(filePath);
  const before = await fs.lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink()) fail(`replacement for entry ${id} must be a regular non-symlink file`);
  if (before.size > MAX_U32) fail(`replacement for entry ${id} exceeds the unsigned 32-bit size limit`);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const handle = await fs.open(resolved, fs.constants.O_RDONLY | noFollow);
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      fail(`replacement for entry ${id} changed while being opened`);
    }
    return { path: resolved, size: before.size, dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, handle };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function preparePackedReplacement(entry, replacement, tempDir, id) {
  const rawPath = path.join(tempDir, `plain-${id}`);
  const packedPath = path.join(tempDir, `packed-${id}`);
  const rawHandle = await fs.open(rawPath, 'wx', 0o600);
  let rawSize = 0;
  try {
    const sourceStat = await replacement.handle.stat();
    if (sourceStat.size !== replacement.size || sourceStat.dev !== replacement.dev || sourceStat.ino !== replacement.ino || sourceStat.mtimeMs !== replacement.mtimeMs) {
      fail(`replacement for entry ${id} changed before repacking`);
    }
    const input = replacement.handle.createReadStream({ autoClose: false, start: 0 });
    const counter = new Transform({
      transform(chunk, encoding, callback) {
        rawSize += chunk.length;
        if (rawSize > MAX_U32) return callback(new Error('replacement exceeds unsigned 32-bit size'));
        callback(null, chunk);
      },
    });
    await pipeline(input, counter, rawHandle.createWriteStream({ autoClose: false, start: 0 }));
    const afterRead = await replacement.handle.stat();
    if (afterRead.size !== replacement.size || afterRead.mtimeMs !== replacement.mtimeMs || rawSize !== replacement.size) {
      fail(`replacement for entry ${id} changed while being read`);
    }
  } finally {
    await rawHandle.close();
  }
  const useRaw = rawSize === entry.size && rawSize === entry.packedSize;
  const fileInput = fsSync.createReadStream(rawPath);
  const outputStream = fsSync.createWriteStream(packedPath, { flags: 'wx', mode: 0o600 });
  const stages = [fileInput];
  if (!useRaw) stages.push(zlib.createDeflate());
  if (entry.encrypted) stages.push(xorTransform(entry._seed));
  stages.push(outputStream);
  await pipeline(...stages);
  let packedStat = await fs.stat(packedPath);
  let actuallyCompressed = !useRaw;
  // Equal packed/original sizes mean raw bytes to the archive reader.
  if (!useRaw && packedStat.size === rawSize) {
    const fallback = [fsSync.createReadStream(rawPath)];
    if (entry.encrypted) fallback.push(xorTransform(entry._seed));
    fallback.push(fsSync.createWriteStream(packedPath, { flags: 'w', mode: 0o600 }));
    await pipeline(...fallback);
    packedStat = await fs.stat(packedPath);
    actuallyCompressed = false;
  }
  if (packedStat.size > MAX_U32) fail(`compressed replacement for entry ${id} exceeds the unsigned 32-bit size limit`);
  return { path: packedPath, size: rawSize, packedSize: packedStat.size, compressed: actuallyCompressed };
}

async function linkExclusive(tempPath, outputPath) {
  await fs.link(tempPath, outputPath);
}

async function repack(archive, replacements, output, onProgress) {
  if (!replacements || typeof replacements !== 'object' || Array.isArray(replacements)) fail('replacements must be an object mapping entry ids to local files');
  const outputPath = path.resolve(output);
  if (outputPath === archive.path) fail('output path must not overwrite the source archive');
  const replacementIds = Object.keys(replacements).map((key) => {
    if (!/^(0|[1-9][0-9]*)$/.test(key) || !Number.isSafeInteger(Number(key))) fail(`invalid replacement id ${key}`);
    return Number(key);
  });
  const replacementEntries = new Map();
  for (const id of replacementIds) replacementEntries.set(id, findEntry(archive, id));
  await assertUnchanged(archive);
  try {
    await fs.lstat(outputPath);
    fail('refusing to overwrite an existing output path');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let tempDir;
  const prepared = new Map();
  let tempOutput;

  async function ensureTempDir() {
    if (!tempDir) {
      const outputDirectory = path.dirname(outputPath);
      await fs.mkdir(outputDirectory, { recursive: true });
      tempDir = await fs.mkdtemp(path.join(outputDirectory, '.pkg-repack-'));
    }
    return tempDir;
  }

  try {
    for (let i = 0; i < replacementIds.length; i++) {
      const id = replacementIds[i];
      const replacement = await validateReplacement(replacements[String(id)], id);
      try {
        prepared.set(id, await preparePackedReplacement(replacementEntries.get(id), replacement, await ensureTempDir(), id));
      } finally {
        await replacement.handle.close().catch(() => {});
      }
      report(onProgress, i + 1, replacementIds.length, `Prepared replacement ${replacementEntries.get(id).name}`);
    }

    let projectedEnd = HEADER_SIZE;
    let projectedIndexSize = archive.indexTail.length;
    for (const entry of archive.entries) {
      const change = prepared.get(entry.id);
      const packedSize = change ? change.packedSize : entry.packedSize;
      projectedEnd += packedSize;
      checkedU32(projectedEnd, 'output payload end');
      projectedIndexSize += 2 + entry._rawName.length + 16;
      checkedU32(projectedIndexSize, 'output index size');
    }
    const projectedIndexOffset = checkedU32(projectedEnd, 'output index offset');
    checkedU32(projectedIndexOffset + projectedIndexSize, 'output file end');
    if (projectedIndexSize > MAX_INDEX_BYTES) fail(`output index exceeds the ${MAX_INDEX_BYTES}-byte safety limit`);

    await ensureTempDir();
    const outputName = `archive-${crypto.randomBytes(12).toString('hex')}.tmp`;
    tempOutput = path.join(tempDir, outputName);
    const source = await fs.open(archive.path, 'r');
    let destination;
    const updated = [];
    try {
      destination = await fs.open(tempOutput, 'wx', 0o600);
      let cursor = HEADER_SIZE;
      for (let i = 0; i < archive.entries.length; i++) {
        const entry = archive.entries[i];
        const change = prepared.get(entry.id);
        const next = cursor + (change ? change.packedSize : entry.packedSize);
        checkedU32(next, 'output payload end');
        if (change) {
          const packed = await fs.open(change.path, 'r');
          try {
            await copyRange(packed, destination, 0, change.packedSize, cursor);
          } finally {
            await packed.close();
          }
          updated.push({ ...entry, offset: cursor, size: change.size, packedSize: change.packedSize });
          cursor += change.packedSize;
        } else {
          await copyRange(source, destination, entry.offset, entry.packedSize, cursor);
          updated.push({ ...entry, offset: cursor });
          cursor += entry.packedSize;
        }
        report(onProgress, i + 1, archive.entries.length, `Copied ${entry.name}`);
      }

      const indexOffset = checkedU32(cursor, 'output index offset');
      if (indexOffset !== projectedIndexOffset) fail('internal output offset mismatch');
      const records = [];
      let indexSize = archive.indexTail.length;
      for (const entry of updated) {
        const record = Buffer.alloc(2 + entry._rawName.length + 16);
        record.writeUInt16LE(entry._rawName.length, 0);
        entry._rawName.copy(record, 2);
        const tail = 2 + entry._rawName.length;
        entry._unknown.copy(record, tail);
        record.writeUInt32LE(checkedU32(entry.offset, 'entry offset'), tail + 4);
        record.writeUInt32LE(checkedU32(entry.size, 'entry original size'), tail + 8);
        record.writeUInt32LE(checkedU32(entry.packedSize, 'entry packed size'), tail + 12);
        records.push(record);
        indexSize += record.length;
      }
      checkedU32(indexSize, 'output index size');
      if (indexSize > MAX_INDEX_BYTES) fail(`output index exceeds the ${MAX_INDEX_BYTES}-byte safety limit`);
      const plainIndex = Buffer.concat([...records, archive.indexTail], indexSize);
      const encodedIndex = archive.encrypted ? xorBuffer(plainIndex, INDEX_SEED) : plainIndex;
      let position = indexOffset;
      let written = 0;
      while (written < encodedIndex.length) {
        const result = await destination.write(encodedIndex, written, encodedIndex.length - written, position + written);
        if (result.bytesWritten === 0) fail('could not write output index');
        written += result.bytesWritten;
      }
      const header = Buffer.from(archive._header);
      header.writeUInt32LE(checkedU32(updated.length, 'entry count'), 4);
      header.writeUInt32LE(indexOffset, 8);
      header.writeUInt32LE(indexSize, 12);
      let headerWritten = 0;
      while (headerWritten < header.length) {
        const result = await destination.write(header, headerWritten, header.length - headerWritten, headerWritten);
        if (result.bytesWritten === 0) fail('could not write output header');
        headerWritten += result.bytesWritten;
      }
      await destination.sync();
    } finally {
      if (destination) await destination.close();
      await source.close();
    }

    await assertUnchanged(archive);
    await linkExclusive(tempOutput, outputPath);
    tempOutput = undefined;
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
  report(onProgress, archive.entries.length, archive.entries.length, `Created ${outputPath}`);
  return { path: outputPath, count: archive.entries.length, replaced: replacementIds.length };
}

module.exports = { openArchive, readEntry, exportEntries, repack };
