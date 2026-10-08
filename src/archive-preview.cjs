'use strict';

const RAR4_MARK = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const RAR5_MARK = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const RAR13_MARK = Buffer.from([0x52, 0x45, 0x7e, 0x5e]);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 250000;
const MAX_NAME_BYTES = 65535;
const PAGE_SIZE = 100;
const LONG_BLOCK = 0x8000;
const LARGE_FILE = 0x0100;
const UNICODE_NAME = 0x0200;
const FILE_ENCRYPTED = 0x0004;
const DIR_WINDOW_BITS = 0x00e0;

// RAR 1.5–4.x general block layout, flags, FILE_HEAD fields and RAR3 Unicode names:
// https://github.com/bitplane/rar-research/blob/master/doc/RAR15_40_FORMAT_SPECIFICATION.md
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function fail(message) {
  throw new Error(`RAR 目录预览失败：${message}`);
}

function boundedSlice(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > buffer.length || length > buffer.length - offset) {
    fail(`${label}超出文件边界`);
  }
  return buffer.subarray(offset, offset + length);
}

function isPrintableText(value) {
  if (!value) return true;
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point === 0 || (point < 0x20 && point !== 0x09 && point !== 0x0a && point !== 0x0d) ||
        (point >= 0x7f && point <= 0x9f)) return false;
  }
  return true;
}

function decodeLegacyName(bytes) {
  const ascii = bytes.toString('latin1');
  if (bytes.every((byte) => byte < 0x80)) return { name: ascii, encoding: 'ASCII' };
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (isPrintableText(value)) return { name: value, encoding: 'UTF-8' };
  } catch (_) { /* RAR non-Unicode names use the creator's legacy code page. */ }
  // The code page is not stored in the RAR4 header. Keep the bytes visible instead of
  // pretending an arbitrary system code page is UTF-8 or silently corrupting a path.
  return { name: `[legacy-name:${bytes.toString('hex')}]`, encoding: 'raw hex (code page unspecified)' };
}

function decodeCompressedUnicodeName(bytes) {
  const separator = bytes.indexOf(0);
  if (separator <= 0 || separator + 1 >= bytes.length) fail('RAR4 Unicode 文件名结构不完整');
  const fallback = bytes.subarray(0, separator);
  const highByte = bytes[separator + 1];
  const encoded = bytes.subarray(separator + 2);
  let cursor = 0;
  let flagByte = 0;
  let flagBits = 0;
  const units = [];
  const append = (unit) => {
    if (!Number.isInteger(unit) || unit < 0 || unit > 0xffff || units.length >= MAX_NAME_BYTES) {
      fail('RAR4 Unicode 文件名长度或字符超出上限');
    }
    units.push(unit);
  };
  while (cursor < encoded.length) {
    if (flagBits === 0) {
      flagByte = encoded[cursor++];
      flagBits = 8;
    }
    flagBits -= 2;
    const mode = (flagByte >>> flagBits) & 3;
    if (mode === 0) {
      if (cursor >= encoded.length) fail('RAR4 Unicode 文件名缺少字符字节');
      append(encoded[cursor++]);
    } else if (mode === 1) {
      if (cursor >= encoded.length) fail('RAR4 Unicode 文件名缺少字符字节');
      append((highByte << 8) | encoded[cursor++]);
    } else if (mode === 2) {
      if (cursor + 2 > encoded.length) fail('RAR4 Unicode 文件名缺少双字节字符');
      append(encoded[cursor] | (encoded[cursor + 1] << 8));
      cursor += 2;
    } else {
      if (cursor >= encoded.length) fail('RAR4 Unicode 文件名缺少重复长度');
      const lengthByte = encoded[cursor++];
      const corrected = (lengthByte & 0x80) !== 0;
      let correction = 0;
      let runLength = lengthByte + 2;
      if (corrected) {
        runLength = (lengthByte & 0x7f) + 2;
        if (cursor >= encoded.length) fail('RAR4 Unicode 文件名缺少重复修正值');
        correction = encoded[cursor++];
      }
      if (runLength > MAX_NAME_BYTES - units.length) fail('RAR4 Unicode 文件名超出长度上限');
      for (let index = 0; index < runLength; index++) {
        if (units.length >= fallback.length) fail('RAR4 Unicode 文件名重复段超过回退名称');
        const base = fallback[units.length];
        append(corrected ? (highByte << 8) | ((base + correction) & 0xff) : base);
      }
    }
  }
  return { name: String.fromCharCode(...units), encoding: 'RAR4 compressed Unicode' };
}

