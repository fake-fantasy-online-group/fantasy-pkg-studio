'use strict';

const { plannedFields } = require('./ovplan-preview.cjs');

const MAX_DATA_BYTES = 64 * 1024 * 1024;
const MAX_SCHEMA_BYTES = 8 * 1024 * 1024;
const MAX_SCHEMA_RECORDS = 32768;
const RAW_CHUNK_BYTES = 16;
const COLUMN_PAGE_SIZE = 64;
const MAX_ROWS_PER_PAGE = 50;
const MAX_CELLS_PER_PAGE = 3200;
const MAX_STRING_BYTES = 4096;
const ARRAY_ELEMENTS_PER_COLUMN = 64;
const STRUCT_HEADER_BYTES = 120;
const FIELD_BYTES = 152;
const FIELD_TAIL_BYTES = 32;
const DESCRIPTOR_BIAS = 112;
const INTEGER_TYPES = new Map([
  [2, ['int8', 1]], [3, ['uint8', 1]],
  [4, ['int16', 2]], [5, ['uint16', 2]],
  [6, ['int32', 4]], [7, ['uint32', 4]],
]);
const gbkDecoder = new TextDecoder('gbk', { fatal: true });
const gbkDescriptionDecoder = new TextDecoder('gbk');

function invalidHeader(message) {
  const error = new Error(message);
  error.code = 'TABLE_HEADER_INVALID';
  throw error;
}

function safeLabel(value, fallback = '') {
  return typeof value === 'string' ? value.slice(0, 240) : fallback;
}

function schemaResult(status, source, message, structName = '') {
  return { status, source: safeLabel(source), message: safeLabel(message), structName: safeLabel(structName) };
}

function rawHex(bytes) {
  return bytes.toString('hex').replace(/(..)(?=.)/g, '$1 ');
}

function fieldPresentation(field) {
  if (field.presentation) return field.presentation;
  const integer = INTEGER_TYPES.get(field.typeCode);
  if (integer && field.typeCode === field.storageCode && field.elem === integer[1] &&
      field.count > 0 && field.size === field.count * field.elem) {
    return field.count === 1 ? integer[0] : `${integer[0]}[]`;
  }
  if (field.typeCode === 18 && field.storageCode === 18 && field.elem === 1 &&
      field.count === field.size && field.size > 0 && field.size <= MAX_STRING_BYTES) return 'gbk';
  return 'hex';
}

function fieldColumnCount(field) {
  const presentation = fieldPresentation(field);
  if (presentation === 'hex') return Math.ceil(field.size / RAW_CHUNK_BYTES);
  if (presentation.endsWith('[]')) return Math.ceil(field.count / ARRAY_ELEMENTS_PER_COLUMN);
  return 1;
}

function visibleColumns(fields, recordSize, firstColumn, count) {
  if (!fields) {
    const columns = [];
    const total = Math.ceil(recordSize / RAW_CHUNK_BYTES);
    for (let index = firstColumn; index < Math.min(total, firstColumn + count); index += 1) {
      const offset = index * RAW_CHUNK_BYTES;
      const size = Math.min(RAW_CHUNK_BYTES, recordSize - offset);
      columns.push({
        key: `raw:${offset}`,
        name: `+0x${offset.toString(16).padStart(4, '0')}`,
        description: '未解释的原始记录字节',
        offset,
        size,
        type: 'hex',
      });
    }
    return columns;
  }

  const columns = [];
  let position = 0;
  const endColumn = firstColumn + count;
  for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
    const field = fields[fieldIndex];
    const presentation = fieldPresentation(field);
    const columnCount = fieldColumnCount(field);
    const end = position + columnCount;
    if (end > firstColumn && position < endColumn) {
      const from = Math.max(0, firstColumn - position);
      const to = Math.min(columnCount, endColumn - position);
      if (presentation.endsWith('[]')) {
        for (let part = from; part < to; part += 1) {
          const firstElement = part * ARRAY_ELEMENTS_PER_COLUMN;
          const elementCount = Math.min(ARRAY_ELEMENTS_PER_COLUMN, field.count - firstElement);
          columns.push({
            key: `field:${fieldIndex}:${field.offset}:array:${firstElement}`,
            name: `${field.name} [${firstElement}–${firstElement + elementCount - 1}]`,
            description: field.description,
            offset: field.offset + firstElement * field.elem,
            size: elementCount * field.elem,
            type: presentation,
            decode: presentation,
            repeat: field.repeat,
          });
        }
      } else if (presentation !== 'hex') {
        columns.push({
          key: `field:${fieldIndex}:${field.offset}`,
          name: field.name,
          description: field.description,
          offset: field.offset,
          size: field.size,
          type: presentation,
          decode: presentation,
          repeat: field.repeat,
        });
      } else {
        for (let part = from; part < to; part += 1) {
          const relative = part * RAW_CHUNK_BYTES;
          const offset = field.offset + relative;
          columns.push({
            key: `field:${fieldIndex}:${field.offset}:raw:${relative}`,
            name: `${field.name} +0x${relative.toString(16).padStart(4, '0')}`,
            description: `${field.description || field.name}（未解释原始字节）`,
            offset,
            size: Math.min(RAW_CHUNK_BYTES, field.offset + field.size - offset),
            type: 'hex',
            repeat: field.repeat,
          });
        }
      }
    }
    position = end;
    if (position >= endColumn) break;
  }
  return columns;
}

