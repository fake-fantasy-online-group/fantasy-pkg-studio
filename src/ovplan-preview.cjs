'use strict';

// Bundled, unchanged inputs to the existing OvRows / OvRepeatRows resource loader.
// The manifest records the format version and row widths of the source snapshot.
const plan = require('./formats/ovplan.json');
const repeats = require('./formats/ovrepeat.json');
const manifest = require('./formats/ovmanifest.json');

const MAX_COLUMNS = 32768;
const TYPES = new Map([
  ['smallint', [1, 'uint8']], ['integer', [2, 'uint16']],
  ['integer_s', [2, 'int16']], ['bigint', [4, 'int32']],
]);

const byFile = new Map();
for (const entry of Object.values(plan)) {
  if (entry && typeof entry.file === 'string' && Array.isArray(entry.cols)) {
    const key = entry.file.toLowerCase();
    if (byFile.has(key)) throw new Error(`重复的 ovplan 文件名：${entry.file}`);
    byFile.set(key, entry);
  }
}

function validRange(offset, size, limit) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(size) &&
    offset >= 0 && size > 0 && offset + size <= limit;
}

function columnField(name, offset, size, type, signed, repeat) {
  const integer = TYPES.get(type);
  if (integer && integer[0] !== size) throw new Error(`列 ${name} 的整数宽度无效`);
  const presentation = integer
    ? (type === 'smallint' && signed ? 'int8' : type === 'integer' && signed ? 'int16' : integer[1])
    : type === 'text' ? 'gbk' : 'hex';
  return {
    name,
    description: type === 'bytea' ? '列计划保留的未解释原始字节' : '资源加载器列计划',
    offset,
    size,
    presentation,
    ...(repeat ? { repeat } : {}),
  };
}

function redundantTextAlias(column, columns) {
  return column.type === 'text' && columns.some((other) =>
    other !== column && other.type === 'text' && other.off === column.off && other.size > column.size);
}

function mark(covered, offset, size) {
  covered.fill(1, offset, offset + size);
}

function addRepeat(fields, covered, groupName, config, recordSize) {
  const { header, block, count, inner, cols } = config;
  if (!Number.isSafeInteger(header) || header < 0 || !Number.isSafeInteger(block) || block < 1 ||
      !Number.isSafeInteger(count) || count < 1 || header + block * count > recordSize ||
      !Array.isArray(cols)) throw new Error(`重复块 ${groupName} 边界无效`);
  let innerOffset = 0;
  let innerBlock = block;
  let innerCount = 1;
  if (inner) {
    if (!Number.isSafeInteger(inner.off) || inner.off < 0 ||
        !Number.isSafeInteger(inner.block) || inner.block < 1 ||
        !Number.isSafeInteger(inner.count) || inner.count < 1 ||
        inner.off + inner.block * inner.count > block) {
      throw new Error(`重复块 ${groupName} 内层边界无效`);
    }
    innerOffset = inner.off;
    innerBlock = inner.block;
    innerCount = inner.count;
  }
  if (fields.length + count * innerCount * cols.length > MAX_COLUMNS) {
    throw new Error(`重复块 ${groupName} 超过列数上限`);
  }
  for (const col of cols) {
    if (!Array.isArray(col) || col.length !== 4 || typeof col[0] !== 'string' ||
        !validRange(col[1], col[2], innerBlock)) throw new Error(`重复块 ${groupName} 子列无效`);
    columnField(col[0], col[1], col[2], col[3], false);
  }
  for (let index = 0; index < count; index += 1) {
    const outer = header + index * block;
    for (let innerIndex = 0; innerIndex < innerCount; innerIndex += 1) {
      const start = outer + innerOffset + innerIndex * innerBlock;
      const prefix = `${groupName}[${index}]${inner ? `[${innerIndex}]` : ''}`;
      const repeat = { offset: start, size: innerBlock };
      for (const [name, offset, size, type] of cols) {
        fields.push(columnField(`${prefix}.${name}`, start + offset, size, type, false, repeat));
        mark(covered, start + offset, size);
      }
    }
  }
}

function plannedFields(filename, recordSize) {
  const file = filename.replace(/\\/g, '/').split('/').pop().replace(/\.bin$/i, '');
  const entry = byFile.get(file.toLowerCase());
  if (!entry) return null;
  const expectedSize = manifest.recordSizes?.[entry.file];
  if (manifest.formatVersion !== 1 || manifest.tableVersion !== 1 ||
      !Number.isSafeInteger(expectedSize) || expectedSize !== recordSize) {
    return { status: 'invalid', message: `内置列计划版本或记录长度不符（期望 ${expectedSize || '未知'} 字节）` };
  }
  try {
    const fields = [];
    const covered = new Uint8Array(recordSize);
    let omittedAliases = 0;
    for (const col of entry.cols) {
      if (!col || typeof col.name !== 'string' || !validRange(col.off, col.size, recordSize)) {
        throw new Error('父表列越过记录边界');
      }
      if (redundantTextAlias(col, entry.cols)) {
        omittedAliases += 1;
        continue;
      }
      fields.push(columnField(col.name, col.off, col.size, col.type, col.signed === true));
      mark(covered, col.off, col.size);
    }
    let repeatGroups = 0;
    for (const [groupName, config] of Object.entries(repeats)) {
      const source = typeof config.src === 'string' ? config.src : groupName;
      if (source.toLowerCase() !== entry.file.toLowerCase()) continue;
      addRepeat(fields, covered, groupName, config, recordSize);
      repeatGroups += 1;
    }
    let unknownBytes = 0;
    for (let offset = 0; offset < recordSize;) {
      if (covered[offset]) { offset += 1; continue; }
      const start = offset;
      while (offset < recordSize && !covered[offset]) offset += 1;
      const size = offset - start;
      unknownBytes += size;
      fields.push(columnField(`unknown +0x${start.toString(16)}`, start, size, 'bytea', false));
    }
    if (fields.length > MAX_COLUMNS) throw new Error('列数超过预览上限');
    const byteaFields = fields.filter((field) => field.presentation === 'hex').length;
    return {
      status: 'loader',
      fields,
      message: `内置资源加载器列计划；${repeatGroups} 组重复块；${byteaFields} 个原始字节字段（其中 ${unknownBytes} 字节未列定义）；省略 ${omittedAliases} 个同起点短文本别名`,
      structName: entry.file,
    };
  } catch (error) {
    return { status: 'invalid', message: `内置列计划无效：${error?.message || String(error)}` };
  }
}

module.exports = { plannedFields };