function decodeFileName(bytes, flags) {
  if (bytes.length === 0 || bytes.length > MAX_NAME_BYTES) fail('RAR4 文件名长度无效');
  if ((flags & UNICODE_NAME) !== 0) {
    const nul = bytes.indexOf(0);
    if (nul < 0) {
      let name;
      try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch (_) { fail('RAR4 Unicode 文件名不是有效 UTF-8'); }
      if (!isPrintableText(name)) fail('RAR4 Unicode 文件名包含控制字符');
      return { name, encoding: 'RAR4 UTF-8' };
    }
    return decodeCompressedUnicodeName(bytes);
  }
  return decodeLegacyName(bytes);
}

function findSignature(buffer) {
  const rar4 = buffer.indexOf(RAR4_MARK);
  const rar5 = buffer.indexOf(RAR5_MARK);
  const rar13 = buffer.indexOf(RAR13_MARK);
  const candidates = [
    rar4 >= 0 ? { offset: rar4, kind: 'rar4' } : null,
    rar5 >= 0 ? { offset: rar5, kind: 'rar5' } : null,
    rar13 >= 0 ? { offset: rar13, kind: 'rar13' } : null,
  ].filter(Boolean).sort((left, right) => left.offset - right.offset);
  return candidates[0] || null;
}

function parseRar4(buffer, signatureOffset, requestedPage) {
  let offset = signatureOffset + RAR4_MARK.length;
  const entries = [];
  let entryCount = 0;
  let sawMainHeader = false;
  let sawEndMarker = false;
  const requestedStart = requestedPage * PAGE_SIZE;
  const requestedEnd = requestedStart + PAGE_SIZE;
  while (offset < buffer.length) {
    if (entryCount > MAX_ENTRIES) fail(`条目数量超过 ${MAX_ENTRIES} 上限`);
    const common = boundedSlice(buffer, offset, 7, 'RAR 块头');
    const type = common[2];
    const flags = common.readUInt16LE(3);
    const headerSize = common.readUInt16LE(5);
    if (headerSize < 7) fail(`块头长度 ${headerSize} 小于最小值`);
    const header = boundedSlice(buffer, offset, headerSize, 'RAR 块头');
    if (type !== 0x76 && type !== 0x79) {
      const expectedCrc = header.readUInt16LE(0);
      const actualCrc = crc32(header.subarray(2)) & 0xffff;
      if (expectedCrc !== actualCrc) fail(`块头 CRC 不匹配，偏移 0x${offset.toString(16)}`);
    }

    if (type === 0x73) {
      if (sawMainHeader || headerSize < 13) fail('RAR 主头重复或不完整');
      sawMainHeader = true;
      if ((flags & 0x0080) !== 0) fail('RAR4 使用加密文件头，未提供密码，不能读取目录');
    }

    if (type === 0x74 || type === 0x7a) {
      const minimumSize = 32 + ((flags & LARGE_FILE) !== 0 ? 8 : 0);
      if (headerSize < minimumSize) fail('RAR 文件头短于固定字段');
      const packedLow = header.readUInt32LE(7);
      const unpackedLow = header.readUInt32LE(11);
      const large = (flags & LARGE_FILE) !== 0;
      const packedHigh = large ? header.readUInt32LE(32) : 0;
      const unpackedHigh = large ? header.readUInt32LE(36) : 0;
      const packedSize = (BigInt(packedHigh) << 32n) | BigInt(packedLow);
      const unpackedSize = (BigInt(unpackedHigh) << 32n) | BigInt(unpackedLow);
      const nameOffset = large ? 40 : 32;
      if (headerSize < nameOffset || headerSize < 28) fail('RAR 文件名长度字段缺失');
      const nameSize = header.readUInt16LE(26);
      if (nameSize <= 0 || nameSize > MAX_NAME_BYTES || nameSize > headerSize - nameOffset) {
        fail('RAR 文件名字段越过块头边界');
      }
      const decoded = decodeFileName(header.subarray(nameOffset, nameOffset + nameSize), flags);
      const hostOs = header[15];
      const attributes = header.readUInt32LE(28);
      const directory = (flags & DIR_WINDOW_BITS) === DIR_WINDOW_BITS ||
        (hostOs <= 2 && (attributes & 0x10) !== 0) ||
        (hostOs >= 3 && (attributes & 0xf000) === 0x4000);
      const encrypted = (flags & FILE_ENCRYPTED) !== 0;
      if (type === 0x74) {
        if (entryCount >= MAX_ENTRIES) fail(`条目数量超过 ${MAX_ENTRIES} 上限`);
        if (entryCount >= requestedStart && entryCount < requestedEnd) {
          entries.push({
            path: decoded.name.replace(/\\/g, '/'),
            nameEncoding: decoded.encoding,
            kind: directory ? 'dir' : 'file',
            packedSize: packedSize.toString(),
            unpackedSize: unpackedSize.toString(),
            encrypted,
          });
        }
        entryCount++;
      }
      const blockLength = BigInt(headerSize) + packedSize;
      if (blockLength > BigInt(buffer.length - offset)) fail('RAR 文件数据块越过文件边界');
      offset += Number(blockLength);
      continue;
    }

    if (type === 0x7b) {
      if ((flags & LONG_BLOCK) !== 0 && headerSize < 11) fail('RAR 结束长块缺少附加大小字段');
      const blockLength = BigInt(headerSize) + ((flags & LONG_BLOCK) !== 0 ? BigInt(header.readUInt32LE(7)) : 0n);
      if (blockLength > BigInt(buffer.length - offset)) fail('RAR 结束块越过文件边界');
      sawEndMarker = true;
      break;
    }

    let additionalSize = 0n;
    if ((flags & LONG_BLOCK) !== 0) {
      if (headerSize < 11) fail('RAR 长块缺少附加大小字段');
      additionalSize = BigInt(header.readUInt32LE(7));
    }
    const blockLength = BigInt(headerSize) + additionalSize;
    if (blockLength > BigInt(buffer.length - offset)) fail('RAR 扩展块越过文件边界');
    offset += Number(blockLength);
  }
  if (!sawMainHeader) fail('缺少 RAR 主头');
  if (!sawEndMarker) fail('RAR 缺少结束标记，目录可能被截断');
  return { entries, entryCount };
}