function totalFieldColumns(fields, recordSize) {
  if (!fields) return Math.ceil(recordSize / RAW_CHUNK_BYTES);
  return fields.reduce((total, field) => total + fieldColumnCount(field), 0);
}

function decodeDescription(data, offset) {
  const bytes = data.subarray(offset, offset + 32);
  const nul = bytes.indexOf(0);
  // The source truncates a few Chinese descriptions mid-character at 32 bytes.
  return gbkDescriptionDecoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
}

function readSchemaName(data, offset) {
  const bytes = data.subarray(offset, offset + 32);
  const nul = bytes.indexOf(0);
  if (bytes.subarray(0, nul < 0 ? bytes.length : nul).some((byte) => byte > 0x7f)) {
    throw new Error('结构或字段名称不是 ASCII');
  }
  const name = bytes.subarray(0, nul < 0 ? bytes.length : nul).toString('ascii');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(name) ||
      (nul >= 0 && bytes.subarray(nul).some((byte) => byte !== 0))) {
    throw new Error('结构或字段名称无效');
  }
  return name;
}

function parseSchema(data) {
  if (!Buffer.isBuffer(data) || data.length < 80 || data.length > MAX_SCHEMA_BYTES ||
      data.subarray(0, 4).toString('binary') !== 'UDg\0' ||
      data.readUInt32LE(4) !== 0xffffffff || data.readUInt32LE(8) !== data.length) {
    throw new Error('ov_res 结构容器头或长度无效');
  }
  // UDg's header names the 540 descriptor entries. Each entry points 112 bytes
  // before a 120-byte structure header; its fields then occupy 152-byte slots,
  // except that the final field has no 32-byte link to a following field.
  if (data.length < 80) throw new Error('ov_res 容器头不完整');
  const count = data.readUInt32LE(40);
  const repeatedCount = data.readUInt32LE(44);
  if (!count || count !== repeatedCount || count > MAX_SCHEMA_RECORDS) throw new Error('结构目录数量无效');
  const firstStruct = data.readUInt32LE(76) + DESCRIPTOR_BIAS;
  const directory = firstStruct - count * 8;
  if (!Number.isSafeInteger(firstStruct) || directory < 80 ||
      data.readUInt32LE(72) + DESCRIPTOR_BIAS !== directory || firstStruct > data.length) {
    throw new Error('结构目录边界无效');
  }
  const byPointer = new Map();
  const structures = [];
  let expectedStart = firstStruct;
  let totalFields = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = directory + index * 8;
    const pointer = data.readUInt32LE(entry);
    const length = data.readUInt32LE(entry + 4);
    const start = pointer + DESCRIPTOR_BIAS;
    if (start !== expectedStart || start + STRUCT_HEADER_BYTES > data.length ||
        length < STRUCT_HEADER_BYTES || start + length > data.length) throw new Error('结构记录边界无效');
    const recordSize = data.readUInt32LE(start + 24);
    const fieldCount = data.readUInt32LE(start + 36);
    totalFields += fieldCount;
    if (data.readUInt32LE(start + 4) !== index || data.readUInt32LE(start + 28) !== pointer ||
        totalFields > MAX_SCHEMA_RECORDS || length !== STRUCT_HEADER_BYTES +
        fieldCount * FIELD_BYTES - FIELD_TAIL_BYTES) throw new Error('结构记录长度或索引无效');
    const name = readSchemaName(data, start + 56);
    const fields = [];
    let offset = 0;
    for (let fieldIndex = 0; fieldIndex < fieldCount; fieldIndex += 1) {
      const fieldStart = start + STRUCT_HEADER_BYTES + fieldIndex * FIELD_BYTES;
      const fieldName = readSchemaName(data, fieldStart + 56);
      const fieldSize = data.readUInt32LE(fieldStart) * data.readUInt32LE(fieldStart + 4);
      if (!Number.isSafeInteger(fieldSize) || offset + fieldSize > recordSize) throw new Error('字段长度越过结构边界');
      const field = {
        name: fieldName,
        description: decodeDescription(data, fieldStart + 88),
        offset,
        size: fieldSize,
        count: data.readUInt32LE(fieldStart),
        elem: data.readUInt32LE(fieldStart + 4),
        typeCode: data.readUInt32LE(fieldStart + 16),
        storageCode: data.readUInt32LE(fieldStart + 20),
      };
      if (fieldIndex + 1 < fieldCount) {
        field.linkPointer = data.readInt32LE(fieldStart + 124);
        if (data.readUInt32LE(fieldStart + 144) !==
            data.readUInt32LE(fieldStart + FIELD_BYTES) * data.readUInt32LE(fieldStart + FIELD_BYTES + 4) ||
            data.readUInt32LE(fieldStart + 148) !== offset + fieldSize) {
          throw new Error('字段链的长度或偏移无效');
        }
      }
      fields.push(field);
      offset += fieldSize;
    }
    if (offset !== recordSize) throw new Error('字段长度与结构长度不符');
    const structure = { name, recordSize, fields, pointer };
    structures.push(structure);
    byPointer.set(pointer, structure);
    expectedStart = start + length;
  }
  if (expectedStart !== data.length) throw new Error('结构目录未覆盖整个容器');
  return { structures, byPointer };
}

function matchSchema(schema, tableName, recordSize) {
  const base = tableName.replace(/\\/g, '/').split('/').pop().replace(/\.bin$/i, '').replace(/^ov_/i, '');
  const normalizedBase = base.toLowerCase().replace(/_/g, '');
  const matches = [];
  for (const tab of schema.structures) {
    if (!tab.name.endsWith('Tab') || tab.fields.length !== 2) continue;
    const tabBase = tab.name.slice(0, -3).toLowerCase();
    const normalizedTab = tabBase.startsWith('res') ? tabBase.slice(3) : tabBase;
    if (normalizedBase !== tabBase && normalizedBase !== normalizedTab) continue;
    const [countField, arrayField] = tab.fields;
    const row = schema.byPointer.get(countField.linkPointer);
    if (!row || row.recordSize !== recordSize || arrayField.count !== 0 ||
        arrayField.elem !== row.recordSize || arrayField.typeCode !== 1 ||
        arrayField.storageCode !== 1 || countField.size !== 4 ||
        countField.typeCode !== 6 || tab.recordSize !== 4) continue;
    matches.push(row);
  }
  if (matches.length !== 1) return null;
  const row = matches[0];
  return { structName: row.name, fields: row.fields };
}

function decodeCell(data, rowOffset, column) {
  if (column.repeat) {
    const blockOffset = rowOffset + column.repeat.offset;
    const block = data.subarray(blockOffset, blockOffset + column.repeat.size);
    if (block.every((byte) => byte === 0)) return '';
  }
  const offset = rowOffset + column.offset;
  const bytes = data.subarray(offset, offset + column.size);
  const decode = column.decode;
  if (decode?.endsWith('[]')) {
    const elementType = decode.slice(0, -2);
    const width = elementType.endsWith('8') ? 1 : elementType.endsWith('16') ? 2 : 4;
    const values = [];
    for (let at = 0; at < bytes.length; at += width) {
      values.push(readInteger(bytes, at, elementType));
    }
    return `[${values.join(', ')}]`;
  }
  if (/^(?:u?int)(?:8|16|32)$/.test(decode || '')) return String(readInteger(bytes, 0, decode));
  switch (decode) {
    case 'gbk': {
      const nul = bytes.indexOf(0);
      try {
        return gbkDecoder.decode(nul < 0 ? bytes : bytes.subarray(0, nul));
      } catch (_) {
        return `hex: ${rawHex(bytes)}`;
      }
    }
    default: return rawHex(bytes);
  }
}

function readInteger(bytes, offset, type) {
  switch (type) {
    case 'int8': return bytes.readInt8(offset);
    case 'uint8': return bytes.readUInt8(offset);
    case 'int16': return bytes.readInt16LE(offset);
    case 'uint16': return bytes.readUInt16LE(offset);
    case 'int32': return bytes.readInt32LE(offset);
    case 'uint32': return bytes.readUInt32LE(offset);
    default: throw new Error('未知整数类型');
  }
}