function formatSize(value) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function makeArchivePreview(buffer, name, options = {}) {
  if (!/\.rar$/i.test(String(name || ''))) return null;
  if (!Buffer.isBuffer(buffer)) throw new TypeError('archive preview requires a Buffer');
  if (buffer.length > MAX_ARCHIVE_BYTES) throw new Error('RAR 目录预览超过 64 MiB 上限');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('RAR 目录分页参数无效');
  const page = options.page === undefined ? 0 : options.page;
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('RAR 目录页码必须是非负安全整数');
  const signature = findSignature(buffer);
  if (!signature) fail('未找到有效的 RAR 文件标记');
  if (signature.kind === 'rar5') throw new Error('检测到 RAR5；当前只支持 RAR4 目录读取');
  if (signature.kind === 'rar13') throw new Error('检测到 RAR 1.3；当前只支持 RAR4 目录读取');
  if (page > Math.floor(MAX_ENTRIES / PAGE_SIZE)) throw new Error('RAR 目录页码超出安全范围');
  const parsed = parseRar4(buffer, signature.offset, page);
  const pageCount = Math.max(1, Math.ceil(parsed.entryCount / PAGE_SIZE));
  if (page >= pageCount) throw new Error(`RAR 目录页码超出范围（共 ${pageCount} 页）`);
  const start = page * PAGE_SIZE;
  const shown = parsed.entries;
  const lines = shown.map((entry, index) => {
    const kind = entry.kind === 'dir' ? '目录' : '文件';
    const packed = formatSize(entry.packedSize);
    const unpacked = formatSize(entry.unpackedSize);
    const encryption = entry.encrypted ? '加密' : '未加密';
    const encodingNote = entry.nameEncoding === 'ASCII' || entry.nameEncoding === 'RAR4 UTF-8' ||
      entry.nameEncoding === 'RAR4 compressed Unicode' ? '' : ` [名称编码:${entry.nameEncoding}]`;
    return `${String(start + index + 1).padStart(6, ' ')}  ${kind.padEnd(4, ' ')}  ${packed.padStart(12, ' ')} / ${unpacked.padStart(12, ' ')}  ${encryption}  ${entry.path}${encodingNote}`;
  });
  const title = `${String(name ?? 'RAR archive')} · RAR4 只读目录 · ${parsed.entryCount} 个条目 · 第 ${page + 1}/${pageCount} 页`;
  const columns = '    #  类型       压缩大小 / 原始大小       加密状态  路径';
  return {
    kind: 'text',
    text: [columns, ...(lines.length ? lines : ['（空目录）'])].join('\n'),
    info: `${title}；只读取文件头，未解包或执行内容；每页最多 ${PAGE_SIZE} 项。`,
    page,
    pageCount,
    pageSize: PAGE_SIZE,
    entryCount: parsed.entryCount,
  };
}

module.exports = { makeArchivePreview, PAGE_SIZE, MAX_ARCHIVE_BYTES };