function makeTablePreview(buffer, name, options = {}) {
  if (!Buffer.isBuffer(buffer) || !/\.bin$/i.test(String(name || '')) || buffer.length < 4 || buffer.readUInt32LE(0) !== 0x5566) return null;
  if (buffer.length > MAX_DATA_BYTES) throw new Error('二进制表超过 64 MiB 预览上限');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('表格预览选项无效');

  const page = options.page === undefined ? 0 : options.page;
  const columnPage = options.columnPage === undefined ? 0 : options.columnPage;
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('表格页码必须是非负安全整数');
  if (!Number.isSafeInteger(columnPage) || columnPage < 0) throw new Error('表格列页码必须是非负安全整数');

  let schema = schemaResult('missing', options.schemaSource, '未提供表结构；显示未解释的原始定长记录');
  if (buffer.length < 16) invalidHeader('0x5566 表文件头不完整');
  const version = buffer.readUInt32LE(4);
  const recordSize = buffer.readUInt32LE(8);
  const rowCount = buffer.readUInt32LE(12);
  if (version !== 1) invalidHeader(`不支持表格式版本 ${version}（仅支持版本 1）`);
  if (recordSize === 0 || recordSize > MAX_DATA_BYTES) invalidHeader('表记录长度无效或超过 64 MiB 上限');
  const dataLength = recordSize * rowCount;
  if (!Number.isSafeInteger(dataLength) || 16 + dataLength !== buffer.length) invalidHeader('表头记录长度与文件实际长度不符');

  let fields = null;
  const planned = plannedFields(String(name), recordSize);
  if (planned) {
    if (planned.status === 'loader') fields = planned.fields;
    schema = schemaResult(planned.status, '内置 ovplan.json / ovrepeat.json', planned.message, planned.structName);
  } else if (typeof options.schemaError === 'string' && options.schemaError) {
    schema = schemaResult('invalid', options.schemaSource, `表结构读取失败：${options.schemaError}`);
  } else if (options.schemaBuffer !== null && options.schemaBuffer !== undefined) {
    const schemaBuffer = options.schemaBuffer;
    if (!Buffer.isBuffer(schemaBuffer) || schemaBuffer.length > MAX_SCHEMA_BYTES) {
      schema = schemaResult('invalid', options.schemaSource, '表结构无效或超过 8 MiB 解析上限');
    } else if (schemaBuffer.length < 12 || schemaBuffer.subarray(0, 4).toString('binary') !== 'UDg\0' ||
        schemaBuffer.readUInt32LE(4) !== 0xffffffff || schemaBuffer.readUInt32LE(8) !== schemaBuffer.length) {
      schema = schemaResult('invalid', options.schemaSource, 'ov_res 表结构容器头无效');
    } else {
      try {
        const matched = matchSchema(parseSchema(schemaBuffer), String(name), recordSize);
        if (matched) {
          fields = matched.fields;
          schema = schemaResult('matched', options.schemaSource, '按结构目录、Tab 容器引用和记录长度匹配字段定义', matched.structName);
        } else {
          schema = schemaResult('unmatched', options.schemaSource, '没有同名且由 Tab 容器指向的相同记录长度结构，保留原始记录视图');
        }
      } catch (error) {
        fields = null;
        schema = schemaResult('invalid', options.schemaSource, `表结构字段无法严格解码：${error?.message || String(error)}`);
      }
    }
  }

  const totalColumnCount = totalFieldColumns(fields, recordSize);
  const columnPageCount = Math.max(1, Math.ceil(totalColumnCount / COLUMN_PAGE_SIZE));
  if (columnPage >= columnPageCount) throw new Error(`表格列页超出范围（共 ${columnPageCount} 页）`);
  const columns = visibleColumns(fields, recordSize, columnPage * COLUMN_PAGE_SIZE, COLUMN_PAGE_SIZE);
  const boundedColumns = Math.min(COLUMN_PAGE_SIZE, totalColumnCount);
  const rowsPerPage = Math.min(MAX_ROWS_PER_PAGE, Math.max(1, Math.floor(MAX_CELLS_PER_PAGE / Math.max(1, boundedColumns))));
  const pageCount = Math.max(1, Math.ceil(rowCount / rowsPerPage));
  if (page >= pageCount) throw new Error(`表格页超出范围（共 ${pageCount} 页）`);

  const firstRow = page * rowsPerPage;
  const endRow = Math.min(rowCount, firstRow + rowsPerPage);
  const rows = [];
  for (let index = firstRow; index < endRow; index += 1) {
    const rowOffset = 16 + index * recordSize;
    rows.push({ index, cells: columns.map((column) => decodeCell(buffer, rowOffset, column)) });
  }
  const info = `0x5566 定长表；版本 1；${rowCount} 条记录 × ${recordSize} 字节；当前记录 ${rowCount ? `${firstRow + 1}–${endRow}` : '空表'}；当前列 ${totalColumnCount ? `${columnPage * COLUMN_PAGE_SIZE + 1}–${Math.min(totalColumnCount, (columnPage + 1) * COLUMN_PAGE_SIZE)}` : '无'} / ${totalColumnCount} 列。未知或未匹配字段按原始字节显示。`;

  return {
    kind: 'table',
    page,
    pageCount,
    rowCount,
    recordSize,
    rowsPerPage,
    columnPage,
    columnPageCount,
    totalColumnCount,
    columnPageSize: COLUMN_PAGE_SIZE,
    schema,
    columns: columns.map(({ decode, repeat, ...column }) => column),
    rows,
    info,
  };
}

module.exports = { makeTablePreview, parseSchema };
